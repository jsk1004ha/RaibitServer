package backup

import (
	"errors"
	"fmt"
	"testing"
)

func Test_EndpointProjection_when_connection_is_bound(t *testing.T) {
	// Given: database and indexed network connections with distinct typed fields.
	database := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	index := uint16(7)
	indexedEndpoint, err := NewNetworkEndpoint(NetworkEndpointSpec{Host: "cache.internal", Port: 6379, User: "cache-user", Index: &index})
	if err != nil {
		t.Fatal(err)
	}
	indexedSpec := database.spec
	indexedSpec.Engine = EngineVersion{Engine: EngineRedis, Version: "7.2"}
	indexedSpec.Endpoint = indexedEndpoint
	indexed, err := newConnection(indexedSpec, database.toolImage, database.operationID, database.attempt)
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name                         string
		connection                   Connection
		host, database, username     string
		port, index                  uint16
		hasIndex                     bool
	}{
		{name: "database", connection: database, host: "source.db.internal", port: 5432, database: "app", username: "provider"},
		{name: "indexed", connection: indexed, host: "cache.internal", port: 6379, username: "cache-user", index: 7, hasIndex: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// When: the bound connection becomes a recovery job.
			job, jobErr := NewIsolatedJob(testJobSpec(t, test.connection, StreamStdout))
			if jobErr != nil {
				t.Fatal(jobErr)
			}
			projection, ok := job.EndpointProjection()
			gotIndex, hasIndex := projection.Index()

			// Then: only the typed network fields are exposed, including index presence.
			if !ok || projection.Host() != test.host || projection.Port() != test.port || projection.Database() != test.database || projection.Username() != test.username || gotIndex != test.index || hasIndex != test.hasIndex {
				t.Fatalf("projection=%+v index=%d/%v", projection, gotIndex, hasIndex)
			}
		})
	}
}

func Test_NewIsolatedJob_when_endpoint_projection_is_in_command_tokens(t *testing.T) {
	// Given: a bound network endpoint whose individual fields are copied into argv.
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	for _, value := range []string{"source.db.internal", "5432", "app", "provider"} {
		t.Run(value, func(t *testing.T) {
			spec := testJobSpec(t, connection, StreamStdout)
			command, err := newDirectCommand("recovery-tool", "--fixed", value)
			if err != nil {
				t.Fatal(err)
			}
			spec.Steps[0], err = newCommandStep(command, StreamStdout)
			if err != nil {
				t.Fatal(err)
			}

			// When: the job boundary checks command tokens.
			_, jobErr := NewIsolatedJob(spec)

			// Then: every endpoint field is rejected from argv.
			if !errors.Is(jobErr, ErrRecoveryJob) {
				t.Fatalf("endpoint field %q reached argv: %v", value, jobErr)
			}
		})
	}
}

func Test_NewIsolatedJob_when_endpoint_projection_is_command_executable(t *testing.T) {
	// Given: a bound endpoint host copied into argv[0].
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	spec := testJobSpec(t, connection, StreamStdout)
	command, err := newDirectCommand("source.db.internal")
	if err != nil {
		t.Fatal(err)
	}
	spec.Steps[0], err = newCommandStep(command, StreamStdout)
	if err != nil {
		t.Fatal(err)
	}

	// When: the complete direct-exec argv is bound to the job.
	_, jobErr := NewIsolatedJob(spec)

	// Then: endpoint identity is rejected from argv[0] as well as arguments.
	if !errors.Is(jobErr, ErrRecoveryJob) {
		t.Fatalf("endpoint executable accepted: %v", jobErr)
	}
}

func Test_NewIsolatedJob_when_secret_shadows_endpoint_projection(t *testing.T) {
	// Given: Secret refs attempting to replace server-owned endpoint env fields.
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	for _, name := range []string{"RAIBIT_RECOVERY_HOST", "RAIBIT_RECOVERY_PORT", "RAIBIT_RECOVERY_DATABASE", "RAIBIT_RECOVERY_USERNAME", "RAIBIT_RECOVERY_INDEX"} {
		t.Run(name, func(t *testing.T) {
			spec := testJobSpec(t, connection, StreamStdout)
			secret, err := NewSecretEnv(name, connection.spec.Secret)
			if err != nil {
				t.Fatal(err)
			}
			spec.Secrets = []SecretEnv{secret}

			// When: the job binds plain endpoint fields and Secret refs.
			_, jobErr := NewIsolatedJob(spec)

			// Then: reserved projection names cannot be shadowed by credentials.
			if !errors.Is(jobErr, ErrRecoveryJob) {
				t.Fatalf("reserved env %q accepted: %v", name, jobErr)
			}
		})
	}
}

func Test_SharedScratch_when_job_is_bounded(t *testing.T) {
	// Given: a job with a bounded ephemeral storage allowance.
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}

	// When: the shared staging contract is inspected.
	scratch := job.SharedScratch()

	// Then: its identity, deterministic path, and limit are typed and bounded by the job.
	if scratch.Name() != "recovery-scratch" || scratch.MountPath() != "/var/run/raibit-recovery/scratch" || scratch.SizeMiB() != 256 || scratch.SizeLimit() != fmt.Sprintf("%dMi", job.Spec().EphemeralMiB) {
		t.Fatalf("scratch=%+v", scratch)
	}
}

func Test_NewIsolatedJob_when_secret_file_shadows_shared_scratch(t *testing.T) {
	// Given: credential files targeting the scratch root or one of its descendants.
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	for _, mountPath := range []string{"/var/run/raibit-recovery/scratch", "/var/run/raibit-recovery/scratch/credential"} {
		t.Run(mountPath, func(t *testing.T) {
			spec := testJobSpec(t, connection, StreamStdout)
			secretFile, err := NewSecretFile(mountPath, connection.spec.Secret)
			if err != nil {
				t.Fatal(err)
			}
			spec.Secrets = nil
			spec.SecretFiles = []SecretFile{secretFile}

			// When: the credential projection is bound beside shared scratch.
			_, jobErr := NewIsolatedJob(spec)

			// Then: no Secret mount can shadow the deterministic read-write volume.
			if !errors.Is(jobErr, ErrRecoveryJob) {
				t.Fatalf("scratch shadow %q accepted: %v", mountPath, jobErr)
			}
		})
	}
}
