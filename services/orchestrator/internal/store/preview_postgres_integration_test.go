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
	defer db.Close()
	runtime := map[string]any{"version": 1, "lineageId": "lineage-pg", "deploymentId": "candidate-pg", "generation": 2, "lineageVersion": 3, "stableHost": "preview--pr-1--org--demo.example.test", "probeHost": "preview--probe-0123456789abcdef0123456789abcdef.example.test", "namespace": "org-demo", "workloadName": "candidate-web", "serviceName": "candidate-web", "probeIngressName": "candidate-web", "routeName": "preview-route"}
	runtimeRaw, err := json.Marshal(runtime)
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`INSERT INTO "User" (id,email,"updatedAt") VALUES ('user-pg','preview-pg@example.test',CURRENT_TIMESTAMP)`,
		`INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ('org-pg','Org','org',CURRENT_TIMESTAMP)`,
		`INSERT INTO "Membership" (id,"organizationId","userId",role) VALUES ('member-pg','org-pg','user-pg','OWNER')`,
		`INSERT INTO "Project" (id,"organizationId",name,slug,status,"updatedAt") VALUES ('project-pg','org-pg','Demo','demo','ACTIVE',CURRENT_TIMESTAMP)`,
		`INSERT INTO "Service" (id,"projectId",name,slug,type,"sourceType",status,"updatedAt") VALUES ('service-pg','project-pg','web','web','web','github','ACTIVE',CURRENT_TIMESTAMP)`,
		`INSERT INTO "GitHubIntegration" (id,"organizationId","userId","installationId","updatedAt") VALUES ('integration-pg','org-pg','user-pg','123',CURRENT_TIMESTAMP)`,
		`INSERT INTO "PreviewLineage" (id,"organizationId","projectId","serviceId","integrationId","installationId","repositoryId",repository,"pullRequestNumber","stableHost",namespace,"routeName",state,version,generation,"eventUpdatedAt","eventAction","headSha","headRef","baseRef","createdAt","updatedAt") VALUES ('lineage-pg','org-pg','project-pg','service-pg','integration-pg','123','456','org/repo',1,'preview--pr-1--org--demo.example.test','org-demo','preview-route','OPEN',3,2,CURRENT_TIMESTAMP,'synchronize',repeat('a',40),'feature','main',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed preview fixture: %v", err)
		}
	}
	for _, row := range []struct {
		id, status, health string
		generation         int
	}{
		{id: "current-pg", status: DeploymentStatusReady, health: "HEALTHY", generation: 1},
		{id: "candidate-pg", status: DeploymentStatusReady, health: "HEALTHY", generation: 2},
	} {
		candidateRuntime := runtimeRaw
		if row.generation == 1 {
			legacyRuntime := map[string]any{"version": 1, "lineageId": "lineage-pg", "deploymentId": row.id, "generation": 1, "lineageVersion": 2, "stableHost": "preview--pr-1--org--demo.example.test", "probeHost": "preview--probe-fedcba9876543210fedcba9876543210.example.test", "namespace": "org-demo", "workloadName": "current-web", "serviceName": "current-web", "probeIngressName": "current-web", "routeName": "preview-route"}
			candidateRuntime, _ = json.Marshal(legacyRuntime)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO "Deployment" (id,"serviceId","projectId",status,"deploymentType","triggerType",branch,"publicHealthStatus","previewLineageId","previewGeneration","previewRuntime","createdAt","updatedAt") VALUES ($1,'service-pg','project-pg',$2,'preview','github_pull_request','feature',$3,'lineage-pg',$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, row.id, row.status, row.health, row.generation, candidateRuntime); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `UPDATE "PreviewLineage" SET "candidateDeploymentId"='candidate-pg',"candidateGeneration"=2,"currentDeploymentId"='current-pg',"currentGeneration"=1 WHERE id='lineage-pg'`); err != nil {
		t.Fatal(err)
	}
	var lineageCheck, candidateCheck []byte
	if err := db.QueryRowContext(ctx, `SELECT to_jsonb(l),to_jsonb(d) FROM "PreviewLineage" l JOIN "Deployment" d ON d.id=l."candidateDeploymentId" WHERE l.id='lineage-pg'`).Scan(&lineageCheck, &candidateCheck); err != nil {
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
	intent := PreviewRouteIntent{Version: 1, LineageVersion: 3, Operation: PreviewPromote, DeploymentID: "candidate-pg", Generation: 2, Token: winner.Lease.Token, Namespace: "org-demo", Name: "preview-route"}
	if err := stores[0].SetPreviewRouteIntent(ctx, winner.Lease, intent); err != nil {
		t.Fatal(err)
	}

	// When
	err = stores[0].CompletePreviewRoute(ctx, winner.Lease, PreviewRouteObserved{Version: 1, LineageVersion: 3, DeploymentID: "candidate-pg", Generation: 2, Namespace: "org-demo", Name: "preview-route", UID: "route-uid", ResourceVersion: "19", ObservedAt: time.Now().UTC()})

	// Then
	if err != nil {
		t.Fatal(err)
	}
	var currentID, candidateID, previousStatus string
	if err := db.QueryRowContext(ctx, `SELECT "currentDeploymentId",COALESCE("candidateDeploymentId",'') FROM "PreviewLineage" WHERE id='lineage-pg'`).Scan(&currentID, &candidateID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT status FROM "Deployment" WHERE id='current-pg'`).Scan(&previousStatus); err != nil {
		t.Fatal(err)
	}
	if currentID != "candidate-pg" || candidateID != "" || previousStatus != DeploymentStatusCleanupRequested {
		t.Fatalf("current=%q candidate=%q previous=%q", currentID, candidateID, previousStatus)
	}
}
