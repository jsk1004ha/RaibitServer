package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// SQLite evaluates the relational claim boundary; PostgreSQL locks and triggers
// remain a native gate. Only PostgreSQL-specific syntax is translated.
const environmentQueryProbe = `
const fs = require('node:fs');
const {DatabaseSync} = require('node:sqlite');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const output = input.cases.map(c => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE Project(id, organizationId, slug, status, deletionRequestedAt); CREATE TABLE Resource(id, projectId, name, slug, type, engine, provider, plan, region, version, status, connectionSecretName, desiredSpec, desiredState, updatedAt, createdAt, deletionRequestedAt); CREATE TABLE EnvironmentResource(resourceId, environmentId, projectId, logicalSlug); CREATE TABLE Environment(id, projectId, kind); CREATE TABLE ResourceRecoveryPin(resourceId, kind);');
    db.prepare('INSERT INTO Project VALUES (?,?,?,?,?)').run('project','org','project','ACTIVE',null);
    const state = c.state ?? JSON.stringify({resourceExecution:{intent:'live-provision',environment:c.execution,image:'pinned-image'}});
    db.prepare('INSERT INTO Resource VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('resource','project','Database',c.slug,'database','postgresql','dedicated-local','shared-small','local',null,input.status,'legacy-connection','{}',state,'2000-01-01','2000-01-01',null);
    if(c.binding) db.prepare('INSERT INTO EnvironmentResource VALUES (?,?,?,?)').run(...c.binding);
    if(c.environment) db.prepare('INSERT INTO Environment VALUES (?,?,?)').run(...c.environment);
    let query = input.query
      .replace(/\(clock_timestamp\(\) AT TIME ZONE 'UTC'\) - \(\$1::bigint \* interval '1 millisecond'\)/g, "datetime('now', '-' || ($1/1000) || ' seconds')")
      .replace(/EXTRACT\(EPOCH FROM (clock_timestamp\(\)|r\."updatedAt")\)/g, 'unixepoch($1)')
      .replace(/clock_timestamp\(\)/g, "datetime('now')")
      .replace(/::(?:jsonb|numeric|boolean|bigint)/g, '')
      .replace(/COALESCE\(r\."desiredState", '\{\}'\) \? '(\w+)'/g, "json_type(r.\"desiredState\", '$.$1') IS NOT NULL")
      .replace(/jsonb_typeof\((.*?)\) = 'number'/g, "json_type($1) IN ('integer','real')")
      .replace(/FOR UPDATE OF r SKIP LOCKED/g, '');
    const args = input.args.map(a => a === 'ENABLED' ? Number(c.enabled) : a === 'EXECUTION' ? c.execution : a);
    const named = Object.fromEntries(args.map((a,i) => ['$'+(i+1),a]));
    const statement = db.prepare(query);
    statement.setReturnArrays(true);
    return {rows:statement.all(named)};
  } catch(error) { return {error:String(error)}; }
  finally { db.close(); }
});
process.stdout.write(JSON.stringify(output));
`

type environmentCase struct {
	Name        string  `json:"name"`
	Enabled     bool    `json:"enabled"`
	Binding     []any   `json:"binding"`
	Environment []any   `json:"environment"`
	State       *string `json:"state,omitempty"`
	Slug        string  `json:"slug"`
	Execution   string  `json:"execution"`
	want        string
}

func Test_ResourceEnvironmentQueries(t *testing.T) {
	prodBinding, prod := []any{"resource", "prod-env", "project", "db"}, []any{"prod-env", "project", "prod"}
	devBinding, dev := []any{"resource", "dev-env", "project", "db"}, []any{"dev-env", "project", "dev"}
	cases := []environmentCase{
		{Name: "unbound-before-activation", want: "legacy"},
		{Name: "unbound-after-activation", Enabled: true, want: "reject"},
		{Name: "bound-prod-default-off", Binding: prodBinding, Environment: prod, want: "prod"},
		{Name: "bound-prod-enabled", Enabled: true, Binding: prodBinding, Environment: prod, want: "prod"},
		{Name: "bound-dev-default-off", Binding: devBinding, Environment: dev, want: "reject"},
		{Name: "bound-dev-enabled", Enabled: true, Binding: devBinding, Environment: dev, want: "dev"},
		{Name: "dangling-binding", Binding: prodBinding, want: "reject"},
		{Name: "partial-binding", Binding: []any{"resource", nil, "project", "db"}, want: "reject"},
		{Name: "foreign-binding", Binding: []any{"resource", "prod-env", "foreign", "db"}, Environment: prod, want: "reject"},
		{Name: "foreign-environment", Binding: prodBinding, Environment: []any{"prod-env", "foreign", "prod"}, want: "reject"},
		{Name: "empty-logical-slug", Binding: []any{"resource", "prod-env", "project", ""}, Environment: prod, want: "reject"},
		{Name: "blank-logical-slug", Binding: []any{"resource", "prod-env", "project", " "}, Environment: prod, want: "reject"},
		{Name: "invalid-kind", Enabled: true, Binding: prodBinding, Environment: []any{"prod-env", "project", "preview"}, want: "reject"},
		{Name: "explicit-dev-state", State: envState("{\"environmentKind\":\"dev\"}"), want: "reject"},
		{Name: "partial-state", State: envState("{\"environmentId\":\"prod-env\"}"), want: "reject"},
		{Name: "null-environment-state", State: envState("{\"environment\":null}"), want: "reject"},
		{Name: "explicit-dev-provider", State: envState("{\"providerIdentity\":{\"namespace\":\"rb-dev-00000000000000000000\",\"name\":\"dev-db\"}}"), want: "reject"},
		{Name: "explicit-dev-physical", Slug: "dev-0000000000-db", want: "reject"},
		{Name: "malformed-state", State: envState("[]"), want: "reject"},
		{Name: "forged-state-cannot-rebind", Enabled: true, Binding: devBinding, Environment: dev, State: envState("{\"environmentKind\":\"prod\",\"namespace\":\"org--project\"}"), want: "dev"},
		{Name: "local-is-not-dev", Execution: "local", want: "legacy"},
		{Name: "release-is-not-prod-binding", Execution: "release", want: "legacy"},
	}
	for i := range cases {
		if cases[i].Slug == "" {
			cases[i].Slug = "db"
		}
		if cases[i].Execution == "" {
			cases[i].Execution = "local"
		}
	}
	for _, query := range []struct {
		name, sql, status string
		args              []any
	}{
		{"provision", claimResourceSQL, StatusProvisioning, []any{StatusProvisioning, StatusReconciling, 60000, 0, "EXECUTION", "{\"postgresql\":\"pinned-image\"}", "ENABLED"}},
		{"health", claimReadyResourceSQL, StatusReady, []any{60000, "ENABLED"}},
		{"deletion", claimResourceDeletionSQL, StatusDeleteRequested, []any{StatusDeleteRequested, StatusDeleting, 60000, 0, "ENABLED"}},
	} {
		t.Run(query.name, func(t *testing.T) {
			// Given: fixed authoritative tables, including deliberately invalid bindings.
			payload, err := json.Marshal(map[string]any{"query": query.sql, "status": query.status, "args": query.args, "cases": cases})
			if err != nil {
				t.Fatal(err)
			}
			node := os.Getenv("RAIBITSERVER_TEST_NODE_BINARY")
			if node == "" {
				node = "node"
			}
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, node, "--disable-warning=ExperimentalWarning", "-e", environmentQueryProbe)
			cmd.Stdin = bytes.NewReader(payload)
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			// When: evaluate the actual SELECT, then decode its actual projected row.
			output, err := cmd.Output()
			if err != nil {
				t.Fatalf("relational probe: %v: %s", err, stderr.String())
			}
			var results []struct {
				Rows  []environmentJSONRow
				Error string
			}
			if err := json.Unmarshal(output, &results); err != nil {
				t.Fatal(err)
			}
			if len(results) != len(cases) {
				t.Fatalf("result count = %d", len(results))
			}
			for i, c := range cases {
				t.Run(c.Name, func(t *testing.T) {
					result := results[i]
					if result.Error != "" {
						t.Fatalf("query failed: %s", result.Error)
					}
					var resource *Resource
					var decodeErr error
					if len(result.Rows) == 1 {
						resource, decodeErr = scanResourceClaim(result.Rows[0], c.Enabled)
					}
					// Then: only an authorized row can cross the claim boundary.
					if c.want == "reject" {
						if resource != nil || (len(result.Rows) != 0 && decodeErr == nil) {
							t.Fatalf("invalid row accepted: %+v", resource)
						}
					} else {
						if decodeErr != nil || resource == nil {
							t.Fatalf("expected %s, rows=%d err=%v", c.want, len(result.Rows), decodeErr)
						}
						if c.want == "legacy" {
							if resource.EnvironmentID != "" || resource.EnvironmentKind != "" || resource.LogicalSlug != "" {
								t.Fatalf("invented identity: %+v", resource)
							}
						} else if resource.EnvironmentID != c.Environment[0] || resource.EnvironmentKind != c.want || resource.LogicalSlug != "db" {
							t.Fatalf("wrong authoritative identity: %+v", resource)
						}
						if resource.ID != "resource" || resource.ProjectID != "project" || resource.Slug != c.Slug || resource.ConnectionSecretName != "legacy-connection" {
							t.Fatalf("physical fields changed: %+v", resource)
						}
					}
					t.Logf("kind=%s enabled=%t binding=%v environment=%v outcome=%s rows=%d error=%v", query.name, c.Enabled, c.Binding, c.Environment, c.want, len(result.Rows), decodeErr)
				})
			}
		})
	}
}

func envState(extra string) *string {
	if extra == "[]" {
		return &extra
	}
	state := strings.TrimSuffix(extra, "}") + ",\"resourceExecution\":{\"intent\":\"live-provision\",\"environment\":\"local\",\"image\":\"pinned-image\"}}"
	return &state
}

// This scanner supplies real SQL projection cells and checks SQL NULL/arity;
// it does not reproduce binding selection or validation.
type environmentJSONRow []json.RawMessage

func (row environmentJSONRow) Scan(dest ...any) error {
	if len(dest) != len(row) {
		return fmt.Errorf("scan arity: got %d want %d", len(dest), len(row))
	}
	for i, value := range row {
		var source any
		if err := json.Unmarshal(value, &source); err != nil {
			return err
		}
		switch target := dest[i].(type) {
		case *sql.NullString:
			if err := target.Scan(source); err != nil {
				return err
			}
		case *[]byte:
			if source != nil {
				*target = []byte(source.(string))
			}
		case *string:
			if source == nil {
				return fmt.Errorf("NULL in string column %d", i)
			}
			if err := json.Unmarshal(value, target); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unsupported destination %T", target)
		}
	}
	return nil
}

func Test_ResourceEnvironmentRecoveryScan(t *testing.T) {
	// Given: the unchanged 16-column recovery resource projection.
	var row environmentJSONRow
	if err := json.Unmarshal([]byte("[\"resource\",\"project\",\"org\",\"project\",\"DB\",\"db\",\"database\",\"postgresql\",\"local\",\"shared-small\",\"local\",null,\"READY\",\"legacy-connection\",\"{}\",\"{}\"]"), &row); err != nil {
		t.Fatal(err)
	}
	// When
	resource, err := scanResource(row)
	// Then
	if err != nil || resource == nil || resource.ConnectionSecretName != "legacy-connection" {
		t.Fatalf("recovery scan contract broken: %+v %v", resource, err)
	}
}

func Test_ResourceEnvironmentDecoderRejectsPartialOrForeignRows(t *testing.T) {
	// Given: an authoritative 23-column projection, independently supplied at the row boundary.
	const valid = `["resource","project","org","project","DB","db","database","postgresql","local","shared-small","local",null,"READY","legacy-connection","{}","{}","prod-env","prod","db","resource","prod-env","project","project"]`
	for _, test := range []struct {
		name   string
		column int
		value  string
	}{
		{"null-id", 16, `null`}, {"null-kind", 17, `null`}, {"null-logical", 18, `null`},
		{"null-subject", 19, `null`}, {"null-binding-environment", 20, `null`}, {"null-binding-project", 21, `null`}, {"null-environment-project", 22, `null`},
		{"foreign-subject", 19, `"foreign"`}, {"stale-environment", 20, `"old-env"`},
		{"foreign-binding-project", 21, `"foreign"`}, {"foreign-environment-project", 22, `"foreign"`},
		{"empty-id", 16, `""`}, {"padded-kind", 17, `" prod "`}, {"padded-logical", 18, `" db "`},
		{"wrong-kind", 17, `"release"`}, {"dev-disabled", 17, `"dev"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			var row environmentJSONRow
			if err := json.Unmarshal([]byte(valid), &row); err != nil {
				t.Fatal(err)
			}
			row[test.column] = json.RawMessage(test.value)
			// When
			resource, err := scanResourceClaim(row, false)
			// Then
			if resource != nil || !errors.Is(err, ErrResourceEnvironment) {
				t.Fatalf("typed rejection required: %+v %v", resource, err)
			}
			t.Logf("column=%d input=%s error=%v", test.column, test.value, err)
		})
	}
}
