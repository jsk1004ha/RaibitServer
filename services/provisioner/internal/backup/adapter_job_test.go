package backup

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func Test_DirectCommand_when_engine_queries_are_opaque_arguments(t *testing.T) {
	// Given: legitimate fixed SQL, Mongo JSON, and Redis Lua/query arguments.
	cases := []struct{ executable, argument string }{
		{"psql", `SELECT count(*) FROM "User" WHERE active = true`},
		{"mongosh", `{"ping": 1, "filter": {"name": "A B"}}`},
		{"redis-cli", `EVAL "return redis.call('DBSIZE')" 0`},
	}
	// When / Then: direct-exec preserves each opaque argument byte-for-byte.
	for _, test := range cases {
		command, err := newDirectCommand(test.executable, test.argument)
		if err != nil || !reflect.DeepEqual(command.Args(), []string{test.argument}) {
			t.Fatalf("command=%+v err=%v", command, err)
		}
	}
}

func Test_DirectCommand_when_shell_or_interpolation_requested(t *testing.T) {
	// Given: shell execution and environment interpolation fragments.
	// When / Then: package-owned command construction refuses both.
	if _, err := newDirectCommand("sh", "-c", "pg_dump"); !errors.Is(err, ErrRecoveryJob) {
		t.Fatalf("shell err=%v", err)
	}
	if _, err := newDirectCommand("pg_dump", "--dbname=$(DATABASE_URL)"); !errors.Is(err, ErrRecoveryJob) {
		t.Fatalf("interpolation err=%v", err)
	}
}

func Test_SecretProjection_when_env_and_readonly_file_are_typed(t *testing.T) {
	// Given: one source Secret projected through two non-plaintext mechanisms.
	ref, err := NewSecretRef("project-1", "source-secret", "DATABASE_URL")
	if err != nil {
		t.Fatal(err)
	}
	env, envErr := NewSecretEnv("DATABASE_URL", ref)
	file, fileErr := NewSecretFile("/var/run/raibit-recovery/mongo/config.json", ref)
	// When / Then: both retain only the reference and the file is immutable.
	if envErr != nil || fileErr != nil || env.Ref() != ref || file.Ref() != ref || !file.ReadOnly() {
		t.Fatalf("env=%+v file=%+v errs=%v/%v", env, file, envErr, fileErr)
	}
}

func Test_NewIsolatedJob_when_image_is_mutable(t *testing.T) {
	// Given: otherwise valid job plans with bare and tagged images.
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	// When / Then: neither mutable image is admitted.
	for _, image := range []string{"postgres", "postgres:16"} {
		spec := testJobSpec(t, connection, StreamStdout)
		spec.Image = image
		if _, err := NewIsolatedJob(spec); !errors.Is(err, ErrRecoveryJob) {
			t.Fatalf("image=%q err=%v", image, err)
		}
	}
}

func Test_NewIsolatedJob_when_endpoint_is_tunneled_through_argv(t *testing.T) {
	// Given: a network endpoint and SQLite path copied into adapter argv.
	network := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	sqlite := testSQLiteConnection(t, "sqlite", "tenant/source.sqlite")
	for _, test := range []struct {
		connection Connection
		argument   string
	}{{network, "--host=source.db.internal"}, {sqlite, "--database=tenant/source.sqlite"}} {
		spec := testJobSpec(t, test.connection, StreamStdout)
		command, err := newDirectCommand("recovery-tool", test.argument)
		if err != nil {
			t.Fatal(err)
		}
		spec.Steps[0], err = newCommandStep(command, StreamStdout)
		if err != nil {
			t.Fatal(err)
		}
		// When / Then: runner configuration must use the tagged endpoint instead.
		if _, jobErr := NewIsolatedJob(spec); !errors.Is(jobErr, ErrRecoveryJob) {
			t.Fatalf("argument=%q err=%v", test.argument, jobErr)
		}
	}
}

func Test_NewIsolatedJob_when_runtime_is_projected(t *testing.T) {
	// Given: a digest-pinned job bound to one network endpoint and fence.
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	// When: its runner-facing contract is inspected.
	security := job.Security()
	policy, ok := job.NetworkPolicy().(EndpointEgressPolicy)
	// Then: all mandatory controls and only the intended endpoint are encoded.
	if !security.RunAsNonRoot() || !security.ReadOnlyRootFilesystem() || security.AllowPrivilegeEscalation() || security.AutomountServiceAccountToken() || !security.DropAllCapabilities() || security.RunAsUser() != 65532 {
		t.Fatalf("security=%+v", security)
	}
	if !ok || !policy.DefaultDeny() || policy.Host() != "source.db.internal" || policy.Port() != 5432 {
		t.Fatalf("policy=%+v", job.NetworkPolicy())
	}
	if job.Fence().OperationID() != "operation-1" || job.Fence().Attempt() != 2 || job.Labels()["raibitserver.io/resource"] != "source" {
		t.Fatalf("fence=%+v labels=%v", job.Fence(), job.Labels())
	}
	spec := job.Spec()
	if spec.CPUMilli != 100 || spec.MemoryMiB != 128 || spec.EphemeralMiB != 256 || spec.Deadline != time.Minute {
		t.Fatalf("limits=%+v", spec)
	}
}

func Test_NewIsolatedJob_when_multiple_steps_bind_stream_explicitly(t *testing.T) {
	// Given: a verification step with no artifact binding and one dump step.
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	spec := testJobSpec(t, connection, StreamStdout)
	verify, err := newDirectCommand("psql", "SELECT count(*) FROM records")
	if err != nil {
		t.Fatal(err)
	}
	verifyStep, err := newCommandStep(verify, StreamNone)
	if err != nil {
		t.Fatal(err)
	}
	spec.Steps = append([]CommandStep{verifyStep}, spec.Steps...)
	// When: the multi-step plan is constructed.
	job, err := NewIsolatedJob(spec)
	// Then: step order and none/stdout bindings remain explicit.
	if err != nil || len(job.Spec().Steps) != 2 || job.Spec().Steps[0].Binding() != StreamNone || job.Spec().Steps[1].Binding() != StreamStdout {
		t.Fatalf("steps=%+v err=%v", job.Spec().Steps, err)
	}
}

func Test_NewIsolatedJob_when_SQLite_is_volume_only(t *testing.T) {
	// Given: a SQLite job bound to a normalized provider-volume endpoint.
	connection := testSQLiteConnection(t, "source", "tenant/source.sqlite")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	// When: the network/volume policy is inspected.
	policy, ok := job.NetworkPolicy().(VolumeOnlyPolicy)
	// Then: it names only the provider root and denies all egress.
	if !ok || !policy.DefaultDeny() || policy.AllowsEgress() || policy.Volume() != "provider-data" || policy.Root() != "sqlite-root" {
		t.Fatalf("policy=%+v", job.NetworkPolicy())
	}
}

func testJobSpec(t *testing.T, connection Connection, binding StreamBinding) IsolatedJobSpec {
	t.Helper()
	command, err := newDirectCommand("recovery-tool", "--fixed-query", "SELECT (1 + 1)")
	if err != nil {
		t.Fatal(err)
	}
	step, err := newCommandStep(command, binding)
	if err != nil {
		t.Fatal(err)
	}
	spec := IsolatedJobSpec{Namespace: "project-1", Image: testImage, OperationID: "operation-1", Attempt: 2, Connection: connection, Steps: []CommandStep{step}, RunAsUser: 65532, CPUMilli: 100, MemoryMiB: 128, EphemeralMiB: 256, Deadline: time.Minute}
	if connection.Engine() != EngineSQLite {
		env, envErr := NewSecretEnv("DATABASE_URL", connection.spec.Secret)
		if envErr != nil {
			t.Fatal(envErr)
		}
		spec.Secrets = []SecretEnv{env}
	}
	return spec
}

func Test_NewSecretFile_when_path_escapes_projection_root(t *testing.T) {
	// Given: a valid Secret and path aliases outside the owned mount.
	ref, err := NewSecretRef("project-1", "source-secret", "DATABASE_URL")
	if err != nil {
		t.Fatal(err)
	}
	// When / Then: traversal and sibling roots are rejected.
	for _, candidate := range []string{"/var/run/raibit-recovery/../token", "/etc/token", strings.Repeat("a", 2)} {
		if _, fileErr := NewSecretFile(candidate, ref); !errors.Is(fileErr, ErrRecoveryJob) {
			t.Fatalf("path=%q err=%v", candidate, fileErr)
		}
	}
}
