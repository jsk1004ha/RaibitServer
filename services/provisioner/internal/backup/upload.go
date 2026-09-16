package backup

import (
	"bytes"
	"context"
	"errors"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

type UploadRequest struct {
	Attempt Attempt
	Source  io.ReadCloser
}

// Upload owns Source; Close MUST unblock Read. Failure after RecordIntent leaves
// cleanup pending. The durable journal, not the returned zero Candidate, retains
// upload IDs/descriptors needed after a process crash or uncertain network result.
func (s *Service) Upload(ctx context.Context, req UploadRequest, journal Journal) (result Candidate, resultErr error) {
	if req.Source == nil {
		return Candidate{}, ErrConfig
	}
	if journal == nil {
		return Candidate{}, errors.Join(ErrConfig, safeError(req.Source.Close()))
	}
	opCtx, cancel, err := s.operation(ctx, req.Attempt)
	if err != nil {
		return Candidate{}, errors.Join(err, safeError(req.Source.Close()))
	}
	defer cancel()
	owned := own(opCtx, req.Source)
	defer func() {
		resultErr = errors.Join(resultErr, owned.finish())
		if resultErr != nil {
			result = Candidate{}
		}
	}()
	if req.Attempt.spec.KeyVersion != s.bundle.current {
		return Candidate{}, ErrConfig
	}
	if err := journal.RecordIntent(opCtx, req.Attempt); err != nil {
		return Candidate{}, ErrFence
	}
	created, err := s.client.CreateMultipartUpload(opCtx, &s3.CreateMultipartUploadInput{Bucket: aws.String(s.bucket), Key: aws.String(req.Attempt.ObjectKey()), ContentType: aws.String("application/octet-stream")})
	if err != nil {
		return Candidate{}, errors.Join(ErrCleanupPending, safeError(err))
	}
	if created.UploadId == nil || !boundedSecret(*created.UploadId, 1024) {
		return Candidate{}, errors.Join(ErrBackend, ErrCleanupPending)
	}
	upload := Upload{Attempt: req.Attempt, UploadID: *created.UploadId}
	if err := journal.RecordUpload(opCtx, upload); err != nil {
		return Candidate{}, errors.Join(ErrFence, ErrCleanupPending)
	}
	writer := &multipartWriter{ctx: opCtx, service: s, upload: upload, journal: journal, buffer: make([]byte, 0, PartBytes)}
	record, encryptErr := s.encrypt(opCtx, req, writer)
	if err := errors.Join(encryptErr, owned.finish()); err != nil {
		return Candidate{}, errors.Join(ErrCleanupPending, err)
	}
	if err := writer.flush(); err != nil {
		return Candidate{}, errors.Join(ErrCleanupPending, err)
	}
	candidate := Candidate{record: record}
	if err := journal.RecordCandidate(opCtx, candidate); err != nil {
		return Candidate{}, errors.Join(ErrCleanupPending, ErrFence)
	}
	if err := journal.Fence(opCtx, req.Attempt); err != nil {
		return Candidate{}, errors.Join(ErrCleanupPending, ErrFence)
	}
	_, err = s.client.CompleteMultipartUpload(opCtx, &s3.CompleteMultipartUploadInput{Bucket: aws.String(s.bucket), Key: aws.String(req.Attempt.ObjectKey()), UploadId: aws.String(upload.UploadID), IfNoneMatch: aws.String("*"), MultipartUpload: &types.CompletedMultipartUpload{Parts: writer.parts}})
	if err != nil {
		var responseErr *smithyhttp.ResponseError
		if errors.As(err, &responseErr) && (responseErr.HTTPStatusCode() < 500 || responseErr.HTTPStatusCode() == 501) {
			return Candidate{}, errors.Join(ErrCleanupPending, ErrBackend)
		}
		// A lost success response is reconciled only by full authenticated readback
		// of the exact persisted descriptor, never HEAD/ETag or another attempt.
		if _, verifyErr := s.Verify(opCtx, candidate); verifyErr != nil {
			return Candidate{}, errors.Join(ErrCleanupPending, safeError(err), verifyErr)
		}
	}
	if err := journal.RecordRemoteCompletion(opCtx, RemoteCompletion{record: record}); err != nil {
		return Candidate{}, errors.Join(ErrCleanupPending, ErrFence)
	}
	if err := journal.Fence(opCtx, req.Attempt); err != nil {
		return Candidate{}, errors.Join(ErrCleanupPending, ErrFence)
	}
	return candidate, nil
}

type multipartWriter struct {
	ctx     context.Context
	service *Service
	upload  Upload
	journal Journal
	buffer  []byte
	parts   []types.CompletedPart
}

func (w *multipartWriter) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		n := min(len(p), PartBytes-len(w.buffer))
		w.buffer = append(w.buffer, p[:n]...)
		p = p[n:]
		written += n
		if len(w.buffer) == PartBytes {
			if err := w.flush(); err != nil {
				return written, err
			}
		}
	}
	return written, nil
}

func (w *multipartWriter) flush() error {
	if len(w.buffer) == 0 {
		return nil
	}
	if err := w.journal.Fence(w.ctx, w.upload.Attempt); err != nil {
		return ErrFence
	}
	if len(w.parts) >= int(MaxStoredBytes/PartBytes)+1 {
		return ErrLimit
	}
	number := int32(len(w.parts) + 1)
	response, err := w.service.client.UploadPart(w.ctx, &s3.UploadPartInput{Bucket: aws.String(w.service.bucket), Key: aws.String(w.upload.Attempt.ObjectKey()), UploadId: aws.String(w.upload.UploadID), PartNumber: aws.Int32(number), Body: bytes.NewReader(w.buffer), ContentLength: aws.Int64(int64(len(w.buffer)))})
	if err != nil {
		return safeError(err)
	}
	if response.ETag == nil || !boundedSecret(*response.ETag, 1024) {
		return ErrBackend
	}
	w.parts = append(w.parts, types.CompletedPart{ETag: response.ETag, PartNumber: aws.Int32(number)})
	w.buffer = w.buffer[:0]
	return nil
}
