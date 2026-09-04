package command

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	ErrAlreadyExists     = errors.New("resource already exists")
	ErrSecretNotFound    = errors.New("credential Secret not found")
	ErrSecretUIDMismatch = errors.New("credential Secret UID precondition failed")
)

type KubernetesAPIError struct {
	StatusCode int
}

type SecretMetadata struct {
	UID         string            `json:"uid"`
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
}

func (e *KubernetesAPIError) Error() string {
	return fmt.Sprintf("Kubernetes rejected UID-fenced object request with status %d", e.StatusCode)
}

type Runner interface {
	Run(ctx context.Context, name string, args []string, dryRun bool, timeout time.Duration) (string, error)
	RunInput(ctx context.Context, name string, args []string, input []byte, dryRun bool, timeout time.Duration) (string, error)
	RunCreateInput(ctx context.Context, name string, args []string, input []byte, timeout time.Duration) (string, error)
	RunCreateInputUID(ctx context.Context, name string, args []string, input []byte, timeout time.Duration) (string, string, error)
	RunSensitiveOutput(ctx context.Context, name string, args []string, timeout time.Duration) (string, []byte, error)
	GetSecretMetadata(ctx context.Context, namespace, secretName string, timeout time.Duration) (string, *SecretMetadata, error)
	VerifySecretUID(ctx context.Context, namespace, secretName, uid string, timeout time.Duration) (string, error)
	DeleteSecretUID(ctx context.Context, namespace, secretName, uid string, timeout time.Duration) (string, error)
	DeleteObjectUID(ctx context.Context, resource, namespace, name, uid string, timeout time.Duration) (string, error)
}

// StreamingRunner transfers recovery payloads through subprocess pipes without
// retaining the artifact in memory. It is intentionally separate from Runner so
// existing resource-reconcile fakes do not gain an unused method.
type StreamingRunner interface {
	RunStream(context.Context, string, []string, io.Reader, io.Writer, time.Duration) (string, error)
}

type OSRunner struct {
	KubernetesAPIURL        string
	ServiceAccountTokenFile string
	ServiceAccountCAFile    string
	HTTPClient              *http.Client
	httpClientOnce          sync.Once
	defaultHTTPClient       *http.Client
	httpClientErr           error
}

func (*OSRunner) Run(ctx context.Context, name string, args []string, dryRun bool, timeout time.Duration) (string, error) {
	return run(ctx, name, args, nil, dryRun, timeout)
}

func (*OSRunner) RunInput(ctx context.Context, name string, args []string, input []byte, dryRun bool, timeout time.Duration) (string, error) {
	return run(ctx, name, args, input, dryRun, timeout)
}

func (*OSRunner) RunCreateInput(ctx context.Context, name string, args []string, input []byte, timeout time.Duration) (string, error) {
	return runCreateInput(ctx, name, args, input, timeout)
}

func (*OSRunner) RunCreateInputUID(ctx context.Context, name string, args []string, input []byte, timeout time.Duration) (string, string, error) {
	return runCreateInputUID(ctx, name, args, input, timeout)
}

func (*OSRunner) RunSensitiveOutput(ctx context.Context, name string, args []string, timeout time.Duration) (string, []byte, error) {
	return runSensitiveOutput(ctx, name, args, timeout)
}

func (*OSRunner) RunStream(ctx context.Context, name string, args []string, input io.Reader, output io.Writer, timeout time.Duration) (string, error) {
	printable := name + " " + strings.Join(args, " ")
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	commandContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(commandContext, name, args...)
	cmd.Stdin, cmd.Stdout = input, output
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return printable, fmt.Errorf("%s failed: %w (sensitive command output withheld)", printable, err)
	}
	return printable, nil
}

func (r *OSRunner) GetSecretMetadata(ctx context.Context, namespace, secretName string, timeout time.Duration) (string, *SecretMetadata, error) {
	commandLine := "kubernetes-api patch metadata secret/" + secretName + " --namespace " + namespace + " --dry-run=server"
	apiPath, err := namespacedResourceAPIPath("secret", strings.TrimSpace(namespace), strings.TrimSpace(secretName))
	if err != nil {
		return commandLine, nil, err
	}
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	apiURL, err := r.kubernetesAPIURL()
	if err != nil {
		return commandLine, nil, err
	}
	token, err := r.serviceAccountToken()
	if err != nil {
		return commandLine, nil, err
	}
	endpoint, err := url.Parse(strings.TrimRight(apiURL, "/") + apiPath)
	if err != nil {
		return commandLine, nil, fmt.Errorf("create Kubernetes Secret metadata endpoint: %w", err)
	}
	query := endpoint.Query()
	query.Set("dryRun", "All")
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPatch, endpoint.String(), bytes.NewReader([]byte("[]")))
	if err != nil {
		return commandLine, nil, fmt.Errorf("create Kubernetes Secret metadata request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1")
	request.Header.Set("Content-Type", "application/json-patch+json")
	client, err := r.kubernetesHTTPClient()
	if err != nil {
		return commandLine, nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return commandLine, nil, fmt.Errorf("execute Kubernetes Secret metadata request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return commandLine, nil, ErrSecretNotFound
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return commandLine, nil, &KubernetesAPIError{StatusCode: response.StatusCode}
	}
	var partial struct {
		APIVersion string          `json:"apiVersion"`
		Kind       string          `json:"kind"`
		Metadata   json.RawMessage `json:"metadata"`
	}
	const maxMetadataResponseBytes = 64 << 10
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, maxMetadataResponseBytes+1))
	if readErr != nil || len(payload) > maxMetadataResponseBytes {
		return commandLine, nil, errors.New("Kubernetes API returned an invalid-sized metadata-only Secret representation")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&partial); err != nil {
		return commandLine, nil, errors.New("Kubernetes API did not return a valid metadata-only Secret representation")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return commandLine, nil, errors.New("Kubernetes API returned trailing content after the metadata-only Secret representation")
	}
	if partial.APIVersion != "meta.k8s.io/v1" || partial.Kind != "PartialObjectMetadata" {
		return commandLine, nil, errors.New("Kubernetes API did not honor the metadata-only Secret representation")
	}
	var metadata SecretMetadata
	if len(partial.Metadata) == 0 || json.Unmarshal(partial.Metadata, &metadata) != nil {
		return commandLine, nil, errors.New("Kubernetes API returned invalid metadata in its metadata-only Secret representation")
	}
	metadata.UID = strings.TrimSpace(metadata.UID)
	if !ValidKubernetesUID(metadata.UID) || metadata.Name != strings.TrimSpace(secretName) || metadata.Namespace != strings.TrimSpace(namespace) {
		return commandLine, nil, errors.New("Kubernetes Secret metadata identity is invalid")
	}
	return commandLine, &metadata, nil
}

func (r *OSRunner) VerifySecretUID(ctx context.Context, namespace, secretName, uid string, timeout time.Duration) (string, error) {
	return r.runSecretUIDRequest(ctx, namespace, secretName, uid, true, timeout)
}

func (r *OSRunner) DeleteSecretUID(ctx context.Context, namespace, secretName, uid string, timeout time.Duration) (string, error) {
	return r.runSecretUIDRequest(ctx, namespace, secretName, uid, false, timeout)
}

func (r *OSRunner) DeleteObjectUID(ctx context.Context, resource, namespace, name, uid string, timeout time.Duration) (string, error) {
	return r.runObjectUIDRequest(ctx, resource, namespace, name, uid, false, timeout)
}

func run(ctx context.Context, name string, args []string, input []byte, dryRun bool, timeout time.Duration) (string, error) {
	printable, _, err := execute(ctx, name, args, input, dryRun, timeout, input != nil)
	return printable, err
}

func runSensitiveOutput(ctx context.Context, name string, args []string, timeout time.Duration) (string, []byte, error) {
	return execute(ctx, name, args, nil, false, timeout, true)
}

func runCreateInput(ctx context.Context, name string, args []string, input []byte, timeout time.Duration) (string, error) {
	printable := name + " " + strings.Join(args, " ")
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	commandContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(commandContext, name, args...)
	cmd.Stdin = bytes.NewReader(input)
	output, err := cmd.CombinedOutput()
	if err == nil {
		return printable, nil
	}
	if bytes.Contains(output, []byte("Error from server (AlreadyExists):")) {
		return printable, fmt.Errorf("%s: %w", printable, ErrAlreadyExists)
	}
	return printable, fmt.Errorf("%s failed: %w (sensitive command output withheld)", printable, err)
}

var kubernetesUIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func runCreateInputUID(ctx context.Context, name string, args []string, input []byte, timeout time.Duration) (string, string, error) {
	printable := name + " " + strings.Join(args, " ")
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	commandContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(commandContext, name, args...)
	cmd.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if bytes.Contains(stderr.Bytes(), []byte("Error from server (AlreadyExists):")) {
			return printable, "", fmt.Errorf("%s: %w", printable, ErrAlreadyExists)
		}
		return printable, "", fmt.Errorf("%s failed: %w (sensitive command output withheld)", printable, err)
	}
	uid := strings.TrimSpace(stdout.String())
	if !ValidKubernetesUID(uid) {
		return printable, "", fmt.Errorf("%s returned an invalid Kubernetes object UID (sensitive command output withheld)", printable)
	}
	return printable, uid, nil
}

func ValidKubernetesUID(uid string) bool {
	return kubernetesUIDPattern.MatchString(strings.TrimSpace(uid))
}

type deleteOptions struct {
	APIVersion        string              `json:"apiVersion"`
	Kind              string              `json:"kind"`
	DryRun            []string            `json:"dryRun,omitempty"`
	Preconditions     deletePreconditions `json:"preconditions"`
	PropagationPolicy string              `json:"propagationPolicy"`
}

type deletePreconditions struct {
	UID string `json:"uid"`
}

func (r *OSRunner) runSecretUIDRequest(ctx context.Context, namespace, secretName, uid string, dryRun bool, timeout time.Duration) (string, error) {
	return r.runObjectUIDRequest(ctx, "secret", namespace, secretName, uid, dryRun, timeout)
}

func (r *OSRunner) runObjectUIDRequest(ctx context.Context, resource, namespace, objectName, uid string, dryRun bool, timeout time.Duration) (string, error) {
	resource = strings.TrimSpace(resource)
	namespace = strings.TrimSpace(namespace)
	objectName = strings.TrimSpace(objectName)
	uid = strings.TrimSpace(uid)
	apiPath, err := namespacedResourceAPIPath(resource, namespace, objectName)
	commandLine := "kubernetes-api delete " + resource + "/" + objectName + " --namespace " + namespace + " --uid-precondition"
	if dryRun {
		commandLine += " --dry-run=server"
	}
	if err != nil || !ValidKubernetesUID(uid) {
		return commandLine, errors.New("UID-fenced Kubernetes request requires an allowed resource, namespace, name, and valid object UID")
	}
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	apiURL, err := r.kubernetesAPIURL()
	if err != nil {
		return commandLine, err
	}
	trimmedToken, err := r.serviceAccountToken()
	if err != nil {
		return commandLine, err
	}
	propagationPolicy := "Foreground"
	if resource == "secret" {
		// The provider Secret admission policy reserves connection Secret updates
		// to the provisioner. Foreground deletion would require the garbage
		// collector to update its finalizer and would therefore deadlock.
		propagationPolicy = "Background"
	}
	options := deleteOptions{
		APIVersion:        "v1",
		Kind:              "DeleteOptions",
		Preconditions:     deletePreconditions{UID: uid},
		PropagationPolicy: propagationPolicy,
	}
	if dryRun {
		options.DryRun = []string{"All"}
	}
	payload, err := json.Marshal(options)
	if err != nil {
		return commandLine, fmt.Errorf("encode Kubernetes DeleteOptions: %w", err)
	}
	endpoint := strings.TrimRight(apiURL, "/") + apiPath
	request, err := http.NewRequestWithContext(requestContext, http.MethodDelete, endpoint, bytes.NewReader(payload))
	if err != nil {
		return commandLine, fmt.Errorf("create UID-fenced Kubernetes request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+trimmedToken)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	client, err := r.kubernetesHTTPClient()
	if err != nil {
		return commandLine, err
	}
	response, err := client.Do(request)
	if err != nil {
		return commandLine, fmt.Errorf("execute UID-fenced Kubernetes request: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	if response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices {
		return commandLine, nil
	}
	if !dryRun && response.StatusCode == http.StatusNotFound {
		return commandLine, nil
	}
	if response.StatusCode == http.StatusNotFound {
		return commandLine, ErrSecretNotFound
	}
	if response.StatusCode == http.StatusConflict {
		return commandLine, ErrSecretUIDMismatch
	}
	return commandLine, &KubernetesAPIError{StatusCode: response.StatusCode}
}

func namespacedResourceAPIPath(resource, namespace, name string) (string, error) {
	if namespace == "" || name == "" {
		return "", errors.New("namespace and object name are required")
	}
	var prefix, plural string
	switch resource {
	case "secret":
		prefix, plural = "/api/v1", "secrets"
	case "service":
		prefix, plural = "/api/v1", "services"
	case "persistentvolumeclaim":
		prefix, plural = "/api/v1", "persistentvolumeclaims"
	case "statefulset":
		prefix, plural = "/apis/apps/v1", "statefulsets"
	case "networkpolicy":
		prefix, plural = "/apis/networking.k8s.io/v1", "networkpolicies"
	case "job":
		prefix, plural = "/apis/batch/v1", "jobs"
	default:
		return "", fmt.Errorf("resource %q is not allowed for UID-fenced deletion", resource)
	}
	return prefix + "/namespaces/" + url.PathEscape(namespace) + "/" + plural + "/" + url.PathEscape(name), nil
}

func (r *OSRunner) serviceAccountToken() (string, error) {
	tokenFile := strings.TrimSpace(r.ServiceAccountTokenFile)
	if tokenFile == "" {
		tokenFile = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	}
	token, err := os.ReadFile(tokenFile)
	if err != nil {
		return "", fmt.Errorf("read Kubernetes service account token: %w", err)
	}
	trimmedToken := strings.TrimSpace(string(token))
	if trimmedToken == "" {
		return "", errors.New("Kubernetes service account token is empty")
	}
	return trimmedToken, nil
}

func (r *OSRunner) kubernetesAPIURL() (string, error) {
	if configured := strings.TrimSpace(r.KubernetesAPIURL); configured != "" {
		parsed, err := url.Parse(configured)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
			return "", errors.New("configured Kubernetes API URL is invalid")
		}
		if parsed.Scheme == "http" && !isLoopbackHost(parsed.Hostname()) {
			return "", errors.New("configured Kubernetes API URL must use HTTPS outside loopback tests")
		}
		return strings.TrimRight(configured, "/"), nil
	}
	host := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_HOST"))
	port := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_PORT"))
	if host == "" {
		return "", errors.New("KUBERNETES_SERVICE_HOST is required for UID-fenced Secret operations")
	}
	if port == "" {
		port = "443"
	}
	return "https://" + net.JoinHostPort(host, port), nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(strings.TrimSpace(host), "localhost") {
		return true
	}
	ip := net.ParseIP(strings.TrimSpace(host))
	return ip != nil && ip.IsLoopback()
}

func (r *OSRunner) kubernetesHTTPClient() (*http.Client, error) {
	if r.HTTPClient != nil {
		return r.HTTPClient, nil
	}
	r.httpClientOnce.Do(func() {
		caFile := strings.TrimSpace(r.ServiceAccountCAFile)
		if caFile == "" {
			caFile = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
		}
		certificate, err := os.ReadFile(caFile)
		if err != nil {
			r.httpClientErr = fmt.Errorf("read Kubernetes service account CA: %w", err)
			return
		}
		rootCAs := x509.NewCertPool()
		if !rootCAs.AppendCertsFromPEM(certificate) {
			r.httpClientErr = errors.New("Kubernetes service account CA is invalid")
			return
		}
		r.defaultHTTPClient = &http.Client{Transport: &http.Transport{
			TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: rootCAs},
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          16,
			MaxIdleConnsPerHost:   4,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: time.Second,
		}}
	})
	return r.defaultHTTPClient, r.httpClientErr
}

func execute(ctx context.Context, name string, args []string, input []byte, dryRun bool, timeout time.Duration, redactOutput bool) (string, []byte, error) {
	printable := name + " " + strings.Join(args, " ")
	if dryRun {
		return printable, nil, nil
	}
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	commandContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(commandContext, name, args...)
	if input != nil {
		cmd.Stdin = bytes.NewReader(input)
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		if redactOutput {
			return printable, nil, fmt.Errorf("%s failed: %w (sensitive command output withheld)", printable, err)
		}
		return printable, nil, fmt.Errorf("%s failed: %w: %s", printable, err, strings.TrimSpace(string(output)))
	}
	return printable, output, nil
}
