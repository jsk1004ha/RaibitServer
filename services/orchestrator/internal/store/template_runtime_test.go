package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestTemplateRuntimeLoad_uses_lock_compatible_transaction(t *testing.T) {
	// Given: a database/sql boundary recorder, not a PostgreSQL implementation.
	connection := &templateSQLConnection{}
	db := sql.OpenDB(templateSQLConnector{connection})
	defer db.Close()
	// When
	_, err := NewPostgresStore(db).LoadTemplateRuntimeInputs(context.Background(), DeploymentLease{DeploymentID: "d", WorkerID: "w", Attempt: 1, Action: DeploymentActionApply}, 15*time.Minute)
	// Then
	if err != nil || connection.options.ReadOnly || connection.options.Isolation != driver.IsolationLevel(sql.LevelReadCommitted) {
		t.Fatalf("row-lock transaction must be read/write READ COMMITTED: options=%+v err=%v", connection.options, err)
	}
}

func TestTemplateRuntimeLoad_fences_live_authority_at_SQL_boundary(t *testing.T) {
	for _, scenario := range []string{"expired", "reclaimed", "service deleting", "project deleting", "expires during read"} {
		t.Run(scenario, func(t *testing.T) {
			// Given: explicit SQL-boundary simulation; native predicates need PostgreSQL.
			connection := &templateSQLConnection{scenario: scenario}
			db := sql.OpenDB(templateSQLConnector{connection})
			defer db.Close()
			// When
			_, err := NewPostgresStore(db).LoadTemplateRuntimeInputs(context.Background(), DeploymentLease{DeploymentID: "d", WorkerID: "w", Attempt: 1, Action: DeploymentActionApply}, 15*time.Minute)
			// Then
			if !errors.Is(err, ErrDeploymentLeaseLost) || connection.committed {
				t.Fatalf("%s authority accepted: err=%v committed=%t", scenario, err, connection.committed)
			}
		})
	}
}

func TestTemplateRuntimeLoad_locks_scoped_parents_resources_and_secrets(t *testing.T) {
	// SQL contract checks complement the driver boundary tests; they do not execute PostgreSQL predicates.
	for query, fragments := range map[string][]string{
		templateRuntimeAuthoritySQL: {`s."projectId"=d."projectId"`, `b."projectId"=s."projectId"`, `b."environmentId"=d."environmentId"`, `e."projectId"=b."projectId"`, `d.status=$2`, `d."reconcileLockedBy"=$3`, `d."reconcileAttempts"=$4`, `d."reconcileAction"=$5`, `clock_timestamp() AT TIME ZONE 'UTC'`, `s."deletionRequestedAt" IS NULL`, `p."deletionRequestedAt" IS NULL`, `e.status='active'`, `FOR SHARE OF d,s,p,b,e`},
		templateRuntimeResourceSQL:  {`r.id=$1`, `r."projectId"=$2`, `b."environmentId"=$3`, `b."logicalSlug"=$4`, `r.status='READY'`, `r."deletionRequestedAt" IS NULL`, `recoveryPublicationBlocked`, `recoveryPrepared`, `ResourceRecoveryPin`, `FOR SHARE OF r,b`},
		templateRuntimeSecretSQL:    {`id=$1`, `"scopeType"='project'`, `"scopeId"=$2`, `FOR SHARE`},
	} {
		for _, fragment := range fragments {
			if !strings.Contains(query, fragment) {
				t.Errorf("runtime input query missing %q", fragment)
			}
		}
	}
}

func TestTemplateRuntimeLoad_resolves_only_ready_bound_resources_and_environment_secrets(t *testing.T) {
	for _, scenario := range []string{"valid", "missing resource binding", "resource not ready", "provider secret mismatch", "missing provider key", "invalid provider name", "wrong environment secret", "missing secret", "oversized secret"} {
		t.Run(scenario, func(t *testing.T) {
			resource := []driver.Value{"READY", "database-connection", []byte(`{"providerConnection":{"secretName":"database-connection","environmentKeys":["DATABASE_URL"]}}`)}
			secret := []driver.Value{"sealed-fixture", []byte(`{"environmentId":"e"}`)}
			want := error(nil)
			switch scenario {
			case "missing resource binding", "resource not ready", "provider secret mismatch", "missing provider key", "invalid provider name":
				want = ErrTemplateRuntimeResource
			case "wrong environment secret", "missing secret", "oversized secret":
				want = ErrTemplateRuntimeScope
			}
			switch scenario {
			case "resource not ready":
				resource[0] = "PROVISIONING"
			case "provider secret mismatch":
				resource[1] = "different-connection"
			case "missing provider key":
				resource[2] = []byte(`{"providerConnection":{"secretName":"database-connection","environmentKeys":["PASSWORD"]}}`)
			case "invalid provider name":
				resource[1] = "invalid/name"
				resource[2] = []byte(`{"providerConnection":{"secretName":"invalid/name","environmentKeys":["DATABASE_URL"]}}`)
			case "wrong environment secret":
				secret[1] = []byte(`{"environmentId":"other-environment"}`)
			case "oversized secret":
				secret[0] = strings.Repeat("s", maxTemplateSealedValue+1)
			}
			connection := &templateSQLConnection{}
			connection.query = func(query string, args []driver.NamedValue) (driver.Rows, error) {
				switch query {
				case templateRuntimeAuthoritySQL:
					return &templateSQLRows{values: []driver.Value{"p", "s", "e", "prod", []byte(`{"sourceType":"template","source":{"type":"template"},"environmentId":"e","secretRefs":[{"name":"TOKEN","secretRef":"secret:secret-a"}],"resourceDependencies":[{"name":"DATABASE_URL","resourceLogicalSlug":"postgres","secretKey":"DATABASE_URL"}],"templateResourceBindings":[{"resourceId":"resource-a","resourceLogicalSlug":"postgres"}]}`)}}, nil
				case templateRuntimeResourceSQL:
					if len(args) != 4 || args[0].Value != "resource-a" || args[1].Value != "p" || args[2].Value != "e" || args[3].Value != "postgres" {
						t.Fatalf("resource scope arguments: %#v", args)
					}
					return &templateSQLRows{done: scenario == "missing resource binding", values: resource}, nil
				case templateRuntimeSecretSQL:
					if len(args) != 2 || args[0].Value != "secret-a" || args[1].Value != "p" {
						t.Fatalf("secret scope arguments: %#v", args)
					}
					return &templateSQLRows{done: scenario == "missing secret", values: secret}, nil
				default:
					t.Fatalf("unexpected query: %s", query)
					return nil, errors.New("unexpected query")
				}
			}
			db := sql.OpenDB(templateSQLConnector{connection})
			defer db.Close()
			inputs, err := NewPostgresStore(db).LoadTemplateRuntimeInputs(context.Background(), DeploymentLease{DeploymentID: "d", WorkerID: "w", Attempt: 1, Action: DeploymentActionApply}, time.Minute)
			if !errors.Is(err, want) || connection.committed != (want == nil) {
				t.Fatalf("input resolution: err=%v want=%v committed=%t", err, want, connection.committed)
			}
			if want == nil && (inputs.ProjectID != "p" || inputs.EnvironmentID != "e" || inputs.ServiceID != "s" || inputs.DeploymentID != "d" || len(inputs.ResourceRefs) != 1 || inputs.ResourceRefs[0].SecretName != "database-connection" || len(inputs.SealedSecrets) != 1 || inputs.SealedSecrets[0].SealedValue != "sealed-fixture") {
				t.Fatal("resolved runtime input identities were not preserved")
			}
		})
	}
}

func TestTemplateSecretCollection_fences_scope_and_live_producers_at_SQL_boundary(t *testing.T) {
	for _, fragment := range []string{`b."projectId"=p.id`, `e."projectId"=p.id`, `p.id=$1 AND e.id=$2 AND s.id=$3`, `LEFT JOIN "Deployment" d ON d.id=$4`, `d.id IS NULL OR`, `d."projectId"=p.id`, `d."environmentId"=e.id`, `d."serviceId"=s.id`, `d.status='DEPLOYING'`, `$5::bigint`, `clock_timestamp() AT TIME ZONE 'UTC'`} {
		if !strings.Contains(templateSecretCollectibleSQL, fragment) {
			t.Errorf("secret collection query missing %q", fragment)
		}
	}
	for _, collectible := range []bool{false, true} {
		connection := &templateSQLConnection{query: func(query string, args []driver.NamedValue) (driver.Rows, error) {
			if query != templateSecretCollectibleSQL || len(args) != 5 || args[0].Value != "p" || args[1].Value != "e" || args[2].Value != "s" || args[3].Value != "d" || args[4].Value != int64(900000) {
				t.Fatalf("collection query lost scope or default duration: %#v", args)
			}
			return &templateSQLRows{values: []driver.Value{collectible}}, nil
		}}
		db := sql.OpenDB(templateSQLConnector{connection})
		defer db.Close()
		got, err := NewPostgresStore(db).TemplateSecretCollectible(context.Background(), "p", "e", "s", "d", 0)
		if err != nil || got != collectible {
			t.Fatalf("collection authority=%t want=%t err=%v", got, collectible, err)
		}
		got, err = NewPostgresStore(db).TemplateSecretCollectible(context.Background(), "p", "", "s", "d", 0)
		if got || !errors.Is(err, ErrTemplateRuntimeScope) || connection.reads != 1 {
			t.Fatalf("missing collection scope accepted: %t %v", got, err)
		}
	}
}

type templateSQLConnector struct{ connection *templateSQLConnection }

func (c templateSQLConnector) Connect(context.Context) (driver.Conn, error) { return c.connection, nil }
func (c templateSQLConnector) Driver() driver.Driver                        { return templateSQLDriver{} }

type templateSQLDriver struct{}

func (templateSQLDriver) Open(string) (driver.Conn, error) { return nil, errors.New("use connector") }

type templateSQLConnection struct {
	options   driver.TxOptions
	scenario  string
	reads     int
	committed bool
	query     func(string, []driver.NamedValue) (driver.Rows, error)
}

func (c *templateSQLConnection) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepare")
}
func (c *templateSQLConnection) Close() error              { return nil }
func (c *templateSQLConnection) Begin() (driver.Tx, error) { return c, nil }
func (c *templateSQLConnection) BeginTx(_ context.Context, options driver.TxOptions) (driver.Tx, error) {
	c.options = options
	return c, nil
}
func (c *templateSQLConnection) Commit() error   { c.committed = true; return nil }
func (c *templateSQLConnection) Rollback() error { return nil }
func (c *templateSQLConnection) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}
func (c *templateSQLConnection) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.reads++
	if c.query != nil {
		return c.query(query, args)
	}
	reject := false
	switch c.scenario {
	case "expired", "expires during read":
		reject = strings.Contains(query, `d."reconcileLockedAt"`) && strings.Contains(query, "clock_timestamp()") && len(args) == 6 && args[5].Value == int64((15*time.Minute)/time.Millisecond)
		if c.scenario == "expires during read" {
			reject = reject && c.reads > 1
		}
	case "reclaimed":
		reject = strings.Contains(query, `d."reconcileAttempts"=$4`) && args[3].Value == int64(1)
	case "service deleting":
		reject = strings.Contains(query, "UPPER(s.status) NOT IN")
	case "project deleting":
		reject = strings.Contains(query, "UPPER(p.status) NOT IN")
	}
	return &templateSQLRows{done: reject}, nil
}

type templateSQLRows struct {
	done   bool
	values []driver.Value
}

func (r *templateSQLRows) Columns() []string {
	if r.values != nil {
		return make([]string, len(r.values))
	}
	return []string{"project", "service", "environment", "kind", "snapshot"}
}
func (*templateSQLRows) Close() error { return nil }
func (r *templateSQLRows) Next(values []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	if r.values != nil {
		copy(values, r.values)
		return nil
	}
	copy(values, []driver.Value{"p", "s", "e", "prod", []byte(`{"sourceType":"template","source":{"type":"template"},"environmentId":"e"}`)})
	return nil
}

func TestTemplateRuntimeSnapshot_parses_only_bounded_reference_contract(t *testing.T) {
	// Given
	raw := json.RawMessage(`{"sourceType":"template","source":{"type":"template"},"environmentId":"env-a","secretRefs":[{"name":"TOKEN","secretRef":"secret:secret-a"}],"resourceDependencies":[{"name":"DATABASE_URL","resourceLogicalSlug":"postgres","secretKey":"DATABASE_URL"}],"templateResourceBindings":[{"resourceId":"resource-a","resourceLogicalSlug":"postgres"}]}`)

	// When
	refs, template, err := decodeTemplateRuntimeSnapshot(raw)

	// Then
	if err != nil || !template || refs.environmentID != "env-a" || len(refs.secrets) != 1 || len(refs.resources) != 1 {
		t.Fatalf("unexpected parsed references: refs=%#v template=%t err=%v", refs, template, err)
	}
	if refs.secrets[0].secretID != "secret-a" || refs.resources[0].resourceID != "resource-a" {
		t.Fatalf("stored reference identity was not preserved: %#v", refs)
	}
}

func TestTemplateRuntimeSnapshot_rejects_malformed_duplicate_and_unbound_references(t *testing.T) {
	// Given
	cases := []json.RawMessage{
		json.RawMessage(`{"sourceType":"template","source":{"type":"template"},"environmentId":"env-a","secretRefs":[{"name":"TOKEN","secretRef":"raw-value"}]}`),
		json.RawMessage(`{"sourceType":"template","source":{"type":"template"},"environmentId":"env-a","secretRefs":[{"name":"TOKEN","secretRef":"secret:a"},{"name":"TOKEN","secretRef":"secret:b"}]}`),
		json.RawMessage(`{"sourceType":"template","source":{"type":"template"},"environmentId":"env-a","resourceDependencies":[{"name":"DATABASE_URL","resourceLogicalSlug":"postgres","secretKey":"DATABASE_URL"}],"templateResourceBindings":[]}`),
	}

	for index, raw := range cases {
		// When
		_, template, err := decodeTemplateRuntimeSnapshot(raw)

		// Then
		if !template || !errors.Is(err, ErrTemplateRuntimeSnapshot) {
			t.Fatalf("case %d accepted malformed template references: %v", index, err)
		}
	}
}

func TestTemplateRuntimeSnapshot_rejects_invalid_or_oversized_JSON_without_marker_bypass(t *testing.T) {
	for _, raw := range []string{
		`{"sourceType": "template", "source": {"type": "template"}`,
		`{"sourceType": "template", "source": {"type": "template"}, "padding":"` + strings.Repeat("x", maxTemplateRuntimeSnapshot) + `"}`,
	} {
		if _, _, err := decodeTemplateRuntimeSnapshot(json.RawMessage(raw)); !errors.Is(err, ErrTemplateRuntimeSnapshot) {
			t.Fatalf("invalid or oversized snapshot accepted: %v", err)
		}
	}
}

func TestTemplateSecretEnvironment_rejects_wrong_environment_and_legacy_dev(t *testing.T) {
	// Given / When / Then
	if err := validateTemplateSecretEnvironment(json.RawMessage(`{"environmentId":"env-b"}`), "env-a", "prod"); !errors.Is(err, ErrTemplateRuntimeScope) {
		t.Fatalf("wrong environment accepted: %v", err)
	}
	if err := validateTemplateSecretEnvironment(nil, "env-a", "dev"); !errors.Is(err, ErrTemplateRuntimeScope) {
		t.Fatalf("legacy metadata omission accepted for dev: %v", err)
	}
	if err := validateTemplateSecretEnvironment(nil, "env-a", "prod"); err != nil {
		t.Fatalf("legacy prod metadata rejected: %v", err)
	}
}

func TestOpenTemplateSealedSecret_decrypts_existing_AES256GCM_format_without_error_disclosure(t *testing.T) {
	// Given
	key := "task9-test-encryption-key-material-32-bytes"
	t.Setenv("ENCRYPTION_KEY", key)
	t.Setenv("RAIBITSERVER_SECRET_ENCRYPTION_KEY", "")
	plaintext := "fixture-value-never-in-error"
	sealed := sealTemplateFixture(t, key, plaintext)

	// When
	opened, err := OpenTemplateSealedSecret(sealed)

	// Then
	if err != nil || string(opened) != plaintext {
		t.Fatalf("decrypt fixture: value=%q err=%v", string(opened), err)
	}
	t.Setenv("ENCRYPTION_KEY", strings.Repeat("z", 32))
	_, err = OpenTemplateSealedSecret(sealed)
	if !errors.Is(err, ErrTemplateRuntimeSecret) || strings.Contains(err.Error(), plaintext) || strings.Contains(err.Error(), sealed) {
		t.Fatalf("wrong-key error disclosed secret material or lost type: %v", err)
	}
}

func TestOpenTemplateSealedSecret_requires_configured_key_without_dev_fallback(t *testing.T) {
	// Given
	t.Setenv("ENCRYPTION_KEY", "")
	t.Setenv("RAIBITSERVER_SECRET_ENCRYPTION_KEY", "short")

	// When
	_, err := OpenTemplateSealedSecret("aes256gcm:v1:bad:bad:bad")

	// Then
	if !errors.Is(err, ErrTemplateRuntimeKey) {
		t.Fatalf("short configured key accepted: %v", err)
	}
}

func sealTemplateFixture(t *testing.T, key, plaintext string) string {
	t.Helper()
	digest := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(digest[:])
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		t.Fatal(err)
	}
	ciphertext := gcm.Seal(nil, iv, []byte(plaintext), nil)
	tagOffset := len(ciphertext) - gcm.Overhead()
	encode := base64.RawURLEncoding.EncodeToString
	return "aes256gcm:v1:" + encode(iv) + ":" + encode(ciphertext[tagOffset:]) + ":" + encode(ciphertext[:tagOffset])
}
