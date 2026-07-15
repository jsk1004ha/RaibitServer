package controlplane

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type dispatchFixtureStore struct {
	Store
	job               *WorkflowJob
	deployment        *Deployment
	service           *Service
	project           *Project
	started           bool
	published         bool
	renewed           bool
	completed         bool
	failed            bool
	logCount          int
	eventCount        int
	claimed           ClaimOptions
	renewedAt         time.Time
	claimError        error
	startedAt         time.Time
	publishedAt       time.Time
	deploymentUpdates map[string]any
	serviceUpdates    map[string]any
}

func TestRemoteStoreLeaseFencedUpdateRejectsEmptyLease(t *testing.T) {
	store := &RemoteStore{}
	if _, err := store.UpdateDeploymentForLease(context.Background(), WorkflowLease{}, "deployment-1", map[string]any{
		"status": ErrorCodeBuildFailed,
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("empty lease must fail before any dispatcher request, got %v", err)
	}
}

func (s *dispatchFixtureStore) ClaimNextWorkflowJob(_ context.Context, options ClaimOptions) (*WorkflowJob, error) {
	s.claimed = options
	if s.claimError != nil {
		return nil, s.claimError
	}
	return s.job, nil
}

func (s *dispatchFixtureStore) GetDeployment(_ context.Context, id string) (*Deployment, error) {
	if id != s.deployment.ID {
		return nil, notFound("deployment", id)
	}
	return s.deployment, nil
}

func (s *dispatchFixtureStore) GetService(_ context.Context, id string) (*Service, error) {
	if id != s.service.ID {
		return nil, notFound("service", id)
	}
	return s.service, nil
}

func (s *dispatchFixtureStore) GetProject(_ context.Context, id string) (*Project, error) {
	if id != s.project.ID {
		return nil, notFound("project", id)
	}
	return s.project, nil
}

func (s *dispatchFixtureStore) UpdateDeployment(_ context.Context, id string, updates map[string]any) (*Deployment, error) {
	s.deploymentUpdates = updates
	return s.GetDeployment(context.Background(), id)
}

func (s *dispatchFixtureStore) UpdateDeploymentForLease(ctx context.Context, _ WorkflowLease, id string, updates map[string]any) (*Deployment, error) {
	return s.UpdateDeployment(ctx, id, updates)
}

func (s *dispatchFixtureStore) UpdateService(_ context.Context, id string, _ map[string]any) (*Service, error) {
	return s.GetService(context.Background(), id)
}

func (s *dispatchFixtureStore) updateDeploymentForLease(_ context.Context, lease WorkflowLease, id string, updates map[string]any) (*Deployment, error) {
	if lease != s.job.Lease() || s.job.Status != WorkflowRunning {
		return nil, ErrWorkflowLeaseLost
	}
	s.deploymentUpdates = updates
	return s.GetDeployment(context.Background(), id)
}

func (s *dispatchFixtureStore) updateServiceForLease(_ context.Context, lease WorkflowLease, id string, updates map[string]any) (*Service, error) {
	if lease != s.job.Lease() || s.job.Status != WorkflowRunning {
		return nil, ErrWorkflowLeaseLost
	}
	s.serviceUpdates = updates
	return s.GetService(context.Background(), id)
}

func (s *dispatchFixtureStore) appendBuildLogForLease(ctx context.Context, lease WorkflowLease, input BuildLogInput) error {
	if lease != s.job.Lease() || s.job.Status != WorkflowRunning {
		return ErrWorkflowLeaseLost
	}
	return s.AppendBuildLog(ctx, input)
}

func (s *dispatchFixtureStore) appendDeploymentEventForLease(ctx context.Context, lease WorkflowLease, input DeploymentEventInput) error {
	if lease != s.job.Lease() || s.job.Status != WorkflowRunning {
		return ErrWorkflowLeaseLost
	}
	return s.AppendDeploymentEvent(ctx, input)
}

func (s *dispatchFixtureStore) StartBuild(_ context.Context, input BuildStartInput) error {
	s.started = input.Lease == s.job.Lease() && input.DeploymentID == s.deployment.ID
	s.startedAt = input.StartedAt
	return nil
}

func (s *dispatchFixtureStore) PublishImageReady(_ context.Context, input ImagePublicationInput) error {
	s.published = input.Lease == s.job.Lease() && input.DeploymentID == s.deployment.ID
	s.completed = s.published
	if s.published {
		s.eventCount++
	}
	s.publishedAt = input.BuildFinishedAt
	return nil
}

func (s *dispatchFixtureStore) RenewWorkflowJobLease(_ context.Context, lease WorkflowLease, now time.Time) error {
	s.renewed = lease == s.job.Lease()
	s.renewedAt = now
	return nil
}

func (s *dispatchFixtureStore) AppendBuildLog(_ context.Context, input BuildLogInput) error {
	if input.DeploymentID == s.deployment.ID {
		s.logCount++
	}
	return nil
}

func (s *dispatchFixtureStore) AppendDeploymentEvent(_ context.Context, input DeploymentEventInput) error {
	if input.DeploymentID == s.deployment.ID {
		s.eventCount++
	}
	return nil
}

func (s *dispatchFixtureStore) CompleteWorkflowJob(_ context.Context, lease WorkflowLease, _ map[string]any) error {
	s.completed = lease == s.job.Lease()
	return nil
}

func (s *dispatchFixtureStore) FailWorkflowJob(_ context.Context, lease WorkflowLease, _ error) error {
	s.failed = lease == s.job.Lease()
	return nil
}

func newDispatchFixtureStore() *dispatchFixtureStore {
	return &dispatchFixtureStore{
		job:        &WorkflowJob{ID: "job-1", Type: "deployment.build", Status: WorkflowRunning, TargetType: "deployment", TargetID: "deployment-1", Attempts: 1, LockedBy: "executor-1", Payload: map[string]any{"deploymentId": "deployment-1"}},
		deployment: &Deployment{ID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1"},
		service:    &Service{ID: "service-1", ProjectID: "project-1"},
		project:    &Project{ID: "project-1", OrganizationID: "organization-1"},
	}
}

func sendDispatchRPCRequest(t *testing.T, handler http.Handler, token string, payload map[string]any) *httptest.ResponseRecorder {
	return sendDispatchRPCRequestWithTLS(t, handler, token, payload, verifiedDispatchTLSState())
}

func sendDispatchRPCRequestWithTLS(t *testing.T, handler http.Handler, token string, payload map[string]any, tlsState *tls.ConnectionState) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/rpc", bytes.NewReader(body))
	request.TLS = tlsState
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestDispatchHandlerScopesSessionToClaimedTarget(t *testing.T) {
	handler := NewDispatchHandler(newDispatchFixtureStore(), 15*time.Minute)
	claim := sendDispatchRPCRequest(t, handler, "", map[string]any{"operation": "claim", "claimOptions": map[string]any{"workerId": "executor-1", "leaseSeconds": 300}})
	if claim.Code != http.StatusOK {
		t.Fatalf("claim failed with %d: %s", claim.Code, claim.Body.String())
	}
	var claimed struct {
		Token string       `json:"token"`
		Job   *WorkflowJob `json:"job"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	if claimed.Token == "" || claimed.Job == nil || claimed.Job.ID != "job-1" {
		t.Fatalf("claim response did not establish a scoped session: %+v", claimed)
	}

	project := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{"operation": "getProject", "projectId": "project-1"})
	if project.Code != http.StatusOK {
		t.Fatalf("scoped project lookup failed with %d: %s", project.Code, project.Body.String())
	}
	foreign := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{"operation": "getProject", "projectId": "project-2"})
	if foreign.Code != http.StatusForbidden {
		t.Fatalf("session must not escape the claimed project, got %d: %s", foreign.Code, foreign.Body.String())
	}
	unauthenticated := sendDispatchRPCRequest(t, handler, "", map[string]any{"operation": "getProject", "projectId": "project-1"})
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("dispatcher RPC must reject missing session authentication, got %d", unauthenticated.Code)
	}
}

func TestDispatchHandlerBindsSessionToVerifiedClientCertificate(t *testing.T) {
	handler := NewDispatchHandler(newDispatchFixtureStore(), 15*time.Minute)
	claim := sendDispatchRPCRequestWithTLS(t, handler, "", map[string]any{
		"operation":    "claim",
		"claimOptions": map[string]any{"workerId": "executor-1"},
	}, verifiedDispatchTLSStateFor([]byte("client-certificate-one")))
	if claim.Code != http.StatusOK {
		t.Fatalf("claim failed with %d: %s", claim.Code, claim.Body.String())
	}
	var claimed struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	foreignCertificate := sendDispatchRPCRequestWithTLS(t, handler, claimed.Token, map[string]any{
		"operation": "getProject",
		"projectId": "project-1",
	}, verifiedDispatchTLSStateFor([]byte("client-certificate-two")))
	if foreignCertificate.Code != http.StatusUnauthorized {
		t.Fatalf("session token must not be reusable under another verified client certificate, got %d: %s", foreignCertificate.Code, foreignCertificate.Body.String())
	}
}

func TestDispatchHandlerRejectsInconsistentClaimTarget(t *testing.T) {
	fixture := newDispatchFixtureStore()
	fixture.job.TargetID = "deployment-from-target"
	handler := NewDispatchHandler(fixture, 15*time.Minute)
	claim := sendDispatchRPCRequest(t, handler, "", map[string]any{
		"operation":    "claim",
		"claimOptions": map[string]any{"workerId": "executor-1"},
	})
	if claim.Code != http.StatusInternalServerError {
		t.Fatalf("inconsistent job target must fail closed, got %d: %s", claim.Code, claim.Body.String())
	}
	if !fixture.failed {
		t.Fatal("inconsistent claimed job must be failed through its exact lease")
	}
	if strings.Contains(claim.Body.String(), "deployment-from-target") || strings.Contains(claim.Body.String(), "deployment-1") {
		t.Fatalf("dispatcher exposed inconsistent target identifiers: %s", claim.Body.String())
	}
}

func TestDispatchHandlerRejectsPrivilegeEscalatingRawUpdates(t *testing.T) {
	handler := NewDispatchHandler(newDispatchFixtureStore(), 15*time.Minute)
	claim := sendDispatchRPCRequest(t, handler, "", map[string]any{"operation": "claim", "claimOptions": map[string]any{"workerId": "executor-1", "leaseSeconds": 300}})
	if claim.Code != http.StatusOK {
		t.Fatalf("claim failed with %d: %s", claim.Code, claim.Body.String())
	}
	var claimed struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}

	deploymentEscalation := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{
		"operation":    "updateDeployment",
		"deploymentId": "deployment-1",
		"updates":      map[string]any{"status": "IMAGE_READY", "imageDigest": "sha256:" + strings.Repeat("a", 64)},
	})
	if deploymentEscalation.Code != http.StatusForbidden {
		t.Fatalf("raw deployment updates must not bypass the scan/sign publication transition, got %d: %s", deploymentEscalation.Code, deploymentEscalation.Body.String())
	}

	serviceEscalation := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{
		"operation": "updateService",
		"serviceId": "service-1",
		"updates":   map[string]any{"status": "ready", "imageUrl": "registry.example/forged@sha256:" + strings.Repeat("b", 64)},
	})
	if serviceEscalation.Code != http.StatusForbidden {
		t.Fatalf("raw service updates must not bypass the publication transition, got %d: %s", serviceEscalation.Code, serviceEscalation.Body.String())
	}
}

func TestDispatchHandlerFencesStaleMutationSessionAfterLeaseReclaim(t *testing.T) {
	fixture := newDispatchFixtureStore()
	handler := NewDispatchHandler(fixture, 15*time.Minute)
	claim := sendDispatchRPCRequest(t, handler, "", map[string]any{
		"operation":    "claim",
		"claimOptions": map[string]any{"workerId": "executor-attempt-1"},
	})
	if claim.Code != http.StatusOK {
		t.Fatalf("claim failed with %d: %s", claim.Code, claim.Body.String())
	}
	var claimed struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}

	// Simulate PostgreSQL reclaiming the expired attempt-1 lease for attempt 2
	// while the dispatcher session token remains inside its longer TTL window.
	fixture.job.Attempts = 2
	fixture.job.LockedBy = "executor-attempt-2"
	fixture.job.Status = WorkflowRunning

	staleFailure := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{
		"operation":    "updateDeployment",
		"deploymentId": "deployment-1",
		"updates": map[string]any{
			"status":          ErrorCodeBuildFailed,
			"buildFinishedAt": time.Now().UTC().Format(time.RFC3339Nano),
			"errorCode":       ErrorCodeBuildFailed,
			"errorMessage":    "stale attempt failure",
		},
	})
	if staleFailure.Code != http.StatusConflict {
		t.Fatalf("attempt-1 failure mutation must be fenced after attempt-2 reclaim, got %d: %s", staleFailure.Code, staleFailure.Body.String())
	}
	if fixture.deploymentUpdates != nil {
		t.Fatalf("stale deployment mutation reached the store: %#v", fixture.deploymentUpdates)
	}

	fixture = newDispatchFixtureStore()
	handler = NewDispatchHandler(fixture, 15*time.Minute)
	claim = sendDispatchRPCRequest(t, handler, "", map[string]any{
		"operation":    "claim",
		"claimOptions": map[string]any{"workerId": "executor-attempt-1"},
	})
	if claim.Code != http.StatusOK {
		t.Fatalf("second claim failed with %d: %s", claim.Code, claim.Body.String())
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	fixture.job.Attempts = 2
	fixture.job.LockedBy = "executor-attempt-2"
	fixture.job.Status = WorkflowRunning

	staleRedaction := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{
		"operation": "updateService",
		"serviceId": "service-1",
		"updates":   map[string]any{"repoUrl": "https://redacted@github.com/acme/example.git"},
	})
	if staleRedaction.Code != http.StatusConflict {
		t.Fatalf("attempt-1 repository mutation must be fenced after attempt-2 reclaim, got %d: %s", staleRedaction.Code, staleRedaction.Body.String())
	}
	if fixture.serviceUpdates != nil {
		t.Fatalf("stale service mutation reached the store: %#v", fixture.serviceUpdates)
	}
}

func TestDispatchHandlerFencesStaleAppendMutationsAfterLeaseReclaim(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		payload map[string]any
		mutated func(*dispatchFixtureStore) bool
	}{
		{
			name: "build-log",
			payload: map[string]any{
				"operation": "appendBuildLog",
				"buildLog":  map[string]any{"deploymentId": "deployment-1", "step": "build", "line": "stale attempt log"},
			},
			mutated: func(fixture *dispatchFixtureStore) bool { return fixture.logCount != 0 },
		},
		{
			name: "deployment-event",
			payload: map[string]any{
				"operation":       "appendDeploymentEvent",
				"deploymentEvent": map[string]any{"deploymentId": "deployment-1", "type": "build.failed", "message": "stale attempt event"},
			},
			mutated: func(fixture *dispatchFixtureStore) bool { return fixture.eventCount != 0 },
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newDispatchFixtureStore()
			handler := NewDispatchHandler(fixture, 15*time.Minute)
			claim := sendDispatchRPCRequest(t, handler, "", map[string]any{
				"operation":    "claim",
				"claimOptions": map[string]any{"workerId": "executor-attempt-1"},
			})
			if claim.Code != http.StatusOK {
				t.Fatalf("claim failed with %d: %s", claim.Code, claim.Body.String())
			}
			var claimed struct {
				Token string `json:"token"`
			}
			if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil {
				t.Fatal(err)
			}
			fixture.job.Attempts = 2
			fixture.job.LockedBy = "executor-attempt-2"
			fixture.job.Status = WorkflowRunning

			response := sendDispatchRPCRequest(t, handler, claimed.Token, testCase.payload)
			if response.Code != http.StatusConflict {
				t.Fatalf("attempt-1 %s mutation must be fenced after attempt-2 reclaim, got %d: %s", testCase.name, response.Code, response.Body.String())
			}
			if testCase.mutated(fixture) {
				t.Fatalf("stale %s mutation reached the store", testCase.name)
			}
		})
	}
}

func TestDispatchHandlerOwnsLeaseTimingPolicy(t *testing.T) {
	fixture := newDispatchFixtureStore()
	handler := NewDispatchHandler(fixture, 15*time.Minute)
	clientFuture := time.Now().UTC().Add(365 * 24 * time.Hour)
	claim := sendDispatchRPCRequest(t, handler, "", map[string]any{
		"operation": "claim",
		"claimOptions": map[string]any{
			"workerId":     "executor-1",
			"leaseSeconds": 1,
			"now":          clientFuture,
		},
	})
	if claim.Code != http.StatusOK {
		t.Fatalf("claim failed with %d: %s", claim.Code, claim.Body.String())
	}
	if fixture.claimed.LeaseSeconds != 300 {
		t.Fatalf("dispatcher must override client lease duration, got %d", fixture.claimed.LeaseSeconds)
	}
	if fixture.claimed.Now.After(time.Now().UTC().Add(time.Minute)) {
		t.Fatalf("dispatcher must ignore client claim time, got %s", fixture.claimed.Now)
	}
	var claimed struct {
		Token string `json:"token"`
		Job   struct {
			ID       string `json:"ID"`
			LockedBy string `json:"LockedBy"`
			Attempts int    `json:"Attempts"`
		} `json:"job"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	renew := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{
		"operation": "renewLease",
		"lease": map[string]any{
			"JobID":    claimed.Job.ID,
			"WorkerID": claimed.Job.LockedBy,
			"Attempt":  claimed.Job.Attempts,
		},
		"now": clientFuture,
	})
	if renew.Code != http.StatusOK {
		t.Fatalf("renew failed with %d: %s", renew.Code, renew.Body.String())
	}
	if fixture.renewedAt.After(time.Now().UTC().Add(time.Minute)) {
		t.Fatalf("dispatcher must ignore client renewal time, got %s", fixture.renewedAt)
	}
}

func TestDispatchHandlerDoesNotExposeStoreInternals(t *testing.T) {
	fixture := newDispatchFixtureStore()
	fixture.claimError = errors.New(`pq: relation "WorkflowJobInternal" does not exist on db-host-01`)
	handler := NewDispatchHandler(fixture, 15*time.Minute)
	response := sendDispatchRPCRequest(t, handler, "", map[string]any{
		"operation":    "claim",
		"claimOptions": map[string]any{"workerId": "executor-1"},
	})
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("unexpected store error status %d: %s", response.Code, response.Body.String())
	}
	for _, internal := range []string{"WorkflowJobInternal", "db-host-01", "relation"} {
		if strings.Contains(response.Body.String(), internal) {
			t.Fatalf("dispatcher exposed store internals %q: %s", internal, response.Body.String())
		}
	}
}

func TestDispatchHandlerOwnsBuildTransitionTimestamps(t *testing.T) {
	fixture := newDispatchFixtureStore()
	handler := NewDispatchHandler(fixture, 15*time.Minute)
	claim := sendDispatchRPCRequest(t, handler, "", map[string]any{
		"operation":    "claim",
		"claimOptions": map[string]any{"workerId": "executor-1"},
	})
	if claim.Code != http.StatusOK {
		t.Fatalf("claim failed with %d: %s", claim.Code, claim.Body.String())
	}
	var claimed struct {
		Token string       `json:"token"`
		Job   *WorkflowJob `json:"job"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	clientFuture := time.Now().UTC().Add(365 * 24 * time.Hour)
	start := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{
		"operation": "startBuild",
		"buildStart": map[string]any{
			"lease":        claimed.Job.Lease(),
			"deploymentId": "deployment-1",
			"serviceId":    "service-1",
			"projectId":    "project-1",
			"startedAt":    clientFuture,
		},
	})
	if start.Code != http.StatusOK {
		t.Fatalf("start failed with %d: %s", start.Code, start.Body.String())
	}
	if fixture.startedAt.After(time.Now().UTC().Add(time.Minute)) {
		t.Fatalf("dispatcher must ignore client build start time, got %s", fixture.startedAt)
	}
	failure := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{
		"operation":    "updateDeployment",
		"deploymentId": "deployment-1",
		"updates": map[string]any{
			"status":          ErrorCodeBuildFailed,
			"buildFinishedAt": clientFuture.Format(time.RFC3339Nano),
			"errorCode":       ErrorCodeBuildFailed,
			"errorMessage":    "redacted build failure",
		},
	})
	if failure.Code != http.StatusOK {
		t.Fatalf("failure update failed with %d: %s", failure.Code, failure.Body.String())
	}
	finishedAt, err := time.Parse(time.RFC3339Nano, dispatchString(fixture.deploymentUpdates["buildFinishedAt"]))
	if err != nil {
		t.Fatalf("dispatcher wrote an invalid build failure time: %v", err)
	}
	if finishedAt.After(time.Now().UTC().Add(time.Minute)) {
		t.Fatalf("dispatcher must ignore client build failure time, got %s", finishedAt)
	}
	publication := sendDispatchRPCRequest(t, handler, claimed.Token, map[string]any{
		"operation": "publishImageReady",
		"publication": map[string]any{
			"lease":           claimed.Job.Lease(),
			"deploymentId":    "deployment-1",
			"serviceId":       "service-1",
			"projectId":       "project-1",
			"imageUrl":        "registry.example/app@sha256:" + strings.Repeat("a", 64),
			"imageDigest":     "sha256:" + strings.Repeat("a", 64),
			"buildFinishedAt": clientFuture,
		},
	})
	if publication.Code != http.StatusOK {
		t.Fatalf("publication failed with %d: %s", publication.Code, publication.Body.String())
	}
	if fixture.publishedAt.After(time.Now().UTC().Add(time.Minute)) {
		t.Fatalf("dispatcher must ignore client publication time, got %s", fixture.publishedAt)
	}
}

func TestDispatchHandlerRejectsOversizedRequests(t *testing.T) {
	handler := NewDispatchHandler(newDispatchFixtureStore(), 15*time.Minute)
	request := httptest.NewRequest(http.MethodPost, "/v1/rpc", strings.NewReader(`{"operation":"claim","padding":"`+strings.Repeat("x", dispatchRequestLimitBytes)+`"}`))
	request.TLS = verifiedDispatchTLSState()
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized dispatcher request must be rejected, got %d: %s", response.Code, response.Body.String())
	}
}

func TestDispatchHandlerRejectsPlaintextRequests(t *testing.T) {
	handler := NewDispatchHandler(newDispatchFixtureStore(), 15*time.Minute)
	request := httptest.NewRequest(http.MethodPost, "/v1/rpc", strings.NewReader(`{"operation":"claim","claimOptions":{"workerId":"executor-1"}}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("dispatcher handler must fail closed without a verified mTLS connection, got %d: %s", response.Code, response.Body.String())
	}
}

func TestNewRemoteStoreRejectsPlaintextDispatcher(t *testing.T) {
	_, err := NewRemoteStore(RemoteStoreConfig{BaseURL: "http://builder-dispatcher:8080"})
	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("remote control-plane store must require TLS, got %v", err)
	}
}

func TestRemoteStoreDoesNotFollowDispatcherRedirects(t *testing.T) {
	redirectedRequests := 0
	redirectTarget := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		redirectedRequests++
	}))
	defer redirectTarget.Close()

	certificateFiles := writeDispatchTestCertificates(t)
	tlsConfig, err := NewDispatcherTLSConfig(certificateFiles.ca, certificateFiles.serverCert, certificateFiles.serverKey)
	if err != nil {
		t.Fatal(err)
	}
	dispatcher := httptest.NewUnstartedServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, redirectTarget.URL+"/capture", http.StatusTemporaryRedirect)
	}))
	dispatcher.TLS = tlsConfig
	dispatcher.StartTLS()
	defer dispatcher.Close()

	store, err := NewRemoteStore(RemoteStoreConfig{
		BaseURL:               dispatcher.URL,
		CAFile:                certificateFiles.ca,
		ClientCertificateFile: certificateFiles.clientCert,
		ClientKeyFile:         certificateFiles.clientKey,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "executor-1"}); err == nil {
		t.Fatal("dispatcher redirects must fail closed")
	}
	if redirectedRequests != 0 {
		t.Fatalf("remote store followed a dispatcher redirect outside its validated origin: %d requests", redirectedRequests)
	}
}

func TestRemoteStoreRequiresMutualTLSAndServesScopedClaim(t *testing.T) {
	certificateFiles := writeDispatchTestCertificates(t)
	tlsConfig, err := NewDispatcherTLSConfig(certificateFiles.ca, certificateFiles.serverCert, certificateFiles.serverKey)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newDispatchFixtureStore()
	server := httptest.NewUnstartedServer(NewDispatchHandler(fixture, 15*time.Minute))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = tlsConfig
	server.StartTLS()
	defer server.Close()

	store, err := NewRemoteStore(RemoteStoreConfig{
		BaseURL:               server.URL,
		CAFile:                certificateFiles.ca,
		ClientCertificateFile: certificateFiles.clientCert,
		ClientKeyFile:         certificateFiles.clientKey,
	})
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "executor-1", LeaseSeconds: 300})
	if err != nil {
		t.Fatal(err)
	}
	if job == nil || job.ID != "job-1" {
		t.Fatalf("mTLS claim returned unexpected job: %+v", job)
	}
	project, err := store.GetProject(context.Background(), "project-1")
	if err != nil {
		t.Fatal(err)
	}
	if project.ID != "project-1" {
		t.Fatalf("scoped mTLS lookup returned unexpected project: %+v", project)
	}
	lease := job.Lease()
	if err := store.StartBuild(context.Background(), BuildStartInput{Lease: lease, DeploymentID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateDeployment(context.Background(), "deployment-1", map[string]any{
		"status":          ErrorCodeBuildFailed,
		"buildFinishedAt": time.Now().UTC().Format(time.RFC3339Nano),
		"errorCode":       ErrorCodeBuildFailed,
		"errorMessage":    "redacted build failure",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateService(context.Background(), "service-1", map[string]any{"repoUrl": "https://redacted@github.com/acme/example.git"}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendBuildLog(context.Background(), BuildLogInput{DeploymentID: "deployment-1", Step: "build", Line: "safe log"}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendDeploymentEvent(context.Background(), DeploymentEventInput{DeploymentID: "deployment-1", Type: "build.started"}); err != nil {
		t.Fatal(err)
	}
	if err := store.RenewWorkflowJobLease(context.Background(), lease, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := store.PublishImageReady(context.Background(), ImagePublicationInput{Lease: lease, DeploymentID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1", ImageURL: "registry.example/app@sha256:" + strings.Repeat("a", 64), ImageDigest: "sha256:" + strings.Repeat("a", 64)}); err != nil {
		t.Fatal(err)
	}
	if !fixture.started || !fixture.published || !fixture.renewed || !fixture.completed || fixture.logCount != 1 || fixture.eventCount != 2 {
		t.Fatalf("remote store did not preserve the scoped mutation contract: %+v", fixture)
	}
	if _, err := store.GetProject(context.Background(), "project-1"); err == nil || !strings.Contains(err.Error(), "session has not been established") {
		t.Fatalf("completed remote session must be erased, got %v", err)
	}

	roots := x509.NewCertPool()
	caPEM, err := os.ReadFile(certificateFiles.ca)
	if err != nil || !roots.AppendCertsFromPEM(caPEM) {
		t.Fatalf("load test CA: %v", err)
	}
	unauthenticatedClient := &http.Client{
		Timeout:   2 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots}},
	}
	requestBody := bytes.NewBufferString(`{"operation":"claim","claimOptions":{"workerId":"unauthenticated"}}`)
	request, err := http.NewRequest(http.MethodPost, server.URL+"/v1/rpc", requestBody)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if response, requestErr := unauthenticatedClient.Do(request); requestErr == nil {
		response.Body.Close()
		t.Fatal("dispatcher accepted a TLS client without a verified client certificate")
	}
}

type dispatchTestCertificateFiles struct {
	ca         string
	serverCert string
	serverKey  string
	clientCert string
	clientKey  string
}

func writeDispatchTestCertificates(t *testing.T) dispatchTestCertificateFiles {
	t.Helper()
	now := time.Now().UTC()
	caCert, caKey, caDER := createDispatchTestCertificate(t, x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "raibitserver-builder-test-ca"},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}, nil, nil)
	serverCert, serverKey, serverDER := createDispatchTestCertificate(t, x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "builder-dispatcher"},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}, caCert, caKey)
	clientCert, clientKey, clientDER := createDispatchTestCertificate(t, x509.Certificate{
		SerialNumber: big.NewInt(3),
		Subject:      pkix.Name{CommonName: "builder-executor"},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}, caCert, caKey)
	directory := t.TempDir()
	files := dispatchTestCertificateFiles{
		ca:         filepath.Join(directory, "ca.crt"),
		serverCert: filepath.Join(directory, "server.crt"),
		serverKey:  filepath.Join(directory, "server.key"),
		clientCert: filepath.Join(directory, "client.crt"),
		clientKey:  filepath.Join(directory, "client.key"),
	}
	writePEMFile(t, files.ca, "CERTIFICATE", caDER)
	writePEMFile(t, files.serverCert, "CERTIFICATE", serverDER)
	writePrivateKeyFile(t, files.serverKey, serverKey)
	writePEMFile(t, files.clientCert, "CERTIFICATE", clientDER)
	writePrivateKeyFile(t, files.clientKey, clientKey)
	_ = serverCert
	_ = clientCert
	return files
}

func createDispatchTestCertificate(t *testing.T, template x509.Certificate, parent *x509.Certificate, parentKey ed25519.PrivateKey) (*x509.Certificate, ed25519.PrivateKey, []byte) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if parent == nil {
		parent = &template
		parentKey = privateKey
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, parent, publicKey, parentKey)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return certificate, privateKey, der
}

func writePrivateKeyFile(t *testing.T, path string, key ed25519.PrivateKey) {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	writePEMFile(t, path, "PRIVATE KEY", der)
}

func writePEMFile(t *testing.T, path, blockType string, der []byte) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
}

func verifiedDispatchTLSState() *tls.ConnectionState {
	return verifiedDispatchTLSStateFor([]byte("default-test-client-certificate"))
}

func verifiedDispatchTLSStateFor(raw []byte) *tls.ConnectionState {
	certificate := &x509.Certificate{Raw: append([]byte(nil), raw...)}
	return &tls.ConnectionState{PeerCertificates: []*x509.Certificate{certificate}, VerifiedChains: [][]*x509.Certificate{{certificate}}}
}
