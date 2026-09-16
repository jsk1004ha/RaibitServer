package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

type healthHarness struct {
	HealthStore
	file  *FileStore
	db    *sql.DB
	input RolloutCompletion
}

func newHealthHarness(t *testing.T, postgres bool) *healthHarness {
	t.Helper()
	file, input := healthFixture(t)
	h := &healthHarness{HealthStore: file, file: file, input: input}
	if !postgres {
		return h
	}
	dsn := os.Getenv("RAIBITSERVER_HEALTH_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("RAIBITSERVER_HEALTH_POSTGRES_DSN is not configured; explicit qualification supplies an isolated database")
	}
	db, err := sql.Open(postgresDriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	h.db = db
	h.file = nil
	h.HealthStore = NewPostgresStore(db)
	digest := sha256.Sum256([]byte(t.Name()))
	prefix := "health-" + hex.EncodeToString(digest[:8])
	p := *input.Observation
	p.ProjectID = prefix + "-p"
	p.ServiceID = prefix + "-s"
	p.DeploymentID = prefix + "-d"
	h.input.Observation = &p
	h.input.Lease.DeploymentID = p.DeploymentID
	for _, query := range []string{
		`INSERT INTO "Organization"(id,name,slug,"updatedAt") VALUES('` + prefix + `','Health','` + prefix + `',CURRENT_TIMESTAMP)`,
		`INSERT INTO "Project"(id,"organizationId",name,slug,"updatedAt") VALUES('` + p.ProjectID + `','` + prefix + `','Health','` + prefix + `',CURRENT_TIMESTAMP)`,
		`INSERT INTO "Service"(id,"projectId",name,slug,type,"sourceType",port,"updatedAt") VALUES('` + p.ServiceID + `','` + p.ProjectID + `','web','web','web','image',3000,CURRENT_TIMESTAMP)`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	_, err = db.Exec(`INSERT INTO "Deployment"(id,"serviceId","projectId",status,"reconcileLockedBy","reconcileLockedAt","reconcileAttempts","reconcileAction","createdAt","updatedAt") VALUES($1,$2,$3,'DEPLOYING','rollout',$4,2,'apply',$4,$4)`, p.DeploymentID, p.ServiceID, p.ProjectID, input.Now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := db.Exec(`DELETE FROM "WorkflowJob" WHERE "targetId" LIKE $1`, prefix+"%"); err != nil {
			t.Error(err)
		}
		if _, err := db.Exec(`DELETE FROM "Organization" WHERE id=$1`, prefix); err != nil {
			t.Error(err)
		}
	})
	return h
}

func (h *healthHarness) ready(t *testing.T) {
	t.Helper()
	if _, err := h.CompleteRollout(t.Context(), h.input); err != nil {
		t.Fatal(err)
	}
}

func (h *healthHarness) claim(t *testing.T, at time.Time) *HealthJob {
	t.Helper()
	job, err := h.ClaimNextHealth(t.Context(), ClaimOptions{Now: at, WorkerID: "health-worker"})
	if err != nil || job == nil {
		t.Fatalf("claim: job=%+v err=%v", job, err)
	}
	return job
}

func (h *healthHarness) row(t *testing.T, table, id string) record {
	t.Helper()
	if h.file != nil {
		state, err := h.file.loadReadOnly()
		if err != nil {
			t.Fatal(err)
		}
		return findRecord(recordSlice(state, fileTable(table)), id)
	}
	var raw []byte
	err := h.db.QueryRow(`SELECT to_jsonb(x) FROM "`+table+`" x WHERE id=$1`, id).Scan(&raw)
	if err != nil {
		t.Fatal(err)
	}
	var row record
	if err := json.Unmarshal(raw, &row); err != nil {
		t.Fatal(err)
	}
	return row
}

func fileTable(table string) string {
	switch table {
	case "Deployment":
		return "deployments"
	case "Service":
		return "services"
	case "Project":
		return "projects"
	case "WorkflowJob":
		return "workflowJobs"
	}
	return ""
}

func (h *healthHarness) mutate(t *testing.T, table, id string, values record) {
	t.Helper()
	if h.file != nil {
		state, err := h.file.loadReadOnly()
		if err != nil {
			t.Fatal(err)
		}
		row := findRecord(recordSlice(state, fileTable(table)), id)
		for key, value := range values {
			row[key] = value
		}
		if err := h.file.save(state); err != nil {
			t.Fatal(err)
		}
		return
	}
	assignments := []string{}
	args := []any{id}
	for key, value := range values {
		args = append(args, value)
		assignments = append(assignments, fmt.Sprintf(`"%s"=$%d`, key, len(args)))
	}
	if _, err := h.db.Exec(`UPDATE "`+table+`" SET `+strings.Join(assignments, ",")+` WHERE id=$1`, args...); err != nil {
		t.Fatal(err)
	}
}

func (h *healthHarness) delete(t *testing.T, table, id string) {
	t.Helper()
	if h.file != nil {
		state, err := h.file.loadReadOnly()
		if err != nil {
			t.Fatal(err)
		}
		key := fileTable(table)
		setRecordSlice(state, key, filterRecords(recordSlice(state, key), func(row record) bool { return stringField(row, "id") != id }))
		if err := h.file.save(state); err != nil {
			t.Fatal(err)
		}
		return
	}
	if _, err := h.db.ExecContext(context.Background(), `DELETE FROM "`+table+`" WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
}
