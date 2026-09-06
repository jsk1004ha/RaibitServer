package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPostgresPreviewRouteClaim_is_single_winner_and_promotion_is_atomic(t *testing.T) {
	// Given
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
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	token, err := newPreviewToken()
	if err != nil {
		t.Fatal(err)
	}
	prefix := "preview-pg-" + token
	userID, organizationID, membershipID := prefix+"-user", prefix+"-org", prefix+"-member"
	projectID, serviceID, integrationID := prefix+"-project", prefix+"-service", prefix+"-integration"
	lineageID, currentID, candidateID := prefix+"-lineage", prefix+"-current", prefix+"-candidate"
	stableHost := "preview--pr-1--" + token + ".example.test"
	namespace, routeName := "preview-"+token[:8], "route-"+token[:8]
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		for _, statement := range []struct {
			query string
			args  []any
		}{
			{`UPDATE "PreviewLineage" SET "candidateDeploymentId"=NULL,"candidateGeneration"=NULL,"currentDeploymentId"=NULL,"currentGeneration"=NULL WHERE id=$1`, []any{lineageID}},
			{`DELETE FROM "Deployment" WHERE "previewLineageId"=$1`, []any{lineageID}},
			{`DELETE FROM "PreviewLineage" WHERE id=$1`, []any{lineageID}},
			{`DELETE FROM "Organization" WHERE id=$1`, []any{organizationID}},
			{`DELETE FROM "User" WHERE id=$1`, []any{userID}},
		} {
			if _, err := db.ExecContext(cleanupCtx, statement.query, statement.args...); err != nil {
				t.Errorf("cleanup preview fixture: %v", err)
			}
		}
	})
	runtime := map[string]any{"version": 1, "lineageId": lineageID, "deploymentId": candidateID, "generation": 2, "lineageVersion": 3, "stableHost": stableHost, "probeHost": "preview--probe-0123456789abcdef0123456789abcdef.example.test", "namespace": namespace, "workloadName": "candidate-web", "serviceName": "candidate-web", "probeIngressName": "candidate-web", "routeName": routeName}
	runtimeRaw, err := json.Marshal(runtime)
	if err != nil {
		t.Fatal(err)
	}
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO "User" (id,email,"updatedAt") VALUES ($1,$2,CURRENT_TIMESTAMP)`, []any{userID, prefix + "@example.test"}},
		{`INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ($1,'Org',$1,CURRENT_TIMESTAMP)`, []any{organizationID}},
		{`INSERT INTO "Membership" (id,"organizationId","userId",role) VALUES ($1,$2,$3,'OWNER')`, []any{membershipID, organizationID, userID}},
		{`INSERT INTO "Project" (id,"organizationId",name,slug,status,"updatedAt") VALUES ($1,$2,'Demo',$1,'ACTIVE',CURRENT_TIMESTAMP)`, []any{projectID, organizationID}},
		{`INSERT INTO "Service" (id,"projectId",name,slug,type,"sourceType",status,"updatedAt") VALUES ($1,$2,'web','web','web','github','ACTIVE',CURRENT_TIMESTAMP)`, []any{serviceID, projectID}},
		{`INSERT INTO "GitHubIntegration" (id,"organizationId","userId","installationId","updatedAt") VALUES ($1,$2,$3,'123',CURRENT_TIMESTAMP)`, []any{integrationID, organizationID, userID}},
		{`INSERT INTO "PreviewLineage" (id,"organizationId","projectId","serviceId","integrationId","installationId","repositoryId",repository,"pullRequestNumber","stableHost",namespace,"routeName",state,version,generation,"eventUpdatedAt","eventAction","headSha","headRef","baseRef","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,'123','456','org/repo',1,$6,$7,$8,'OPEN',3,2,CURRENT_TIMESTAMP,'synchronize',repeat('a',40),'feature','main',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, []any{lineageID, organizationID, projectID, serviceID, integrationID, stableHost, namespace, routeName}},
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("seed preview fixture: %v", err)
		}
	}
	for _, row := range []struct {
		id, status, health string
		generation         int
	}{
		{id: currentID, status: DeploymentStatusReady, health: "HEALTHY", generation: 1},
		{id: candidateID, status: DeploymentStatusReady, health: "HEALTHY", generation: 2},
	} {
		candidateRuntime := runtimeRaw
		if row.generation == 1 {
			legacyRuntime := map[string]any{"version": 1, "lineageId": lineageID, "deploymentId": row.id, "generation": 1, "lineageVersion": 2, "stableHost": stableHost, "probeHost": "preview--probe-fedcba9876543210fedcba9876543210.example.test", "namespace": namespace, "workloadName": "current-web", "serviceName": "current-web", "probeIngressName": "current-web", "routeName": routeName}
			candidateRuntime, _ = json.Marshal(legacyRuntime)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO "Deployment" (id,"serviceId","projectId",status,"deploymentType","triggerType",branch,"publicHealthStatus","previewLineageId","previewGeneration","previewRuntime","createdAt","updatedAt") VALUES ($1,$2,$3,$4,'preview','github_pull_request','feature',$5,$6,$7,$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, row.id, serviceID, projectID, row.status, row.health, lineageID, row.generation, candidateRuntime); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `UPDATE "PreviewLineage" SET "candidateDeploymentId"=$1,"candidateGeneration"=2,"currentDeploymentId"=$2,"currentGeneration"=1 WHERE id=$3`, candidateID, currentID, lineageID); err != nil {
		t.Fatal(err)
	}
	var lineageCheck, candidateCheck []byte
	if err := db.QueryRowContext(ctx, `SELECT to_jsonb(l),to_jsonb(d) FROM "PreviewLineage" l JOIN "Deployment" d ON d.id=l."candidateDeploymentId" WHERE l.id=$1`, lineageID).Scan(&lineageCheck, &candidateCheck); err != nil {
		t.Fatal(err)
	}
	lineageRecord, _ := decodePreviewRecord(lineageCheck)
	candidateRecord, _ := decodePreviewRecord(candidateCheck)
	if _, ready := previewRouteWorkFromState(map[string]any{"deployments": []any{map[string]any(candidateRecord)}}, lineageRecord); !ready {
		t.Fatalf("seeded PostgreSQL candidate is not promotable: lineage=%s candidate=%s", lineageCheck, candidateCheck)
	}
	stores := []*PostgresStore{NewPostgresStore(db), NewPostgresStore(db)}
	claims := make([]*PreviewRouteWork, 2)
	errs := make([]error, 2)
	var group sync.WaitGroup
	for index := range stores {
		group.Add(1)
		go func() {
			defer group.Done()
			claims[index], errs[index] = stores[index].ClaimNextPreviewRoute(ctx, ClaimOptions{WorkerID: "worker-" + string(rune('a'+index)), Lease: time.Minute, Now: time.Now().UTC()})
		}()
	}
	group.Wait()
	var winner *PreviewRouteWork
	for index := range claims {
		if errs[index] != nil {
			t.Fatal(errs[index])
		}
		if claims[index] != nil {
			if winner != nil {
				t.Fatal("more than one preview route claim winner")
			}
			winner = claims[index]
		}
	}
	if winner == nil {
		t.Fatal("preview route claim had no winner")
	}
	intent := PreviewRouteIntent{Version: 1, LineageVersion: 3, Operation: PreviewPromote, DeploymentID: candidateID, Generation: 2, Token: winner.Lease.Token, Namespace: namespace, Name: routeName}
	if err := stores[0].SetPreviewRouteIntent(ctx, winner.Lease, intent); err != nil {
		t.Fatal(err)
	}

	// When
	err = stores[0].CompletePreviewRoute(ctx, winner.Lease, PreviewRouteObserved{Version: 1, LineageVersion: 3, DeploymentID: candidateID, Generation: 2, Namespace: namespace, Name: routeName, UID: "route-uid", ResourceVersion: "19", ObservedAt: time.Now().UTC()})

	// Then
	if err != nil {
		t.Fatal(err)
	}
	var actualCurrentID, actualCandidateID, previousStatus string
	if err := db.QueryRowContext(ctx, `SELECT "currentDeploymentId",COALESCE("candidateDeploymentId",'') FROM "PreviewLineage" WHERE id=$1`, lineageID).Scan(&actualCurrentID, &actualCandidateID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT status FROM "Deployment" WHERE id=$1`, currentID).Scan(&previousStatus); err != nil {
		t.Fatal(err)
	}
	if actualCurrentID != candidateID || actualCandidateID != "" || previousStatus != DeploymentStatusCleanupRequested {
		t.Fatalf("current=%q candidate=%q previous=%q", actualCurrentID, actualCandidateID, previousStatus)
	}
}
