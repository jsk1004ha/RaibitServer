package backup

import (
	"errors"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/store"
)

func testToolPolicy(t *testing.T) RecoveryToolPolicy {
	t.Helper()
	env := make(map[string]string)
	for i, engine := range []string{"POSTGRESQL", "MYSQL", "MARIADB", "MONGODB", "REDIS", "VALKEY"} {
		env["RAIBITSERVER_RECOVERY_TOOL_"+engine+"_IMAGE"] = "registry.example/recovery/" + strings.ToLower(engine) + "@sha256:" + strings.Repeat(string(rune('1'+i)), 64)
	}
	policy, err := ParseRecoveryToolPolicy(env)
	if err != nil {
		t.Fatal(err)
	}
	return policy
}

func testRecoveryExecution() store.RecoveryExecution {
	credentialGeneration := strings.Repeat("g", 43)
	metadata := store.RecoveryResourceMetadata{
		ID: "source", ProjectID: "project-1", Engine: "postgresql", Provider: "raibitserver", Version: "16.4",
		Namespace: "tenant", Name: "source-provider", SecretName: "source-provider-connection", SecretUID: "secret-uid", SecretGeneration: credentialGeneration,
		Image: testImage, WorkloadUID: "workload-uid", WorkloadGeneration: 7, Generation: testGeneration,
		Connection: store.RecoveryConnectionProjection{Host: "source-provider.tenant.svc.cluster.local", Port: 5432, Database: "app", User: "source_provider_app", SecretNamespace: "tenant", SecretName: "source-provider-connection", SecretKey: "PGPASSWORD", CredentialUID: "secret-uid", CredentialGeneration: credentialGeneration},
	}
	return store.RecoveryExecution{Identity: store.RecoveryIdentity{OperationID: "operation-1", OrganizationID: "org-1", ProjectID: "project-1", SourceID: "source", Attempt: 2}, Source: metadata}
}

func Test_BindRecoverySource_when_snapshot_and_policy_are_exact(t *testing.T) {
	connection, err := BindRecoverySource(testRecoveryExecution(), testToolPolicy(t))
	if err != nil || connection.spec.Secret.Key() != "PGPASSWORD" || connection.spec.Provenance.spec.CredentialUID != "secret-uid" {
		t.Fatalf("connection=%+v err=%v", connection.spec, err)
	}
	spec := testJobSpec(t, connection, StreamStdout)
	spec.Namespace = "tenant"
	if _, err = NewIsolatedJob(spec); err != nil {
		t.Fatalf("trusted snapshot did not compose into a job: %v", err)
	}
}

func Test_ParseRecoveryToolPolicy_when_image_is_mutable(t *testing.T) {
	if _, err := ParseRecoveryToolPolicy(map[string]string{"RAIBITSERVER_RECOVERY_TOOL_POSTGRESQL_IMAGE": "postgres:16"}); !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("mutable recovery tool image accepted: %v", err)
	}
}

func Test_ParseRequiredRecoveryToolPolicy_when_enabled_engine_image_is_missing(t *testing.T) {
	if _, err := ParseRequiredRecoveryToolPolicy(map[string]string{"RAIBITSERVER_RECOVERY_TOOL_POSTGRESQL_IMAGE": "registry.example/recovery/postgresql@sha256:" + strings.Repeat("1", 64)}); !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("partial enabled policy accepted: %v", err)
	}
}

func Test_BindRecoverySource_when_credential_projection_is_stale_or_wrong_key(t *testing.T) {
	for _, mutate := range []func(*store.RecoveryExecution){
		func(value *store.RecoveryExecution) { value.Source.Connection.SecretKey = "DATABASE_URL" },
		func(value *store.RecoveryExecution) { value.Source.Connection.CredentialUID = "stale-secret-uid" },
		func(value *store.RecoveryExecution) {
			value.Source.Connection.CredentialGeneration = strings.Repeat("s", 43)
		},
	} {
		execution := testRecoveryExecution()
		mutate(&execution)
		if _, err := BindRecoverySource(execution, testToolPolicy(t)); !errors.Is(err, ErrRecoveryRequest) {
			t.Fatalf("forged projection accepted: %+v err=%v", execution.Source.Connection, err)
		}
	}
}

func Test_NewIsolatedJob_when_image_is_not_approved_for_bound_engine(t *testing.T) {
	connection, err := BindRecoverySource(testRecoveryExecution(), testToolPolicy(t))
	if err != nil {
		t.Fatal(err)
	}
	spec := testJobSpec(t, connection, StreamStdout)
	spec.Namespace = "tenant"
	spec.Image = "registry.example/unrelated@sha256:" + strings.Repeat("f", 64)
	if _, err = NewIsolatedJob(spec); !errors.Is(err, ErrRecoveryJob) {
		t.Fatalf("unrelated digest-pinned image accepted: %v", err)
	}
}

func Test_BindRecoverySource_when_tool_image_aliases_provider_workload(t *testing.T) {
	execution := testRecoveryExecution()
	policy := RecoveryToolPolicy{images: map[Engine]string{EnginePostgreSQL: execution.Source.Image}}
	if _, err := BindRecoverySource(execution, policy); !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("provider workload image accepted as recovery tool: %v", err)
	}
}

func Test_NewIsolatedJob_when_same_secret_object_uses_unapproved_key(t *testing.T) {
	connection, err := BindRecoverySource(testRecoveryExecution(), testToolPolicy(t))
	if err != nil {
		t.Fatal(err)
	}
	spec := testJobSpec(t, connection, StreamStdout)
	spec.Namespace = "tenant"
	wrongKey, err := NewSecretRef("tenant", "source-provider-connection", "DATABASE_URL")
	if err != nil {
		t.Fatal(err)
	}
	spec.Secrets = []SecretEnv{{name: "DATABASE_URL", ref: wrongKey}}
	if _, err = NewIsolatedJob(spec); !errors.Is(err, ErrRecoveryJob) {
		t.Fatalf("same Secret with wrong key accepted: %v", err)
	}
}

func Test_BindRecoverySource_when_SQLite_has_no_operator_volume_authority(t *testing.T) {
	execution := testRecoveryExecution()
	execution.Source.Engine = "sqlite"
	if _, err := BindRecoverySource(execution, testToolPolicy(t)); !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("SQLite without volume authority accepted: %v", err)
	}
}
