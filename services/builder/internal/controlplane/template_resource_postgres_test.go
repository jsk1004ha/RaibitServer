package controlplane

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPostgresTemplateResourceClaimQualification(t *testing.T) {
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
	prefix := fmt.Sprintf("template-claim-%d", time.Now().UnixNano())
	org, project, foreignProject := prefix+"-org", prefix+"-project", prefix+"-foreign"
	service, deployment, job := prefix+"-service", prefix+"-deployment", prefix+"-job"
	resource, foreignResource := prefix+"-resource", prefix+"-foreign-resource"
	environment, devEnvironment := "env_prod_"+project, prefix+"-dev"
	now := time.Now().UTC().Truncate(time.Millisecond)
	exec := func(query string, args ...any) {
		t.Helper()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, setOperationalProtocolSQL); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		cleanupCtx, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		tx, err := db.BeginTx(cleanupCtx, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(cleanupCtx, setOperationalProtocolSQL); err != nil {
			t.Error(err)
			return
		}
		for _, query := range []string{`DELETE FROM "WorkflowJob" WHERE id LIKE $1`, `DELETE FROM "DeploymentEvent" WHERE "deploymentId" LIKE $1`, `DELETE FROM "Deployment" WHERE id LIKE $1`, `DELETE FROM "Service" WHERE id LIKE $1`, `DELETE FROM "Resource" WHERE id LIKE $1`, `DELETE FROM "Project" WHERE id LIKE $1`, `DELETE FROM "Organization" WHERE id LIKE $1`} {
			if _, err := tx.ExecContext(cleanupCtx, query, prefix+"%"); err != nil {
				t.Error(err)
				return
			}
		}
		if err := tx.Commit(); err != nil {
			t.Error(err)
		}
	}()
	exec(`INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,$2)`, org, now)
	for _, id := range []string{project, foreignProject} {
		exec(`INSERT INTO "Project" (id,"organizationId",name,slug,"updatedAt") VALUES ($1,$2,$1,$1,$3)`, id, org, now)
	}
	exec(`INSERT INTO "Environment" (id,"projectId",kind,"updatedAt") VALUES ($1,$2,'prod',$3) ON CONFLICT ("projectId",kind) DO NOTHING`, environment, project, now)
	exec(`INSERT INTO "Environment" (id,"projectId",kind,"updatedAt") VALUES ($1,$2,'dev',$3)`, devEnvironment, project, now)
	// Legacy inserts create authoritative production bindings through the existing compatibility trigger.
	if _, err := db.ExecContext(ctx, `INSERT INTO "Service" (id,"projectId",name,slug,type,"sourceType","buildMode","updatedAt") VALUES ($1,$2,'web','web','web','template','dockerfile',$3)`, service, project, now); err != nil {
		t.Fatal(err)
	}
	for _, row := range [][2]string{{resource, project}, {foreignResource, foreignProject}} {
		if _, err := db.ExecContext(ctx, `INSERT INTO "Resource" (id,"projectId",name,slug,type,engine,provider,plan,region,status,"updatedAt") VALUES ($1,$2,$1,$1,'database','postgresql','kubernetes','starter','test','READY',$3)`, row[0], row[1], now); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO "Deployment" (id,"serviceId","projectId","environmentId",status,"updatedAt") VALUES ($1,$2,$3,$4,'QUEUED',$5)`, deployment, service, project, environment, now)
	exec(`INSERT INTO "WorkflowJob" (id,type,status,"targetType","targetId",payload,"runAfter","updatedAt") VALUES ($1,'build-and-deploy','queued','deployment',$2,'{}',$3,$3)`, job, deployment, now)
	store := NewPostgresStore(db)
	for _, row := range []struct {
		name string
		ids  any
	}{
		{"missing", nil}, {"null", nil}, {"wrong shape", resource}, {"non-string", []any{1}},
		{"blank", []string{""}}, {"padded", []string{" " + resource}},
		{"absent", []string{prefix + "-absent"}}, {"foreign project", []string{foreignResource}},
		{"not ready", []string{resource}}, {"foreign environment", []string{resource}},
		{"all ready", []string{resource}},
	} {
		t.Run(row.name, func(t *testing.T) {
			payload := map[string]any{"deploymentId": deployment, "sourceType": "template", "templateResourceIds": row.ids}
			if row.name == "missing" {
				delete(payload, "templateResourceIds")
			}
			encoded, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			exec(`UPDATE "WorkflowJob" SET payload=$1::jsonb WHERE id=$2`, string(encoded), job)
			if row.name == "not ready" {
				exec(`UPDATE "Resource" SET status='PROVISIONING' WHERE id=$1`, resource)
			} else {
				exec(`UPDATE "Resource" SET status='READY' WHERE id=$1`, resource)
			}
			boundEnvironment := environment
			if row.name == "foreign environment" {
				boundEnvironment = devEnvironment
			}
			exec(`UPDATE "EnvironmentResource" SET "environmentId"=$1 WHERE "resourceId"=$2`, boundEnvironment, resource)
			claimed, err := store.ClaimNextWorkflowJob(ctx, ClaimOptions{WorkerID: "template-worker", Now: now})
			if err != nil {
				t.Fatal(err)
			}
			if row.name == "all ready" {
				if claimed == nil || claimed.ID != job || claimed.Attempts != 1 {
					t.Fatalf("ready dependency did not permit first claim: %+v", claimed)
				}
			} else if claimed != nil {
				t.Fatalf("invalid dependency permitted claim: %+v", claimed)
			}
		})
	}
}
