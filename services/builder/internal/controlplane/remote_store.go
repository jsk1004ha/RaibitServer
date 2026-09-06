package controlplane

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	dispatchRequestLimitBytes   = 1 << 20
	dispatchResponseLimitBytes  = 4 << 20
	defaultDispatchTimeout      = 30 * time.Second
	defaultDispatchLeaseSeconds = 300
)

type RemoteStoreConfig struct {
	BaseURL               string
	CAFile                string
	ClientCertificateFile string
	ClientKeyFile         string
	Timeout               time.Duration
}

type RemoteStore struct {
	baseURL string
	client  *http.Client
	mu      sync.RWMutex
	token   string
	lease   WorkflowLease
}

type dispatchRPCRequest struct {
	Operation        string                             `json:"operation"`
	ClaimOptions     *ClaimOptions                      `json:"claimOptions,omitempty"`
	Lease            *WorkflowLease                     `json:"lease,omitempty"`
	ProjectID        string                             `json:"projectId,omitempty"`
	ServiceID        string                             `json:"serviceId,omitempty"`
	DeploymentID     string                             `json:"deploymentId,omitempty"`
	Updates          map[string]any                     `json:"updates,omitempty"`
	Result           map[string]any                     `json:"result,omitempty"`
	Failure          string                             `json:"failure,omitempty"`
	Now              time.Time                          `json:"now,omitempty"`
	BuildStart       *BuildStartInput                   `json:"buildStart,omitempty"`
	Publication      *ImagePublicationInput             `json:"publication,omitempty"`
	BuildLog         *BuildLogInput                     `json:"buildLog,omitempty"`
	DeploymentEvent  *DeploymentEventInput              `json:"deploymentEvent,omitempty"`
	GitHubCredential *GitHubRepositoryCredentialRequest `json:"githubCredential,omitempty"`
	CloneSucceeded   bool                               `json:"cloneSucceeded,omitempty"`
}

type dispatchRPCResponse struct {
	Token            string                      `json:"token,omitempty"`
	Job              *WorkflowJob                `json:"job,omitempty"`
	Project          *Project                    `json:"project,omitempty"`
	Service          *Service                    `json:"service,omitempty"`
	Deployment       *Deployment                 `json:"deployment,omitempty"`
	GitHubCredential *GitHubRepositoryCredential `json:"githubCredential,omitempty"`
	Error            *dispatchRPCError           `json:"error,omitempty"`
}

type dispatchRPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type dispatchSession struct {
	Lease             WorkflowLease
	ProjectID         string
	ServiceID         string
	DeploymentID      string
	ClientFingerprint [sha256.Size]byte
	ExpiresAt         time.Time
	GitHub            *githubCredentialSession
}

type GitHubRepositoryCredentialRequest struct {
	ServiceID      string `json:"serviceId"`
	InstallationID string `json:"installationId"`
	RepositoryID   string `json:"repositoryId"`
}

type leaseFencedMutationStore interface {
	updateDeploymentForLease(context.Context, WorkflowLease, string, map[string]any) (*Deployment, error)
	updateServiceForLease(context.Context, WorkflowLease, string, map[string]any) (*Service, error)
	appendBuildLogForLease(context.Context, WorkflowLease, BuildLogInput) error
	appendDeploymentEventForLease(context.Context, WorkflowLease, DeploymentEventInput) error
}

var (
	_ leaseFencedMutationStore = (*PostgresStore)(nil)
	_ leaseFencedMutationStore = (*FileStore)(nil)
)

type dispatchHandler struct {
	store             Store
	sessionTTL        time.Duration
	mu                sync.Mutex
	sessions          map[[sha256.Size]byte]dispatchSession
	githubCredentials GitHubCredentialIssuer
}

func NewRemoteStore(config RemoteStoreConfig) (*RemoteStore, error) {
	baseURL, err := validateDispatchBaseURL(config.BaseURL)
	if err != nil {
		return nil, err
	}
	for _, required := range [][2]string{
		{"dispatcher CA file", config.CAFile},
		{"dispatcher client certificate", config.ClientCertificateFile},
		{"dispatcher client key", config.ClientKeyFile},
	} {
		if strings.TrimSpace(required[1]) == "" {
			return nil, fmt.Errorf("%s is required", required[0])
		}
	}
	caPEM, err := os.ReadFile(config.CAFile)
	if err != nil {
		return nil, fmt.Errorf("read dispatcher CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("dispatcher CA file contains no valid certificates")
	}
	certificate, err := tls.LoadX509KeyPair(config.ClientCertificateFile, config.ClientKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load dispatcher client certificate: %w", err)
	}
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = defaultDispatchTimeout
	}
	client := &http.Client{
		Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			MinVersion:   tls.VersionTLS13,
			RootCAs:      roots,
			Certificates: []tls.Certificate{certificate},
		}},
	}
	return &RemoteStore{baseURL: baseURL, client: client}, nil
}

func NewDispatcherTLSConfig(clientCAFile, serverCertificateFile, serverKeyFile string) (*tls.Config, error) {
	for _, required := range [][2]string{
		{"dispatcher client CA file", clientCAFile},
		{"dispatcher server certificate", serverCertificateFile},
		{"dispatcher server key", serverKeyFile},
	} {
		if strings.TrimSpace(required[1]) == "" {
			return nil, fmt.Errorf("%s is required", required[0])
		}
	}
	clientCAPEM, err := os.ReadFile(clientCAFile)
	if err != nil {
		return nil, fmt.Errorf("read dispatcher client CA: %w", err)
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(clientCAPEM) {
		return nil, errors.New("dispatcher client CA file contains no valid certificates")
	}
	certificate, err := tls.LoadX509KeyPair(serverCertificateFile, serverKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load dispatcher server certificate: %w", err)
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{certificate},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCAs,
	}, nil
}

func NewDispatchHandler(store Store, sessionTTL time.Duration) http.Handler {
	return NewDispatchHandlerWithGitHubCredentials(store, sessionTTL, nil)
}

func NewDispatchHandlerWithGitHubCredentials(store Store, sessionTTL time.Duration, issuer GitHubCredentialIssuer) http.Handler {
	if sessionTTL <= 0 {
		sessionTTL = 15 * time.Minute
	}
	return &dispatchHandler{store: store, sessionTTL: sessionTTL, sessions: map[[sha256.Size]byte]dispatchSession{}, githubCredentials: issuer}
}

func (h *dispatchHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/v1/rpc" {
		http.NotFound(response, request)
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeDispatchError(response, http.StatusMethodNotAllowed, "method_not_allowed", "dispatcher RPC requires POST")
		return
	}
	clientFingerprint, verified := verifiedClientFingerprint(request)
	if !verified {
		writeDispatchError(response, http.StatusUnauthorized, "mutual_tls_required", "dispatcher RPC requires a verified mutual TLS client")
		return
	}
	if contentType := strings.ToLower(strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0])); contentType != "application/json" {
		writeDispatchError(response, http.StatusUnsupportedMediaType, "unsupported_media_type", "dispatcher RPC requires application/json")
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, dispatchRequestLimitBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var rpcRequest dispatchRPCRequest
	if err := decoder.Decode(&rpcRequest); err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "request body too large") {
			status = http.StatusRequestEntityTooLarge
		}
		writeDispatchError(response, status, "invalid_request", "invalid dispatcher RPC request")
		return
	}
	if err := ensureJSONEOF(decoder); err != nil {
		writeDispatchError(response, http.StatusBadRequest, "invalid_request", "dispatcher RPC accepts one JSON object")
		return
	}

	if rpcRequest.Operation == "claim" {
		h.handleClaim(response, request, rpcRequest, clientFingerprint)
		return
	}
	token, ok := bearerToken(request.Header.Get("Authorization"))
	if !ok {
		writeDispatchError(response, http.StatusUnauthorized, "unauthorized", "dispatcher session authentication is required")
		return
	}
	session, ok := h.session(token, time.Now().UTC())
	if rpcRequest.Operation == "releaseGitHubCredential" {
		session, ok = h.releaseSession(token)
	}
	if !ok {
		writeDispatchError(response, http.StatusUnauthorized, "unauthorized", "dispatcher session is invalid or expired")
		return
	}
	if session.ClientFingerprint != clientFingerprint {
		writeDispatchError(response, http.StatusUnauthorized, "unauthorized", "dispatcher session is not valid for this mutual TLS client")
		return
	}
	h.handleScoped(response, request, token, session, rpcRequest)
}

func (h *dispatchHandler) handleClaim(response http.ResponseWriter, request *http.Request, rpcRequest dispatchRPCRequest, clientFingerprint [sha256.Size]byte) {
	if h.store == nil {
		writeDispatchError(response, http.StatusServiceUnavailable, "store_unavailable", "dispatcher store is unavailable")
		return
	}
	if rpcRequest.ClaimOptions == nil {
		writeDispatchError(response, http.StatusBadRequest, "invalid_request", "claim options are required")
		return
	}
	claimOptions := *rpcRequest.ClaimOptions
	claimOptions.WorkerID = strings.TrimSpace(claimOptions.WorkerID)
	if claimOptions.WorkerID == "" || len(claimOptions.WorkerID) > 128 {
		writeDispatchError(response, http.StatusBadRequest, "invalid_request", "claim worker identity must be between 1 and 128 bytes")
		return
	}
	claimOptions.LeaseSeconds = defaultDispatchLeaseSeconds
	claimOptions.Now = time.Now().UTC()
	job, err := h.store.ClaimNextWorkflowJob(request.Context(), claimOptions)
	if err != nil {
		writeDispatchStoreError(response, err)
		return
	}
	if job == nil {
		writeDispatchJSON(response, http.StatusOK, dispatchRPCResponse{})
		return
	}
	session, err := h.resolveSession(request.Context(), job)
	if err != nil {
		_ = h.store.FailWorkflowJob(request.Context(), job.Lease(), err)
		writeDispatchStoreError(response, err)
		return
	}
	session.ClientFingerprint = clientFingerprint
	token, err := newDispatchToken()
	if err != nil {
		_ = h.store.FailWorkflowJob(request.Context(), job.Lease(), err)
		writeDispatchStoreError(response, err)
		return
	}
	h.mu.Lock()
	h.pruneExpiredLocked(time.Now().UTC())
	h.sessions[sha256.Sum256([]byte(token))] = session
	h.mu.Unlock()
	writeDispatchJSON(response, http.StatusOK, dispatchRPCResponse{Token: token, Job: job})
}

func (h *dispatchHandler) resolveSession(ctx context.Context, job *WorkflowJob) (dispatchSession, error) {
	if job == nil || job.ID == "" || job.LockedBy == "" || job.Attempts <= 0 {
		return dispatchSession{}, errors.New("claimed workflow job has no valid lease identity")
	}
	payloadDeploymentID := dispatchString(job.Payload["deploymentId"])
	targetDeploymentID := ""
	if strings.EqualFold(strings.TrimSpace(job.TargetType), "deployment") {
		targetDeploymentID = strings.TrimSpace(job.TargetID)
	}
	if payloadDeploymentID != "" && targetDeploymentID != "" && payloadDeploymentID != targetDeploymentID {
		return dispatchSession{}, errors.New("claimed workflow job has inconsistent deployment targets")
	}
	deploymentID := payloadDeploymentID
	if deploymentID == "" {
		deploymentID = targetDeploymentID
	}
	if deploymentID == "" {
		return dispatchSession{}, errors.New("claimed workflow job has no deployment target")
	}
	deployment, err := h.store.GetDeployment(ctx, deploymentID)
	if err != nil {
		return dispatchSession{}, err
	}
	service, err := h.store.GetService(ctx, deployment.ServiceID)
	if err != nil {
		return dispatchSession{}, err
	}
	project, err := h.store.GetProject(ctx, deployment.ProjectID)
	if err != nil {
		return dispatchSession{}, err
	}
	if deployment.ServiceID == "" || deployment.ProjectID == "" || service.ProjectID != deployment.ProjectID || project.ID != deployment.ProjectID {
		return dispatchSession{}, errors.New("claimed build target ownership is inconsistent")
	}
	if payloadServiceID := dispatchString(job.Payload["serviceId"]); payloadServiceID != "" && payloadServiceID != service.ID {
		return dispatchSession{}, errors.New("claimed workflow job has an inconsistent service target")
	}
	if payloadProjectID := dispatchString(job.Payload["projectId"]); payloadProjectID != "" && payloadProjectID != project.ID {
		return dispatchSession{}, errors.New("claimed workflow job has an inconsistent project target")
	}
	return dispatchSession{
		Lease:        job.Lease(),
		ProjectID:    project.ID,
		ServiceID:    service.ID,
		DeploymentID: deployment.ID,
		GitHub: &githubCredentialSession{private: strings.EqualFold(service.GitHubRepositoryVisibility, "private"), accessAllowed: service.SourceAccess == "github-app-private", binding: githubCredentialBinding{
			Lease: job.Lease(), OrganizationID: project.OrganizationID, ProjectID: project.ID, ServiceID: service.ID, DeploymentID: deployment.ID,
			IntegrationID: service.GitHubIntegrationID, InstallationID: service.GitHubInstallationID, RepositoryID: service.GitHubRepositoryID, Repository: strings.ToLower(service.GitHubRepository),
		}},
		ExpiresAt: time.Now().UTC().Add(h.sessionTTL),
	}, nil
}

func (h *dispatchHandler) handleScoped(response http.ResponseWriter, request *http.Request, token string, session dispatchSession, rpcRequest dispatchRPCRequest) {
	ctx := request.Context()
	var result dispatchRPCResponse
	var err error
	removeSession := false
	switch rpcRequest.Operation {
	case "getProject":
		if rpcRequest.ProjectID != session.ProjectID {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "dispatcher session is not authorized for that project")
			return
		}
		result.Project, err = h.store.GetProject(ctx, rpcRequest.ProjectID)
	case "getService":
		if rpcRequest.ServiceID != session.ServiceID {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "dispatcher session is not authorized for that service")
			return
		}
		result.Service, err = h.store.GetService(ctx, rpcRequest.ServiceID)
	case "getDeployment":
		if rpcRequest.DeploymentID != session.DeploymentID {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "dispatcher session is not authorized for that deployment")
			return
		}
		result.Deployment, err = h.store.GetDeployment(ctx, rpcRequest.DeploymentID)
	case "issueGitHubCredential":
		result.GitHubCredential, err = h.issueGitHubCredential(ctx, session, rpcRequest.GitHubCredential)
	case "releaseGitHubCredential":
		err = h.releaseGitHubCredential(ctx, session.GitHub, rpcRequest.CloneSucceeded)
	case "checkGitHubCredential":
		err = h.checkGitHubCredential(ctx, session.GitHub)
	case "updateDeployment":
		if rpcRequest.DeploymentID != session.DeploymentID {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "dispatcher session is not authorized for that deployment")
			return
		}
		updates := map[string]any(nil)
		if isAllowedBuildFailureUpdate(rpcRequest.Updates) {
			updates = map[string]any{
				"status":          ErrorCodeBuildFailed,
				"buildFinishedAt": time.Now().UTC().Format(time.RFC3339Nano),
				"errorCode":       ErrorCodeBuildFailed,
				"errorMessage":    rpcRequest.Updates["errorMessage"],
			}
		} else if commit, requested, commitErr := normalizedDeploymentCommitUpdate(rpcRequest.Updates); requested && commitErr == nil {
			updates = map[string]any{"commitSha": commit, "commitHash": commit}
		} else {
			writeDispatchError(response, http.StatusForbidden, "mutation_not_allowed", "dispatcher sessions may only record a terminal build failure or checked-out source commit")
			return
		}
		mutationStore, ok := h.store.(leaseFencedMutationStore)
		if !ok {
			writeDispatchError(response, http.StatusServiceUnavailable, "lease_fencing_unavailable", "dispatcher store does not support atomic lease-fenced mutations")
			return
		}
		result.Deployment, err = mutationStore.updateDeploymentForLease(ctx, session.Lease, rpcRequest.DeploymentID, updates)
	case "updateService":
		if rpcRequest.ServiceID != session.ServiceID {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "dispatcher session is not authorized for that service")
			return
		}
		if !isAllowedRepositoryRedaction(rpcRequest.Updates) {
			writeDispatchError(response, http.StatusForbidden, "mutation_not_allowed", "dispatcher sessions may only redact a credentialed repository URL")
			return
		}
		mutationStore, ok := h.store.(leaseFencedMutationStore)
		if !ok {
			writeDispatchError(response, http.StatusServiceUnavailable, "lease_fencing_unavailable", "dispatcher store does not support atomic lease-fenced mutations")
			return
		}
		result.Service, err = mutationStore.updateServiceForLease(ctx, session.Lease, rpcRequest.ServiceID, rpcRequest.Updates)
	case "startBuild":
		if rpcRequest.BuildStart == nil || !session.matchesBuildStart(*rpcRequest.BuildStart) {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "build start does not match the claimed session")
			return
		}
		buildStart := *rpcRequest.BuildStart
		buildStart.StartedAt = time.Now().UTC()
		err = h.store.StartBuild(ctx, buildStart)
	case "publishImageReady":
		if !session.GitHub.publicationAllowed() {
			err = errGitHubCredentialLifecycle
			break
		}
		if rpcRequest.Publication == nil || !session.matchesPublication(*rpcRequest.Publication) {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "image publication does not match the claimed session")
			return
		}
		publication := *rpcRequest.Publication
		publication.BuildFinishedAt = time.Now().UTC()
		err = h.store.PublishImageReady(ctx, publication)
		removeSession = err == nil
	case "appendBuildLog":
		if rpcRequest.BuildLog == nil || rpcRequest.BuildLog.DeploymentID != session.DeploymentID {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "build log does not match the claimed session")
			return
		}
		mutationStore, ok := h.store.(leaseFencedMutationStore)
		if !ok {
			writeDispatchError(response, http.StatusServiceUnavailable, "lease_fencing_unavailable", "dispatcher store does not support atomic lease-fenced mutations")
			return
		}
		err = mutationStore.appendBuildLogForLease(ctx, session.Lease, *rpcRequest.BuildLog)
	case "appendDeploymentEvent":
		if rpcRequest.DeploymentEvent == nil || rpcRequest.DeploymentEvent.DeploymentID != session.DeploymentID {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "deployment event does not match the claimed session")
			return
		}
		mutationStore, ok := h.store.(leaseFencedMutationStore)
		if !ok {
			writeDispatchError(response, http.StatusServiceUnavailable, "lease_fencing_unavailable", "dispatcher store does not support atomic lease-fenced mutations")
			return
		}
		err = mutationStore.appendDeploymentEventForLease(ctx, session.Lease, *rpcRequest.DeploymentEvent)
	case "renewLease":
		if rpcRequest.Lease == nil || *rpcRequest.Lease != session.Lease {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "lease renewal does not match the claimed session")
			return
		}
		err = h.store.RenewWorkflowJobLease(ctx, session.Lease, time.Now().UTC())
		if err == nil {
			h.extendSession(token, time.Now().UTC())
		}
	case "complete":
		if !session.GitHub.publicationAllowed() {
			err = errGitHubCredentialLifecycle
			break
		}
		if rpcRequest.Lease == nil || *rpcRequest.Lease != session.Lease {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "completion does not match the claimed session")
			return
		}
		err = h.store.CompleteWorkflowJob(ctx, session.Lease, rpcRequest.Result)
		removeSession = err == nil
	case "fail":
		if rpcRequest.Lease == nil || *rpcRequest.Lease != session.Lease {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "failure does not match the claimed session")
			return
		}
		err = errors.Join(h.abortGitHubCredential(ctx, session.GitHub), h.store.FailWorkflowJob(ctx, session.Lease, errors.New(rpcRequest.Failure)))
		removeSession = err == nil
	case "cancel":
		if rpcRequest.Lease == nil || *rpcRequest.Lease != session.Lease {
			writeDispatchError(response, http.StatusForbidden, "scope_mismatch", "cancellation does not match the claimed session")
			return
		}
		err = errors.Join(h.abortGitHubCredential(ctx, session.GitHub), h.store.CancelWorkflowJob(ctx, session.Lease, errors.New(rpcRequest.Failure)))
		removeSession = err == nil
	default:
		writeDispatchError(response, http.StatusBadRequest, "unsupported_operation", "unsupported dispatcher RPC operation")
		return
	}
	if err != nil {
		if errors.Is(err, errGitHubCredentialScope) || errors.Is(err, errGitHubCredentialLifecycle) {
			writeDispatchError(response, http.StatusForbidden, "github_credential_denied", "GitHub clone credential scope or lifecycle denied")
			return
		}
		if errors.Is(err, ErrWorkflowLeaseLost) {
			err = errors.Join(err, h.deleteSession(ctx, token))
		}
		writeDispatchStoreError(response, err)
		return
	}
	if removeSession {
		if err := h.deleteSession(ctx, token); err != nil {
			writeDispatchStoreError(response, err)
			return
		}
	}
	writeDispatchJSON(response, http.StatusOK, result)
}

func (s dispatchSession) matchesBuildStart(input BuildStartInput) bool {
	return input.Lease == s.Lease && input.DeploymentID == s.DeploymentID && input.ServiceID == s.ServiceID && input.ProjectID == s.ProjectID
}

func (s dispatchSession) matchesPublication(input ImagePublicationInput) bool {
	return input.Lease == s.Lease && input.DeploymentID == s.DeploymentID && input.ServiceID == s.ServiceID && input.ProjectID == s.ProjectID
}

func isAllowedBuildFailureUpdate(updates map[string]any) bool {
	if len(updates) != 4 {
		return false
	}
	status, statusOK := updates["status"].(string)
	errorCode, errorCodeOK := updates["errorCode"].(string)
	finishedAt, finishedAtOK := updates["buildFinishedAt"].(string)
	errorMessage, errorMessageOK := updates["errorMessage"].(string)
	if !statusOK || strings.TrimSpace(status) != ErrorCodeBuildFailed || !errorCodeOK || strings.TrimSpace(errorCode) != ErrorCodeBuildFailed ||
		!finishedAtOK || strings.TrimSpace(finishedAt) == "" || !errorMessageOK || strings.TrimSpace(errorMessage) == "" {
		return false
	}
	for key := range updates {
		switch key {
		case "status", "buildFinishedAt", "errorCode", "errorMessage":
		default:
			return false
		}
	}
	return true
}

func isAllowedRepositoryRedaction(updates map[string]any) bool {
	if len(updates) != 1 {
		return false
	}
	repositoryURL, ok := updates["repoUrl"].(string)
	if !ok || strings.TrimSpace(repositoryURL) == "" {
		return false
	}
	redacted := strings.ToLower(repositoryURL)
	return strings.Contains(redacted, "redacted") || strings.Contains(repositoryURL, "****")
}

func (h *dispatchHandler) session(token string, now time.Time) (dispatchSession, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.pruneExpiredLocked(now)
	session, ok := h.sessions[sha256.Sum256([]byte(token))]
	return session, ok && session.ExpiresAt.After(now)
}

func (h *dispatchHandler) extendSession(token string, now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	key := sha256.Sum256([]byte(token))
	session, ok := h.sessions[key]
	if !ok {
		return
	}
	session.ExpiresAt = now.Add(h.sessionTTL)
	h.sessions[key] = session
}

func (h *dispatchHandler) deleteSession(ctx context.Context, token string) error {
	session, ok := h.releaseSession(token)
	var cleanupErr error
	if ok {
		cleanupErr = h.abortGitHubCredential(ctx, session.GitHub)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.sessions, sha256.Sum256([]byte(token)))
	return cleanupErr
}

func (h *dispatchHandler) pruneExpiredLocked(now time.Time) {
	for tokenHash, session := range h.sessions {
		retention := session.ExpiresAt
		if session.GitHub != nil && session.GitHub.private {
			retention = retention.Add(time.Hour)
		}
		if !retention.After(now) {
			delete(h.sessions, tokenHash)
		}
	}
}

func (s *RemoteStore) ClaimNextWorkflowJob(ctx context.Context, options ClaimOptions) (*WorkflowJob, error) {
	var response dispatchRPCResponse
	if err := s.rpc(ctx, dispatchRPCRequest{Operation: "claim", ClaimOptions: &options}, false, &response); err != nil {
		return nil, err
	}
	if response.Job == nil {
		return nil, nil
	}
	if response.Token == "" {
		return nil, errors.New("dispatcher claim returned no scoped session token")
	}
	s.mu.Lock()
	s.token = response.Token
	s.lease = response.Job.Lease()
	s.mu.Unlock()
	return response.Job, nil
}

func (s *RemoteStore) CompleteWorkflowJob(ctx context.Context, lease WorkflowLease, result map[string]any) error {
	err := s.rpc(ctx, dispatchRPCRequest{Operation: "complete", Lease: &lease, Result: result}, true, nil)
	if err == nil {
		s.clearToken()
	}
	return err
}

func (s *RemoteStore) FailWorkflowJob(ctx context.Context, lease WorkflowLease, failure error) error {
	err := s.rpc(ctx, dispatchRPCRequest{Operation: "fail", Lease: &lease, Failure: failureMessage(failure)}, true, nil)
	if err == nil {
		s.clearToken()
	}
	return err
}

func (s *RemoteStore) CancelWorkflowJob(ctx context.Context, lease WorkflowLease, reason error) error {
	err := s.rpc(ctx, dispatchRPCRequest{Operation: "cancel", Lease: &lease, Failure: failureMessage(reason)}, true, nil)
	if err == nil {
		s.clearToken()
	}
	return err
}

func (s *RemoteStore) RenewWorkflowJobLease(ctx context.Context, lease WorkflowLease, now time.Time) error {
	return s.rpc(ctx, dispatchRPCRequest{Operation: "renewLease", Lease: &lease, Now: now}, true, nil)
}

func (s *RemoteStore) GetProject(ctx context.Context, projectID string) (*Project, error) {
	var response dispatchRPCResponse
	if err := s.rpc(ctx, dispatchRPCRequest{Operation: "getProject", ProjectID: projectID}, true, &response); err != nil {
		return nil, err
	}
	if response.Project == nil {
		return nil, errors.New("dispatcher returned no project")
	}
	return response.Project, nil
}

func (s *RemoteStore) GetService(ctx context.Context, serviceID string) (*Service, error) {
	var response dispatchRPCResponse
	if err := s.rpc(ctx, dispatchRPCRequest{Operation: "getService", ServiceID: serviceID}, true, &response); err != nil {
		return nil, err
	}
	if response.Service == nil {
		return nil, errors.New("dispatcher returned no service")
	}
	return response.Service, nil
}

func (s *RemoteStore) GetDeployment(ctx context.Context, deploymentID string) (*Deployment, error) {
	var response dispatchRPCResponse
	if err := s.rpc(ctx, dispatchRPCRequest{Operation: "getDeployment", DeploymentID: deploymentID}, true, &response); err != nil {
		return nil, err
	}
	if response.Deployment == nil {
		return nil, errors.New("dispatcher returned no deployment")
	}
	_, err := response.Deployment.BuildSpec()
	return response.Deployment, err
}

func (s *RemoteStore) IssueGitHubRepositoryCredential(ctx context.Context, request GitHubRepositoryCredentialRequest) (*GitHubRepositoryCredential, error) {
	var response dispatchRPCResponse
	if err := s.rpc(ctx, dispatchRPCRequest{Operation: "issueGitHubCredential", GitHubCredential: &request}, true, &response); err != nil {
		return nil, err
	}
	if err := validateIssuedGitHubCredential(response.GitHubCredential, request.InstallationID, request.RepositoryID, time.Now().UTC()); err != nil {
		return nil, err
	}
	return response.GitHubCredential, nil
}

func validateIssuedGitHubCredential(credential *GitHubRepositoryCredential, installationID, repositoryID string, now time.Time) error {
	if credential == nil || strings.TrimSpace(credential.Token) == "" {
		return errors.New("GitHub credential broker returned no credential")
	}
	if credential.InstallationID != strings.TrimSpace(installationID) || credential.RepositoryID != strings.TrimSpace(repositoryID) {
		return errors.New("GitHub credential broker returned a credential for a different repository")
	}
	if !credential.UseDeadline.After(now) || credential.UseDeadline.After(now.Add(15*time.Minute)) || !credential.UpstreamExpiresAt.After(credential.UseDeadline) {
		return errors.New("GitHub credential broker returned an expiry outside the allowed short-lived window")
	}
	return nil
}

func (s *RemoteStore) UpdateDeployment(ctx context.Context, deploymentID string, updates map[string]any) (*Deployment, error) {
	var response dispatchRPCResponse
	if err := s.rpc(ctx, dispatchRPCRequest{Operation: "updateDeployment", DeploymentID: deploymentID, Updates: updates}, true, &response); err != nil {
		return nil, err
	}
	if response.Deployment == nil {
		return nil, errors.New("dispatcher returned no updated deployment")
	}
	_, err := response.Deployment.BuildSpec()
	return response.Deployment, err
}

func (s *RemoteStore) UpdateDeploymentForLease(ctx context.Context, lease WorkflowLease, deploymentID string, updates map[string]any) (*Deployment, error) {
	s.mu.RLock()
	currentLease := s.lease
	s.mu.RUnlock()
	if lease.JobID == "" || lease.WorkerID == "" || lease.Attempt <= 0 || lease != currentLease {
		return nil, ErrWorkflowLeaseLost
	}
	return s.UpdateDeployment(ctx, deploymentID, updates)
}

func (s *RemoteStore) UpdateService(ctx context.Context, serviceID string, updates map[string]any) (*Service, error) {
	var response dispatchRPCResponse
	if err := s.rpc(ctx, dispatchRPCRequest{Operation: "updateService", ServiceID: serviceID, Updates: updates}, true, &response); err != nil {
		return nil, err
	}
	if response.Service == nil {
		return nil, errors.New("dispatcher returned no updated service")
	}
	return response.Service, nil
}

func (s *RemoteStore) StartBuild(ctx context.Context, input BuildStartInput) error {
	return s.rpc(ctx, dispatchRPCRequest{Operation: "startBuild", BuildStart: &input}, true, nil)
}

func (s *RemoteStore) PublishImageReady(ctx context.Context, input ImagePublicationInput) error {
	err := s.rpc(ctx, dispatchRPCRequest{Operation: "publishImageReady", Publication: &input}, true, nil)
	if err == nil {
		s.clearToken()
	}
	return err
}

func (s *RemoteStore) AppendBuildLog(ctx context.Context, input BuildLogInput) error {
	return s.rpc(ctx, dispatchRPCRequest{Operation: "appendBuildLog", BuildLog: &input}, true, nil)
}

func (s *RemoteStore) AppendDeploymentEvent(ctx context.Context, input DeploymentEventInput) error {
	return s.rpc(ctx, dispatchRPCRequest{Operation: "appendDeploymentEvent", DeploymentEvent: &input}, true, nil)
}

func (s *RemoteStore) rpc(ctx context.Context, request dispatchRPCRequest, authenticated bool, output *dispatchRPCResponse) error {
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if len(body) > dispatchRequestLimitBytes {
		return errors.New("dispatcher RPC request exceeds the size limit")
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+"/v1/rpc", bytes.NewReader(body))
	if err != nil {
		return err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	if authenticated {
		token := s.sessionToken()
		if token == "" {
			return errors.New("dispatcher session has not been established")
		}
		httpRequest.Header.Set("Authorization", "Bearer "+token)
	}
	httpResponse, err := s.client.Do(httpRequest)
	if err != nil {
		return fmt.Errorf("dispatcher RPC failed: %w", err)
	}
	defer httpResponse.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(httpResponse.Body, dispatchResponseLimitBytes+1))
	if err != nil {
		return fmt.Errorf("read dispatcher RPC response: %w", err)
	}
	if len(responseBody) > dispatchResponseLimitBytes {
		return errors.New("dispatcher RPC response exceeds the size limit")
	}
	var response dispatchRPCResponse
	if len(responseBody) > 0 {
		if err := json.Unmarshal(responseBody, &response); err != nil {
			return errors.New("dispatcher RPC returned invalid JSON")
		}
	}
	if httpResponse.StatusCode < 200 || httpResponse.StatusCode >= 300 || response.Error != nil {
		return dispatchClientError(httpResponse.StatusCode, response.Error)
	}
	if output != nil {
		*output = response
	}
	return nil
}

func (s *RemoteStore) sessionToken() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.token
}

func (s *RemoteStore) clearToken() {
	s.mu.Lock()
	s.token = ""
	s.lease = WorkflowLease{}
	s.mu.Unlock()
}

func validateDispatchBaseURL(value string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("dispatcher URL must be an https origin without credentials, query parameters, or fragments")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", errors.New("dispatcher URL must not contain a path")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return err
	}
	return errors.New("multiple JSON values")
}

func newDispatchToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate dispatcher session token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func bearerToken(value string) (string, bool) {
	prefix, token, ok := strings.Cut(strings.TrimSpace(value), " ")
	if !ok || !strings.EqualFold(prefix, "Bearer") || strings.TrimSpace(token) == "" || strings.ContainsAny(token, " \t\r\n") {
		return "", false
	}
	return token, true
}

func verifiedClientFingerprint(request *http.Request) ([sha256.Size]byte, bool) {
	if request == nil || request.TLS == nil || len(request.TLS.VerifiedChains) == 0 || len(request.TLS.VerifiedChains[0]) == 0 {
		return [sha256.Size]byte{}, false
	}
	certificate := request.TLS.VerifiedChains[0][0]
	if certificate == nil || len(certificate.Raw) == 0 {
		return [sha256.Size]byte{}, false
	}
	return sha256.Sum256(certificate.Raw), true
}

func dispatchString(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return strings.TrimSpace(fmt.Sprintf("%v", value))
}

func writeDispatchJSON(response http.ResponseWriter, status int, value dispatchRPCResponse) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeDispatchError(response http.ResponseWriter, status int, code, message string) {
	writeDispatchJSON(response, status, dispatchRPCResponse{Error: &dispatchRPCError{Code: code, Message: Redact(message)}})
}

func writeDispatchStoreError(response http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	code := "store_error"
	message := "dispatcher store operation failed"
	switch {
	case errors.Is(err, ErrWorkflowLeaseLost):
		status = http.StatusConflict
		code = "workflow_lease_lost"
		message = "workflow job lease ownership was lost"
	case errors.Is(err, ErrBuildTargetDeleting):
		status = http.StatusConflict
		code = "build_target_deleting"
		message = "build target is deleting"
	}
	writeDispatchError(response, status, code, message)
}

func dispatchClientError(status int, rpcError *dispatchRPCError) error {
	message := "dispatcher RPC request failed"
	code := ""
	if rpcError != nil {
		message = rpcError.Message
		code = rpcError.Code
	}
	switch code {
	case "workflow_lease_lost":
		return fmt.Errorf("%w: %s", ErrWorkflowLeaseLost, message)
	case "build_target_deleting":
		return fmt.Errorf("%w: %s", ErrBuildTargetDeleting, message)
	default:
		return fmt.Errorf("dispatcher RPC status %d: %s", status, message)
	}
}
