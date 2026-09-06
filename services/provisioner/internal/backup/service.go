package backup

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go/logging"
)

type Options struct {
	TLSConfig         *tls.Config
	MaxStoredBytes    int64
	MaxPlaintextBytes int64
	Now               func() time.Time
}

type Service struct {
	client    *s3.Client
	bundle    Bundle
	bucket    string
	maxStored int64
	maxPlain  int64
	now       func() time.Time
	transport *http.Transport
}

func NewService(config OperatorConfig, bundle Bundle, options Options) (*Service, error) {
	if !config.enabled || bundle.current == "" || bundle.access == "" || bundle.secret == "" {
		return nil, ErrConfig
	}
	stored, plain := options.MaxStoredBytes, options.MaxPlaintextBytes
	if stored == 0 {
		stored = MaxStoredBytes
	}
	if plain == 0 {
		plain = MaxStoredBytes
	}
	if stored < 1 || stored > MaxStoredBytes || plain < 1 || plain > MaxStoredBytes {
		return nil, ErrConfig
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if options.TLSConfig != nil {
		tlsConfig = options.TLSConfig.Clone()
		if tlsConfig.InsecureSkipVerify {
			return nil, ErrConfig
		}
		tlsConfig.MinVersion = max(tlsConfig.MinVersion, tls.VersionTLS12)
	}
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext, TLSClientConfig: tlsConfig, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 30 * time.Second, IdleConnTimeout: 30 * time.Second, MaxIdleConns: 4, MaxIdleConnsPerHost: 4, MaxConnsPerHost: 4, DisableCompression: true}
	// Every call has an operation context deadline. A second Client.Timeout on a
	// wrapped transport creates legacy per-request cancellation goroutines.
	httpClient := &http.Client{Transport: controlTransport{base: transport}, CheckRedirect: func(*http.Request, []*http.Request) error { return ErrBackend }}
	client := s3.New(s3.Options{Region: "us-east-1", BaseEndpoint: aws.String(config.endpoint), UsePathStyle: true, Credentials: credentials.NewStaticCredentialsProvider(bundle.access, bundle.secret, bundle.token), HTTPClient: httpClient, RetryMaxAttempts: 1, Logger: logging.Nop{}, RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired, ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired})
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Service{client: client, bundle: bundle, bucket: config.bucket, maxStored: stored, maxPlain: plain, now: now, transport: transport}, nil
}

func (s *Service) Close() { s.transport.CloseIdleConnections() }

func (s *Service) CurrentKeyVersion() string { return s.bundle.current }

func (s *Service) operation(ctx context.Context, a Attempt) (context.Context, context.CancelFunc, error) {
	if _, err := NewAttempt(a.spec); err != nil {
		return nil, nil, err
	}
	if a.spec.FirstClaimAt.After(s.now()) {
		return nil, nil, ErrIdentity
	}
	bounded, cancel := context.WithDeadline(ctx, a.Deadline())
	if err := bounded.Err(); err != nil {
		cancel()
		return nil, nil, err
	}
	return bounded, cancel, nil
}

type controlTransport struct{ base http.RoundTripper }

func (t controlTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	// Only a successful object GET may stream beyond the small XML/control bound.
	if req.Method != http.MethodGet || req.URL.Query().Has("uploads") || req.URL.Query().Has("uploadId") || req.URL.Query().Has("versions") || response.StatusCode != http.StatusOK {
		// Control XML is bounded, never an archive. Check Close here because SDK
		// deserializers do not propagate response-body Close failures.
		body, readErr := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
		closeErr := response.Body.Close()
		if len(body) > 1<<20 {
			return nil, ErrLimit
		}
		if err := errors.Join(readErr, closeErr); err != nil {
			return nil, safeError(err)
		}
		response.Body = io.NopCloser(bytes.NewReader(body))
	}
	return response, nil
}

type discardSink struct{ io.Writer }

func (discardSink) Close() error { return nil }

func (s *Service) Verify(ctx context.Context, candidate Candidate) (VerifiedArtifact, error) {
	a, err := NewAttempt(candidate.record.Attempt)
	if err != nil {
		return VerifiedArtifact{}, err
	}
	opCtx, cancel, err := s.operation(ctx, a)
	if err != nil {
		return VerifiedArtifact{}, err
	}
	defer cancel()
	return s.Readback(opCtx, candidate, discardSink{Writer: io.Discard})
}

// Readback owns sink and closes it on success, error and cancellation. The sink
// MUST be isolated/unpublished and its Close must unblock Write. Successful Close
// is not publication: only the returned VerifiedArtifact permits a store fence.
func (s *Service) Readback(ctx context.Context, candidate Candidate, sink io.WriteCloser) (verified VerifiedArtifact, resultErr error) {
	if sink == nil {
		return verified, ErrConfig
	}
	if _, err := ParseCandidate(candidate.record); err != nil {
		return verified, errors.Join(err, safeError(sink.Close()))
	}
	a, err := NewAttempt(candidate.record.Attempt)
	if err != nil {
		return verified, errors.Join(err, safeError(sink.Close()))
	}
	// Retained artifacts may be restored after their upload deadline. The bridge
	// MUST supply the persisted restore deadline on every retry; missing budgets
	// fail closed instead of silently creating a fresh 30-minute operation.
	deadline, bounded := ctx.Deadline()
	if !bounded || deadline.After(s.now().Add(MaxDuration)) {
		return verified, errors.Join(ErrConfig, safeError(sink.Close()))
	}
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	owned := own(readCtx, sink)
	defer func() {
		resultErr = errors.Join(resultErr, owned.finish())
		if resultErr != nil {
			verified = VerifiedArtifact{}
		}
	}()
	response, err := s.client.GetObject(readCtx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(a.ObjectKey())})
	if err != nil {
		return verified, safeError(err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, safeError(response.Body.Close()))
		if resultErr != nil {
			verified = VerifiedArtifact{}
		}
	}()
	if response.ContentLength == nil || *response.ContentLength != candidate.record.StoredBytes {
		return verified, ErrIntegrity
	}
	if err := s.decrypt(readCtx, candidate, response.Body, sink); err != nil {
		return verified, err
	}
	return VerifiedArtifact{record: candidate.record}, nil
}
