package controlplane

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPostgresClaimReapsExpiredExhaustedBuild(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("RAIBITSERVER_TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("RAIBITSERVER_TEST_POSTGRES_DSN is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := sql.Open(postgresDriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close PostgreSQL builder integration connection: %v", err)
		}
	}()
	if err := db.PingContext(ctx); err != nil {
		t.Fatal(err)
	}

	prefix := fmt.Sprintf("builder-reap-%d", time.Now().UnixNano())
	organizationID := prefix + "-org"
	projectID := prefix + "-project"
	serviceID := prefix + "-service"
	buildingDeploymentID := prefix + "-building-deployment"
	queuedDeploymentID := prefix + "-queued-deployment"
	defaultMaxDeploymentID := prefix + "-default-max-deployment"
	mismatchTargetDeploymentID := prefix + "-mismatch-target-deployment"
	mismatchPayloadDeploymentID := prefix + "-mismatch-payload-deployment"
	publicationDeploymentID := prefix + "-publication-deployment"
	cancellationDeploymentID := prefix + "-cancellation-deployment"
	jobID := prefix + "-job"
	missingJobID := prefix + "-missing-job"
	queuedJobID := prefix + "-queued-job"
	defaultMaxJobID := prefix + "-default-max-job"
	mismatchJobID := prefix + "-mismatch-job"
	publicationJobID := prefix + "-publication-job"
	cancellationJobID := prefix + "-cancellation-job"
	now := time.Now().UTC().Truncate(time.Millisecond)
	lockedAt := now.Add(-2 * time.Second)
	publicationLockedAt := now.Add(time.Hour)

	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		for _, statement := range []struct {
			query string
			arg   string
		}{
			{`DELETE FROM "WorkflowJob" WHERE id LIKE $1`, prefix + "%"},
			{`DELETE FROM "DeploymentEvent" WHERE "deploymentId" LIKE $1`, prefix + "%"},
			{`DELETE FROM "Deployment" WHERE id LIKE $1`, prefix + "%"},
			{`DELETE FROM "Service" WHERE id = $1`, serviceID},
			{`DELETE FROM "Project" WHERE id = $1`, projectID},
			{`DELETE FROM "Organization" WHERE id = $1`, organizationID},
		} {
			if _, err := db.ExecContext(cleanupCtx, statement.query, statement.arg); err != nil {
				t.Errorf("cleanup PostgreSQL builder integration fixture: %v", err)
			}
		}
	}()

	mustExec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	mustExec(`INSERT INTO "Organization" (id, name, slug, "updatedAt") VALUES ($1, $2, $3, $4)`, organizationID, prefix, prefix, now)
	mustExec(`INSERT INTO "Project" (id, "organizationId", name, slug, "updatedAt") VALUES ($1, $2, $3, $4, $5)`, projectID, organizationID, prefix, prefix, now)
	mustExec(`INSERT INTO "Service" (id, "projectId", name, slug, type, "sourceType", status, "updatedAt") VALUES ($1, $2, $3, $4, 'web', 'git', 'CREATED', $5)`, serviceID, projectID, prefix, prefix, now)
	for _, deployment := range []struct {
		id     string
		status string
	}{
		{id: buildingDeploymentID, status: "BUILDING"},
		{id: queuedDeploymentID, status: "queued"},
		{id: defaultMaxDeploymentID, status: "QUEUED"},
		{id: mismatchTargetDeploymentID, status: "BUILDING"},
		{id: mismatchPayloadDeploymentID, status: "BUILDING"},
		{id: publicationDeploymentID, status: "BUILDING"},
		{id: cancellationDeploymentID, status: "BUILDING"},
	} {
		mustExec(`INSERT INTO "Deployment" (id, "serviceId", "projectId", status, "updatedAt") VALUES ($1, $2, $3, $4, $5)`, deployment.id, serviceID, projectID, deployment.status, now)
	}
	for _, job := range []struct {
		id           string
		targetID     string
		deploymentID string
		attempts     int
		maxAttempts  int
	}{
		{id: jobID, targetID: buildingDeploymentID, deploymentID: buildingDeploymentID, attempts: 1, maxAttempts: 1},
		{id: missingJobID, targetID: prefix + "-absent", deploymentID: prefix + "-absent", attempts: 1, maxAttempts: 1},
		{id: queuedJobID, targetID: " " + queuedDeploymentID + " ", deploymentID: "", attempts: 1, maxAttempts: 1},
		{id: mismatchJobID, targetID: mismatchTargetDeploymentID, deploymentID: mismatchPayloadDeploymentID, attempts: 1, maxAttempts: 1},
		{id: defaultMaxJobID, targetID: defaultMaxDeploymentID, deploymentID: defaultMaxDeploymentID, attempts: 2, maxAttempts: 0},
	} {
		payload, err := json.Marshal(map[string]any{"deploymentId": job.deploymentID, "lastError": "old error"})
		if err != nil {
			t.Fatal(err)
		}
		mustExec(`INSERT INTO "WorkflowJob" (id, type, status, "targetType", "targetId", payload, attempts, "maxAttempts", "runAfter", "lockedBy", "lockedAt", "updatedAt") VALUES ($1, 'build-and-deploy', 'running', ' deployment ', $2, $3::jsonb, $4, $5, $6, 'worker-a', $7, $7)`, job.id, job.targetID, string(payload), job.attempts, job.maxAttempts, lockedAt, lockedAt)
	}
	publicationPayload, err := json.Marshal(map[string]any{"deploymentId": publicationDeploymentID})
	if err != nil {
		t.Fatal(err)
	}
	mustExec(`INSERT INTO "WorkflowJob" (id, type, status, "targetType", "targetId", payload, attempts, "maxAttempts", "runAfter", "lockedBy", "lockedAt", "updatedAt") VALUES ($1, 'build-and-deploy', 'running', 'deployment', $2, $3::jsonb, 1, 3, $4, 'publisher-a', $4, $4)`, publicationJobID, publicationDeploymentID, string(publicationPayload), publicationLockedAt)
	cancellationPayload, err := json.Marshal(map[string]any{"deploymentId": cancellationDeploymentID})
	if err != nil {
		t.Fatal(err)
	}
	mustExec(`INSERT INTO "WorkflowJob" (id, type, status, "targetType", "targetId", payload, attempts, "maxAttempts", "runAfter", "lockedBy", "lockedAt", "updatedAt") VALUES ($1, 'build-and-deploy', 'running', 'deployment', $2, $3::jsonb, 1, 3, $4, 'publisher-cancel', $4, $4)`, cancellationJobID, cancellationDeploymentID, string(cancellationPayload), publicationLockedAt)

	store := NewPostgresStore(db)
	claimed, err := store.ClaimNextWorkflowJob(ctx, ClaimOptions{WorkerID: "worker-b", LeaseSeconds: 1, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if claimed == nil || claimed.ID != defaultMaxJobID || claimed.Attempts != 3 || claimed.LockedBy != "worker-b" {
		t.Fatalf("nonpositive maxAttempts must use the deterministic default before final-attempt recovery: %#v", claimed)
	}
	for _, id := range []string{jobID, missingJobID, queuedJobID, mismatchJobID} {
		var status string
		var payload []byte
		var lockedBy sql.NullString
		var persistedLockedAt sql.NullTime
		if err := db.QueryRowContext(ctx, `SELECT status, payload, "lockedBy", "lockedAt" FROM "WorkflowJob" WHERE id = $1`, id).Scan(&status, &payload, &lockedBy, &persistedLockedAt); err != nil {
			t.Fatal(err)
		}
		evidence := jsonMap(payload)
		errorSpec := mapField(evidence, "lastErrorSpec")
		if status != WorkflowFailed || lockedBy.Valid || persistedLockedAt.Valid {
			t.Fatalf("expired exhausted job was not terminalized and unlocked: status=%q lockedBy=%#v lockedAt=%#v", status, lockedBy, persistedLockedAt)
		}
		if stringField(evidence, "lastError") != exhaustedWorkflowFailureMessage || stringField(evidence, "failedAt") != now.Format(time.RFC3339Nano) ||
			stringField(errorSpec, "code") != ErrorCodeBuildFailed || stringField(errorSpec, "message") != exhaustedWorkflowFailureMessage {
			t.Fatalf("expired job failure evidence is incomplete or variable: %#v", evidence)
		}
	}

	assertDeploymentFailure := func(id string, wantFinishedAt time.Time) {
		t.Helper()
		var status string
		var finishedAt sql.NullTime
		var errorCode, errorMessage sql.NullString
		if err := db.QueryRowContext(ctx, `SELECT status, "buildFinishedAt", "errorCode", "errorMessage" FROM "Deployment" WHERE id = $1`, id).Scan(&status, &finishedAt, &errorCode, &errorMessage); err != nil {
			t.Fatal(err)
		}
		if status != ErrorCodeBuildFailed || !finishedAt.Valid || !finishedAt.Time.Equal(wantFinishedAt) || errorCode.String != ErrorCodeBuildFailed || errorMessage.String != exhaustedWorkflowFailureMessage {
			t.Fatalf("linked active deployment was not terminalized atomically: id=%s status=%q finishedAt=%#v code=%#v message=%#v", id, status, finishedAt, errorCode, errorMessage)
		}
	}
	assertDeploymentFailure(buildingDeploymentID, now)
	assertDeploymentFailure(queuedDeploymentID, now)
	for _, id := range []string{mismatchTargetDeploymentID, mismatchPayloadDeploymentID} {
		var status string
		if err := db.QueryRowContext(ctx, `SELECT status FROM "Deployment" WHERE id = $1`, id).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status != "BUILDING" {
			t.Fatalf("inconsistent workflow target mutated deployment %s: status=%q", id, status)
		}
	}

	defaultMaxReapedAt := now.Add(2 * time.Second)
	claimed, err = store.ClaimNextWorkflowJob(ctx, ClaimOptions{WorkerID: "worker-c", LeaseSeconds: 1, Now: defaultMaxReapedAt})
	if err != nil {
		t.Fatal(err)
	}
	if claimed != nil {
		t.Fatalf("defaulted final attempt must be reaped rather than reclaimed: %#v", claimed)
	}
	assertDeploymentFailure(defaultMaxDeploymentID, defaultMaxReapedAt)

	publicationLease := WorkflowLease{JobID: publicationJobID, WorkerID: "publisher-a", Attempt: 1}
	publication := ImagePublicationInput{
		Lease: publicationLease, DeploymentID: publicationDeploymentID, ServiceID: serviceID, ProjectID: projectID,
		ImageURL: "registry.example.test/team/api@sha256:ready", ImageDigest: "sha256:ready",
		SupplyChain: map[string]any{"invalid": math.Inf(1)}, BuildFinishedAt: defaultMaxReapedAt,
	}
	if err := store.PublishImageReady(ctx, publication); err == nil {
		t.Fatal("non-serializable publication evidence must roll back the entire transaction")
	}
	var rolledBackDeploymentStatus, rolledBackJobStatus string
	if err := db.QueryRowContext(ctx, `SELECT status FROM "Deployment" WHERE id = $1`, publicationDeploymentID).Scan(&rolledBackDeploymentStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT status FROM "WorkflowJob" WHERE id = $1`, publicationJobID).Scan(&rolledBackJobStatus); err != nil {
		t.Fatal(err)
	}
	if rolledBackDeploymentStatus != "BUILDING" || rolledBackJobStatus != WorkflowRunning {
		t.Fatalf("failed publication partially committed: deployment=%q job=%q", rolledBackDeploymentStatus, rolledBackJobStatus)
	}
	publication.SupplyChain = map[string]any{"scan": map[string]any{"result": "passed"}}
	if err := store.PublishImageReady(ctx, publication); err != nil {
		t.Fatalf("commit atomic image publication: %v", err)
	}
	var publishedDeploymentStatus, publishedJobStatus string
	var publishedDigest sql.NullString
	var publishedPayload []byte
	var publishedLockedBy sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT status, "imageDigest" FROM "Deployment" WHERE id = $1`, publicationDeploymentID).Scan(&publishedDeploymentStatus, &publishedDigest); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT status, payload, "lockedBy" FROM "WorkflowJob" WHERE id = $1`, publicationJobID).Scan(&publishedJobStatus, &publishedPayload, &publishedLockedBy); err != nil {
		t.Fatal(err)
	}
	var publicationEventCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM "DeploymentEvent" WHERE "deploymentId" = $1 AND type = 'build.image_ready'`, publicationDeploymentID).Scan(&publicationEventCount); err != nil {
		t.Fatal(err)
	}
	lastResult := mapField(jsonMap(publishedPayload), "lastResult")
	if publishedDeploymentStatus != "IMAGE_READY" || publishedDigest.String != "sha256:ready" || publishedJobStatus != WorkflowSucceeded || publishedLockedBy.Valid || publicationEventCount != 1 || stringField(lastResult, "imageDigest") != "sha256:ready" {
		t.Fatalf("publication was not atomic: deployment=%q digest=%#v job=%q locked=%#v events=%d payload=%#v", publishedDeploymentStatus, publishedDigest, publishedJobStatus, publishedLockedBy, publicationEventCount, jsonMap(publishedPayload))
	}

	// Production cancellation locks the workflow before the deployment. A publisher
	// already in flight must wait for that transaction and then fail its lease fence.
	cancelTx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cancelTx.Rollback() }()
	if _, err := cancelTx.ExecContext(ctx, `UPDATE "WorkflowJob" SET status = 'cancelled', "lockedBy" = NULL, "lockedAt" = NULL, "updatedAt" = $1 WHERE id = $2 AND status = 'running'`, now, cancellationJobID); err != nil {
		t.Fatal(err)
	}
	publicationResult := make(chan error, 1)
	go func() {
		publicationResult <- store.PublishImageReady(ctx, ImagePublicationInput{
			Lease:        WorkflowLease{JobID: cancellationJobID, WorkerID: "publisher-cancel", Attempt: 1},
			DeploymentID: cancellationDeploymentID, ServiceID: serviceID, ProjectID: projectID,
			ImageURL: "registry.example.test/team/api@sha256:late-cancelled", ImageDigest: "sha256:late-cancelled",
		})
	}()
	if _, err := cancelTx.ExecContext(ctx, `UPDATE "Deployment" SET status = 'CANCELLED', "finishedAt" = $1, "errorCode" = 'DEPLOYMENT_CANCELLED', "errorMessage" = 'operator cancelled', "updatedAt" = $1 WHERE id = $2 AND status = 'BUILDING'`, now, cancellationDeploymentID); err != nil {
		t.Fatal(err)
	}
	if err := cancelTx.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-publicationResult:
		if !errors.Is(err, ErrWorkflowLeaseLost) {
			t.Fatalf("publication racing cancellation must lose its workflow lease, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("publication did not leave the cancellation lock wait")
	}
	var cancelledDeploymentStatus, cancelledJobStatus string
	var cancelledDigest sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT status, "imageDigest" FROM "Deployment" WHERE id = $1`, cancellationDeploymentID).Scan(&cancelledDeploymentStatus, &cancelledDigest); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT status FROM "WorkflowJob" WHERE id = $1`, cancellationJobID).Scan(&cancelledJobStatus); err != nil {
		t.Fatal(err)
	}
	var cancelledPublicationEvents int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM "DeploymentEvent" WHERE "deploymentId" = $1 AND type = 'build.image_ready'`, cancellationDeploymentID).Scan(&cancelledPublicationEvents); err != nil {
		t.Fatal(err)
	}
	if cancelledDeploymentStatus != "CANCELLED" || cancelledJobStatus != "cancelled" || cancelledDigest.Valid || cancelledPublicationEvents != 0 {
		t.Fatalf("late publication overwrote terminal cancellation: deployment=%q job=%q digest=%#v events=%d", cancelledDeploymentStatus, cancelledJobStatus, cancelledDigest, cancelledPublicationEvents)
	}

	oldLease := WorkflowLease{JobID: jobID, WorkerID: "worker-a", Attempt: 1}
	if err := store.PublishImageReady(ctx, ImagePublicationInput{
		Lease: oldLease, DeploymentID: buildingDeploymentID, ServiceID: serviceID, ProjectID: projectID,
		ImageURL: "registry.example.test/team/api@sha256:late", ImageDigest: "sha256:late",
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("late PostgreSQL worker image publication must remain fenced, got %v", err)
	}
	if err := store.CompleteWorkflowJob(ctx, oldLease, map[string]any{"image": "late"}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("late PostgreSQL worker completion must remain fenced, got %v", err)
	}
	if _, err := store.UpdateDeploymentForLease(ctx, oldLease, buildingDeploymentID, map[string]any{
		"status": ErrorCodeBuildFailed, "errorCode": ErrorCodeBuildFailed, "errorMessage": "late overwrite",
	}); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("late PostgreSQL worker deployment failure overwrite must remain fenced, got %v", err)
	}
	var deploymentStatus string
	var imageDigest, errorMessage sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT status, "imageDigest", "errorMessage" FROM "Deployment" WHERE id = $1`, buildingDeploymentID).Scan(&deploymentStatus, &imageDigest, &errorMessage); err != nil {
		t.Fatal(err)
	}
	if deploymentStatus != ErrorCodeBuildFailed || imageDigest.Valid || errorMessage.String != exhaustedWorkflowFailureMessage {
		t.Fatalf("late PostgreSQL worker overwrote terminal deployment failure: status=%q digest=%#v message=%#v", deploymentStatus, imageDigest, errorMessage)
	}
}
