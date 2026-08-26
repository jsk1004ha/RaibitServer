package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFileStoreRedactsKnownTokenBodiesFromEvidence(t *testing.T) {
	path := writeWorkflowJobs(t, nil)
	store := NewFileStore(path)
	tokens := []struct {
		value      string
		bodyMarker string
	}{
		{value: "sk-live-secret-body", bodyMarker: "live-secret"},
		{value: "ghp_github-secret-body", bodyMarker: "github-secret"},
	}
	for _, token := range tokens {
		redacted := Redact("credential=" + token.value)
		if strings.Contains(redacted, token.bodyMarker) {
			t.Fatalf("direct redaction leaked token body %q: %q", token.value, redacted)
		}
		if !strings.Contains(redacted, "****") {
			t.Fatalf("direct redaction did not mark token %q: %q", token.value, redacted)
		}
	}

	if err := store.AppendBuildLog(context.Background(), BuildLogInput{
		DeploymentID: "deployment-1",
		Step:         "scan",
		Line:         "scanner used sk-persisted-build-secret",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendDeploymentEvent(context.Background(), DeploymentEventInput{
		DeploymentID: "deployment-1",
		Type:         "deployment.failed",
		Message:      "provider rejected ghp_persisted-event-secret",
		Metadata:     map[string]any{"diagnostic": "retry with sk-persisted-metadata-secret"},
	}); err != nil {
		t.Fatal(err)
	}
	persisted, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"persisted-build", "persisted-event", "persisted-metadata"} {
		if strings.Contains(string(persisted), body) {
			t.Fatalf("persisted evidence leaked token body %q: %s", body, persisted)
		}
	}
}

func TestFileStoreFencesReclaimedWorkflowLease(t *testing.T) {
	store := NewFileStore(writeWorkflowState(t))
	base := time.Date(2026, time.July, 13, 0, 0, 0, 0, time.UTC)
	first, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "worker-a", LeaseSeconds: 1, Now: base})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "worker-b", LeaseSeconds: 1, Now: base.Add(2 * time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	if second == nil || second.LockedBy != "worker-b" || second.Attempts != 2 {
		t.Fatalf("expected stale lease reclamation by worker-b, got %#v", second)
	}
	if err := store.CompleteWorkflowJob(context.Background(), first.Lease(), map[string]any{"owner": "stale"}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("stale owner completion must be fenced, got %v", err)
	}
	if err := store.FailWorkflowJob(context.Background(), first.Lease(), errors.New("stale failure")); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("stale owner failure must be fenced, got %v", err)
	}
	if err := store.StartBuild(context.Background(), BuildStartInput{
		Lease: first.Lease(), DeploymentID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1",
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("stale owner build start must be fenced, got %v", err)
	}
	if err := store.PublishImageReady(context.Background(), ImagePublicationInput{
		Lease: first.Lease(), DeploymentID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1",
		ImageURL: "registry.example.test/team/api@sha256:stale", ImageDigest: "sha256:stale",
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("stale owner image publication must be fenced, got %v", err)
	}
	if _, err := store.updateDeploymentForLease(context.Background(), first.Lease(), "deployment-1", map[string]any{
		"status": ErrorCodeBuildFailed,
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("stale owner deployment failure update must be fenced, got %v", err)
	}
	if _, err := store.updateServiceForLease(context.Background(), first.Lease(), "service-1", map[string]any{
		"repoUrl": "https://redacted@github.com/stale/attempt.git",
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("stale owner repository redaction must be fenced, got %v", err)
	}
	if err := store.appendBuildLogForLease(context.Background(), first.Lease(), BuildLogInput{
		DeploymentID: "deployment-1", Line: "stale attempt log",
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("stale owner build log append must be fenced, got %v", err)
	}
	if err := store.appendDeploymentEventForLease(context.Background(), first.Lease(), DeploymentEventInput{
		DeploymentID: "deployment-1", Type: "build.failed", Message: "stale attempt event",
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("stale owner deployment event append must be fenced, got %v", err)
	}
	if err := store.CompleteWorkflowJob(context.Background(), second.Lease(), map[string]any{"owner": "current"}); err != nil {
		t.Fatalf("current owner could not complete: %v", err)
	}
	state, err := store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	job := recordSlice(state, "workflowJobs")[0]
	lastResult := mapField(mapField(job, "payload"), "lastResult")
	if stringField(job, "status") != WorkflowSucceeded || stringField(lastResult, "owner") != "current" {
		t.Fatalf("stale owner changed reclaimed job: %#v", job)
	}
	deployment := findRecord(recordSlice(state, "deployments"), "deployment-1")
	if stringField(deployment, "imageDigest") != "" || stringField(deployment, "status") != "QUEUED" {
		t.Fatalf("stale owner changed deployment state: %#v", deployment)
	}
	service := findRecord(recordSlice(state, "services"), "service-1")
	if stringField(service, "repoUrl") != "" {
		t.Fatalf("stale owner changed service state: %#v", service)
	}
	if len(recordSlice(state, "buildLogs")) != 0 || len(recordSlice(state, "deploymentEvents")) != 0 {
		t.Fatalf("stale owner appended build evidence: %#v", state)
	}
}

func TestFileStorePinsFullDeploymentCommitOnceDuringBuild(t *testing.T) {
	store := NewFileStore(writeWorkflowState(t))
	job, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "worker-a"})
	if err != nil || job == nil {
		t.Fatalf("claim build job: job=%#v err=%v", job, err)
	}
	if err := store.StartBuild(context.Background(), BuildStartInput{
		Lease: job.Lease(), DeploymentID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateDeploymentForLease(context.Background(), job.Lease(), "deployment-1", map[string]any{
		"commitSha": "abc123", "commitHash": "abc123",
	}); err == nil || !strings.Contains(err.Error(), "full 40 or 64") {
		t.Fatalf("short commit must not be accepted as an authoritative revision: %v", err)
	}

	commit := strings.Repeat("A", 40)
	deployment, err := store.UpdateDeploymentForLease(context.Background(), job.Lease(), "deployment-1", map[string]any{
		"commitSha": commit, "commitHash": commit,
	})
	if err != nil {
		t.Fatal(err)
	}
	normalizedCommit := strings.ToLower(commit)
	if deployment.CommitSHA != normalizedCommit || deployment.CommitHash != normalizedCommit {
		t.Fatalf("deployment commit pin was not normalized and persisted: %#v", deployment)
	}
	if _, err := store.UpdateDeploymentForLease(context.Background(), job.Lease(), "deployment-1", map[string]any{
		"commitSha": strings.Repeat("b", 40), "commitHash": strings.Repeat("b", 40),
	}); err == nil || !strings.Contains(err.Error(), "already pinned") {
		t.Fatalf("an existing deployment commit pin must be immutable: %v", err)
	}
	if _, err := store.UpdateDeploymentForLease(context.Background(), job.Lease(), "deployment-1", map[string]any{
		"commitSha": normalizedCommit,
	}); err == nil || !strings.Contains(err.Error(), "together") {
		t.Fatalf("partial deployment commit pin must fail closed: %v", err)
	}
}

func TestFileStoreImagePublicationAtomicallyCompletesJobAndRecordsEvent(t *testing.T) {
	store := NewFileStore(writeWorkflowState(t))
	job, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "worker-a"})
	if err != nil || job == nil {
		t.Fatalf("claim build job: job=%#v err=%v", job, err)
	}
	if err := store.StartBuild(context.Background(), BuildStartInput{
		Lease: job.Lease(), DeploymentID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1",
	}); err != nil {
		t.Fatal(err)
	}
	publication := ImagePublicationInput{
		Lease: job.Lease(), DeploymentID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1",
		ImageURL: "registry.example.test/team/api@sha256:ready", ImageDigest: "sha256:ready",
		SupplyChain: map[string]any{"invalid": math.Inf(1)},
	}
	if err := store.PublishImageReady(context.Background(), publication); err == nil {
		t.Fatal("non-serializable publication evidence must not persist a partial FileStore state")
	}
	rolledBack, err := store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	if persistedJob := findRecord(recordSlice(rolledBack, "workflowJobs"), job.ID); stringField(persistedJob, "status") != WorkflowRunning {
		t.Fatalf("failed publication partially completed the FileStore job: %#v", persistedJob)
	}
	if deployment := findRecord(recordSlice(rolledBack, "deployments"), "deployment-1"); stringField(deployment, "status") != "BUILDING" {
		t.Fatalf("failed publication partially committed the FileStore deployment: %#v", deployment)
	}
	publication.SupplyChain = map[string]any{"scan": map[string]any{"result": "passed"}}
	if err := store.PublishImageReady(context.Background(), publication); err != nil {
		t.Fatal(err)
	}

	state, err := store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	persistedJob := findRecord(recordSlice(state, "workflowJobs"), job.ID)
	lastResult := mapField(mapField(persistedJob, "payload"), "lastResult")
	if stringField(persistedJob, "status") != WorkflowSucceeded || stringField(persistedJob, "lockedBy") != "" ||
		stringField(persistedJob, "runAfter") != "2026-07-13T00:00:00Z" || stringField(lastResult, "imageDigest") != "sha256:ready" {
		t.Fatalf("publication must durably complete and unlock the job: %#v", persistedJob)
	}
	events := recordSlice(state, "deploymentEvents")
	if len(events) != 1 || stringField(events[0], "deploymentId") != "deployment-1" || stringField(events[0], "type") != "build.image_ready" {
		t.Fatalf("publication must atomically record its authoritative event: %#v", events)
	}
	deployment := findRecord(recordSlice(state, "deployments"), "deployment-1")
	if stringField(deployment, "status") != "IMAGE_READY" || stringField(deployment, "imageDigest") != "sha256:ready" {
		t.Fatalf("publication did not persist the image-ready deployment: %#v", deployment)
	}
}

func TestFileStoreCancellationAndWorkflowBindingFenceBuildTransitions(t *testing.T) {
	store := NewFileStore(writeWorkflowState(t))
	job, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "worker-a"})
	if err != nil || job == nil {
		t.Fatalf("claim build job: job=%#v err=%v", job, err)
	}
	state, err := store.load()
	if err != nil {
		t.Fatal(err)
	}
	deployments := recordSlice(state, "deployments")
	deployments = append(deployments, record{"id": "deployment-2", "serviceId": "service-1", "projectId": "project-1", "status": "QUEUED"})
	setRecordSlice(state, "deployments", deployments)
	if err := store.save(state); err != nil {
		t.Fatal(err)
	}
	if err := store.StartBuild(context.Background(), BuildStartInput{
		Lease: job.Lease(), DeploymentID: "deployment-2", ServiceID: "service-1", ProjectID: "project-1",
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("a valid lease must not start a different deployment: %v", err)
	}
	if err := store.StartBuild(context.Background(), BuildStartInput{
		Lease: job.Lease(), DeploymentID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1",
	}); err != nil {
		t.Fatal(err)
	}
	state, err = store.load()
	if err != nil {
		t.Fatal(err)
	}
	findRecord(recordSlice(state, "deployments"), "deployment-1")["status"] = "CANCELLED"
	if err := store.save(state); err != nil {
		t.Fatal(err)
	}
	if err := store.PublishImageReady(context.Background(), ImagePublicationInput{
		Lease: job.Lease(), DeploymentID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1",
		ImageURL: "registry.example.test/team/api@sha256:late", ImageDigest: "sha256:late",
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("cancellation request must fence late image publication: %v", err)
	}
	persisted, err := store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	deployment := findRecord(recordSlice(persisted, "deployments"), "deployment-1")
	if stringField(deployment, "status") != "CANCELLED" || stringField(deployment, "imageDigest") != "" {
		t.Fatalf("late publication overwrote cancellation: %#v", deployment)
	}
	if events := recordSlice(persisted, "deploymentEvents"); len(events) != 0 {
		t.Fatalf("fenced publication appended evidence: %#v", events)
	}
}

func TestFileStoreReapsExpiredExhaustedBuildAndFencesLateWorker(t *testing.T) {
	const exhaustedMessage = "build worker lease expired after the final allowed attempt"
	base := time.Date(2026, time.July, 15, 1, 2, 3, 0, time.UTC)
	path := writeControlPlaneState(t, map[string]any{
		"projects": []any{map[string]any{"id": "project-1", "status": "ACTIVE"}},
		"services": []any{map[string]any{
			"id": "service-1", "projectId": "project-1", "status": "CREATED",
		}},
		"deployments": []any{map[string]any{
			"id": "deployment-1", "serviceId": "service-1", "projectId": "project-1", "status": "BUILDING",
		}},
		"workflowJobs": []any{map[string]any{
			"id": "job-1", "type": "build-and-deploy", "status": WorkflowRunning,
			"targetType": "deployment", "targetId": "deployment-1",
			"payload":  map[string]any{"deploymentId": "deployment-1", "lastError": "old error"},
			"attempts": 1, "maxAttempts": 1, "lockedBy": "worker-a",
			"lockedAt": base.Format(time.RFC3339Nano), "runAfter": base.Add(-time.Minute).Format(time.RFC3339Nano),
		}},
	})
	store := NewFileStore(path)
	oldLease := WorkflowLease{JobID: "job-1", WorkerID: "worker-a", Attempt: 1}

	claimed, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{
		WorkerID: "worker-b", LeaseSeconds: 2, Now: base.Add(time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	if claimed != nil {
		t.Fatalf("unexpired exhausted job must not be claimed or reaped: %#v", claimed)
	}
	state, err := store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	if job := findRecord(recordSlice(state, "workflowJobs"), "job-1"); stringField(job, "status") != WorkflowRunning {
		t.Fatalf("unexpired exhausted job was terminalized early: %#v", job)
	}

	reapedAt := base.Add(3 * time.Second)
	claimed, err = store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{
		WorkerID: "worker-b", LeaseSeconds: 2, Now: reapedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if claimed != nil {
		t.Fatalf("exhausted job must be reaped, not reclaimed: %#v", claimed)
	}
	state, err = store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	job := findRecord(recordSlice(state, "workflowJobs"), "job-1")
	payload := mapField(job, "payload")
	errorSpec := mapField(payload, "lastErrorSpec")
	if stringField(job, "status") != WorkflowFailed || stringField(job, "lockedBy") != "" || stringField(job, "lockedAt") != "" {
		t.Fatalf("expired exhausted job was not terminalized and unlocked: %#v", job)
	}
	if stringField(payload, "lastError") != exhaustedMessage || stringField(payload, "failedAt") != reapedAt.Format(time.RFC3339Nano) {
		t.Fatalf("expired job failure evidence is not fixed and timestamped: %#v", payload)
	}
	if stringField(errorSpec, "code") != ErrorCodeBuildFailed || stringField(errorSpec, "area") != "build" || stringField(errorSpec, "message") != exhaustedMessage {
		t.Fatalf("expired job error spec is not the fixed build failure: %#v", errorSpec)
	}
	deployment := findRecord(recordSlice(state, "deployments"), "deployment-1")
	if stringField(deployment, "status") != ErrorCodeBuildFailed || stringField(deployment, "errorCode") != ErrorCodeBuildFailed ||
		stringField(deployment, "errorMessage") != exhaustedMessage || stringField(deployment, "buildFinishedAt") != reapedAt.Format(time.RFC3339Nano) {
		t.Fatalf("linked building deployment was not terminalized with the job: %#v", deployment)
	}

	if err := store.PublishImageReady(context.Background(), ImagePublicationInput{
		Lease: oldLease, DeploymentID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1",
		ImageURL: "registry.example.test/team/api@sha256:late", ImageDigest: "sha256:late",
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("late worker image publication must remain fenced, got %v", err)
	}
	if err := store.CompleteWorkflowJob(context.Background(), oldLease, map[string]any{"image": "late"}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("late worker completion must remain fenced, got %v", err)
	}
	if _, err := store.UpdateDeploymentForLease(context.Background(), oldLease, "deployment-1", map[string]any{
		"status": ErrorCodeBuildFailed, "errorCode": ErrorCodeBuildFailed, "errorMessage": "late overwrite",
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("late worker deployment failure overwrite must remain fenced, got %v", err)
	}
	state, err = store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	job = findRecord(recordSlice(state, "workflowJobs"), "job-1")
	deployment = findRecord(recordSlice(state, "deployments"), "deployment-1")
	if stringField(job, "status") != WorkflowFailed || stringField(deployment, "status") != ErrorCodeBuildFailed || stringField(deployment, "imageDigest") != "" {
		t.Fatalf("late worker overwrote terminal failure: job=%#v deployment=%#v", job, deployment)
	}
}

func TestFileStoreReapsExpiredExhaustedBuildWithoutDeployment(t *testing.T) {
	base := time.Date(2026, time.July, 15, 1, 2, 3, 0, time.UTC)
	path := writeWorkflowJobs(t, []any{map[string]any{
		"id": "job-missing-target", "type": "build", "status": WorkflowRunning,
		"targetType": "deployment", "targetId": "missing-deployment",
		"payload":  map[string]any{"deploymentId": "missing-deployment"},
		"attempts": 3, "maxAttempts": 3, "lockedBy": "worker-a",
		"lockedAt": base.Format(time.RFC3339Nano), "runAfter": base.Add(-time.Minute).Format(time.RFC3339Nano),
	}})
	store := NewFileStore(path)
	if claimed, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{
		WorkerID: "worker-b", LeaseSeconds: 1, Now: base.Add(2 * time.Second),
	}); err != nil || claimed != nil {
		t.Fatalf("missing deployment must not prevent safe terminalization: claimed=%#v err=%v", claimed, err)
	}
	state, err := store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	job := findRecord(recordSlice(state, "workflowJobs"), "job-missing-target")
	if stringField(job, "status") != WorkflowFailed || stringField(job, "lockedBy") != "" || stringField(job, "lockedAt") != "" {
		t.Fatalf("job with missing deployment remained stuck: %#v", job)
	}
}

func TestFileStoreReaperFailsClosedOnInconsistentDeploymentTargets(t *testing.T) {
	base := time.Date(2026, time.July, 15, 1, 2, 3, 0, time.UTC)
	path := writeControlPlaneState(t, map[string]any{
		"deployments": []any{
			map[string]any{"id": "deployment-from-target", "status": "BUILDING"},
			map[string]any{"id": "deployment-from-payload", "status": "BUILDING"},
		},
		"workflowJobs": []any{map[string]any{
			"id": "job-mismatch", "type": "build-and-deploy", "status": WorkflowRunning,
			"targetType": "deployment", "targetId": "deployment-from-target",
			"payload":  map[string]any{"deploymentId": "deployment-from-payload"},
			"attempts": 1, "maxAttempts": 1, "lockedBy": "worker-a",
			"lockedAt": base.Format(time.RFC3339Nano),
		}},
	})
	store := NewFileStore(path)

	if claimed, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{
		WorkerID: "worker-b", LeaseSeconds: 1, Now: base.Add(2 * time.Second),
	}); err != nil || claimed != nil {
		t.Fatalf("inconsistent exhausted job must be terminalized without a claim: claimed=%#v err=%v", claimed, err)
	}
	state, err := store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	job := findRecord(recordSlice(state, "workflowJobs"), "job-mismatch")
	if stringField(job, "status") != WorkflowFailed {
		t.Fatalf("inconsistent exhausted job remained running: %#v", job)
	}
	for _, deploymentID := range []string{"deployment-from-target", "deployment-from-payload"} {
		deployment := findRecord(recordSlice(state, "deployments"), deploymentID)
		if stringField(deployment, "status") != "BUILDING" {
			t.Fatalf("inconsistent job mutated deployment %s: %#v", deploymentID, deployment)
		}
	}
}

func TestFileStoreReaperTerminalizesQueuedDeploymentAfterPreBuildCrash(t *testing.T) {
	base := time.Date(2026, time.July, 15, 1, 2, 3, 0, time.UTC)
	path := writeControlPlaneState(t, map[string]any{
		"deployments": []any{map[string]any{"id": "deployment-queued", "status": "queued"}},
		"workflowJobs": []any{map[string]any{
			"id": "job-pre-build-crash", "type": "build", "status": WorkflowRunning,
			"targetType": " deployment ", "targetId": " deployment-queued ", "payload": map[string]any{},
			"attempts": 1, "maxAttempts": 1, "lockedBy": "worker-a",
			"lockedAt": base.Format(time.RFC3339Nano),
		}},
	})
	store := NewFileStore(path)

	if claimed, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{
		WorkerID: "worker-b", LeaseSeconds: 1, Now: base.Add(2 * time.Second),
	}); err != nil || claimed != nil {
		t.Fatalf("pre-build crash must be terminalized without a claim: claimed=%#v err=%v", claimed, err)
	}
	state, err := store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	deployment := findRecord(recordSlice(state, "deployments"), "deployment-queued")
	if stringField(deployment, "status") != ErrorCodeBuildFailed || stringField(deployment, "errorCode") != ErrorCodeBuildFailed {
		t.Fatalf("queued deployment remained nonterminal after its final attempt expired: %#v", deployment)
	}
}

func TestFileStoreReaperIsBoundedPerClaim(t *testing.T) {
	base := time.Date(2026, time.July, 15, 1, 2, 3, 0, time.UTC)
	jobs := make([]any, exhaustedWorkflowReapLimit+1)
	for index := range jobs {
		jobs[index] = map[string]any{
			"id": fmt.Sprintf("job-%02d", index), "type": "build", "status": WorkflowRunning,
			"targetType": "deployment", "targetId": fmt.Sprintf("deployment-%02d", index), "payload": map[string]any{},
			"attempts": 1, "maxAttempts": 1, "lockedBy": "worker-a",
			"lockedAt": base.Format(time.RFC3339Nano),
		}
	}
	store := NewFileStore(writeControlPlaneState(t, map[string]any{"workflowJobs": jobs}))

	if _, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{LeaseSeconds: 1, Now: base.Add(2 * time.Second)}); err != nil {
		t.Fatal(err)
	}
	state, err := store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	failed := 0
	running := 0
	for _, job := range recordSlice(state, "workflowJobs") {
		switch stringField(job, "status") {
		case WorkflowFailed:
			failed++
		case WorkflowRunning:
			running++
		}
	}
	if failed != exhaustedWorkflowReapLimit || running != 1 {
		t.Fatalf("one claim produced failed=%d running=%d, want bounded batch of %d with one remainder", failed, running, exhaustedWorkflowReapLimit)
	}

	if _, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{LeaseSeconds: 1, Now: base.Add(2 * time.Second)}); err != nil {
		t.Fatal(err)
	}
	state, err = store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range recordSlice(state, "workflowJobs") {
		if stringField(job, "status") != WorkflowFailed {
			t.Fatalf("bounded follow-up left an exhausted job nonterminal: %#v", job)
		}
	}
}

func TestFileStoreRenewedLeaseCannotBeReclaimed(t *testing.T) {
	store := NewFileStore(writeWorkflowState(t))
	base := time.Date(2026, time.July, 13, 0, 0, 0, 0, time.UTC)
	claimed, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "worker-a", LeaseSeconds: 3, Now: base})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RenewWorkflowJobLease(context.Background(), claimed.Lease(), base.Add(2*time.Second)); err != nil {
		t.Fatalf("lease renewal failed: %v", err)
	}
	reclaimed, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "worker-b", LeaseSeconds: 3, Now: base.Add(4 * time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	if reclaimed != nil {
		t.Fatalf("renewed lease was reclaimed early: %#v", reclaimed)
	}
}

func TestFileStoreClaimsOnlyBuilderWorkflowTypes(t *testing.T) {
	path := writeWorkflowJobs(t, []any{
		map[string]any{
			"id": "cleanup-job", "type": "preview-cleanup", "status": WorkflowQueued,
			"payload": map[string]any{}, "attempts": 0, "maxAttempts": 3,
			"runAfter": "2026-07-12T23:58:00Z",
		},
		map[string]any{
			"id": "sync-job", "type": "github-repository-sync", "status": WorkflowQueued,
			"payload": map[string]any{}, "attempts": 0, "maxAttempts": 3,
			"runAfter": "2026-07-12T23:59:00Z",
		},
		map[string]any{
			"id": "build-job", "type": "preview-deploy", "status": WorkflowQueued,
			"payload": map[string]any{}, "attempts": 0, "maxAttempts": 3,
			"runAfter": "2026-07-13T00:00:00Z",
		},
	})
	store := NewFileStore(path)
	base := time.Date(2026, time.July, 13, 0, 0, 1, 0, time.UTC)
	claimed, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "builder-a", Now: base})
	if err != nil {
		t.Fatal(err)
	}
	if claimed == nil || claimed.ID != "build-job" {
		t.Fatalf("builder must skip cleanup/sync jobs and claim preview-deploy, got %#v", claimed)
	}
	remaining, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{WorkerID: "builder-b", Now: base.Add(time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	if remaining != nil {
		t.Fatalf("builder claimed unsupported workflow job: %#v", remaining)
	}
	state, err := store.loadReadOnly()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"cleanup-job", "sync-job"} {
		job := findRecord(recordSlice(state, "workflowJobs"), id)
		if stringField(job, "status") != WorkflowQueued || intField(job, "attempts") != 0 {
			t.Fatalf("unsupported job %s was mutated: %#v", id, job)
		}
	}
}

func TestFileStoreSkipsBuildJobsWhoseServiceOrProjectIsDeleting(t *testing.T) {
	for _, scope := range []string{"service", "project"} {
		for _, status := range []string{"DELETE_REQUESTED", "DELETING", "DELETE_FAILED"} {
			t.Run(scope+"-"+status, func(t *testing.T) {
				projectStatus := "ACTIVE"
				serviceStatus := "CREATED"
				if scope == "project" {
					projectStatus = status
				} else {
					serviceStatus = status
				}
				path := writeControlPlaneState(t, map[string]any{
					"projects":    []any{map[string]any{"id": "project-1", "status": projectStatus}},
					"services":    []any{map[string]any{"id": "service-1", "projectId": "project-1", "status": serviceStatus}},
					"deployments": []any{map[string]any{"id": "deployment-1", "serviceId": "service-1", "projectId": "project-1"}},
					"workflowJobs": []any{map[string]any{
						"id": "job-1", "type": "build-and-deploy", "status": WorkflowQueued,
						"targetType": "deployment", "targetId": "deployment-1",
						"payload":  map[string]any{"deploymentId": "deployment-1"},
						"attempts": 0, "maxAttempts": 3, "runAfter": "2026-07-13T00:00:00Z",
					}},
				})
				store := NewFileStore(path)
				claimed, err := store.ClaimNextWorkflowJob(context.Background(), ClaimOptions{
					WorkerID: "builder-a",
					Now:      time.Date(2026, time.July, 13, 0, 0, 1, 0, time.UTC),
				})
				if err != nil {
					t.Fatal(err)
				}
				if claimed != nil {
					t.Fatalf("builder claimed job for deleting %s: %#v", scope, claimed)
				}
				state, err := store.loadReadOnly()
				if err != nil {
					t.Fatal(err)
				}
				job := findRecord(recordSlice(state, "workflowJobs"), "job-1")
				if stringField(job, "status") != WorkflowQueued || intField(job, "attempts") != 0 {
					t.Fatalf("skipped deletion job was mutated: %#v", job)
				}
			})
		}
	}
}

func TestFileStoreDeletionStatusIsExposedOnBuilderContracts(t *testing.T) {
	store := NewFileStore(writeControlPlaneState(t, map[string]any{
		"projects": []any{map[string]any{"id": "project-1", "status": "DELETE_FAILED"}},
		"services": []any{map[string]any{"id": "service-1", "projectId": "project-1", "status": "DELETING"}},
	}))
	project, err := store.GetProject(context.Background(), "project-1")
	if err != nil {
		t.Fatal(err)
	}
	service, err := store.GetService(context.Background(), "service-1")
	if err != nil {
		t.Fatal(err)
	}
	if project.Status != "DELETE_FAILED" || service.Status != "DELETING" {
		t.Fatalf("deletion status missing from builder contracts: project=%#v service=%#v", project, service)
	}
}

func writeWorkflowState(t *testing.T) string {
	t.Helper()
	return writeControlPlaneState(t, map[string]any{
		"projects":    []any{map[string]any{"id": "project-1", "status": "ACTIVE"}},
		"services":    []any{map[string]any{"id": "service-1", "projectId": "project-1", "status": "CREATED"}},
		"deployments": []any{map[string]any{"id": "deployment-1", "serviceId": "service-1", "projectId": "project-1", "status": "QUEUED"}},
		"workflowJobs": []any{map[string]any{
			"id": "job-1", "type": "build-and-deploy", "status": WorkflowQueued,
			"targetType": "deployment", "targetId": "deployment-1",
			"payload": map[string]any{}, "attempts": 0, "maxAttempts": 3,
			"runAfter": "2026-07-13T00:00:00Z",
		}},
	})
}

func writeWorkflowJobs(t *testing.T, jobs []any) string {
	t.Helper()
	return writeControlPlaneState(t, map[string]any{"workflowJobs": jobs})
}

func writeControlPlaneState(t *testing.T, state map[string]any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.json")
	bytes, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
