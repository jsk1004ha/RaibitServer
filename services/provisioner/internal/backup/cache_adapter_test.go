package backup

import (
	"context"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"
	"time"
)

type cacheRun struct {
	job   IsolatedJob
	input string
}

type cacheRunner struct {
	runs []cacheRun
	fail error
}

func (r *cacheRunner) Run(ctx context.Context, job IsolatedJob, stream JobStream) (completedJobObservation, error) {
	if err := ctx.Err(); err != nil {
		return completedJobObservation{}, err
	}
	if r.fail != nil {
		return completedJobObservation{}, r.fail
	}
	run := cacheRun{job: job}
	if bindingMatches(job, dumpDirection) {
		if _, err := io.WriteString(stream.Output(), "rdb"); err != nil {
			return completedJobObservation{}, err
		}
	} else {
		payload, err := io.ReadAll(stream.Input())
		if err != nil {
			return completedJobObservation{}, err
		}
		run.input = string(payload)
	}
	r.runs = append(r.runs, run)
	return completedHelperJob(job, "cache-job")
}

func cacheConnection(t *testing.T, engine Engine, resource, host, version string) Connection {
	t.Helper()
	generation, err := NewSourceGeneration(testGeneration)
	if err != nil {
		t.Fatal(err)
	}
	provenance, err := NewProviderProvenance(ProviderProvenanceSpec{
		Namespace: "project-1", Name: resource + "-provider", UID: resource + "-uid",
		CredentialUID: resource + "-credential", CredentialGeneration: strings.Repeat("g", 43),
		Generation: 7, Image: testImage,
	})
	if err != nil {
		t.Fatal(err)
	}
	index := uint16(3)
	endpoint, err := NewNetworkEndpoint(NetworkEndpointSpec{Host: host, Port: 6379, User: "cache-user", Index: &index})
	if err != nil {
		t.Fatal(err)
	}
	secret, err := NewSecretRef("project-1", resource+"-secret", "CACHE_PASSWORD")
	if err != nil {
		t.Fatal(err)
	}
	connection, err := newConnection(ConnectionSpec{
		OrganizationID: "org-1", ProjectID: "project-1", ResourceID: resource,
		Engine: EngineVersion{Engine: engine, Version: version}, Generation: generation,
		Provenance: provenance, Endpoint: endpoint, Secret: secret,
	}, testImage, "operation-1", 2)
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func cacheArtifact(t *testing.T, adapter RecoveryAdapter, source Connection) (RecoveryArtifact, IsolatedJob) {
	t.Helper()
	request, err := NewDumpRequest(source, source.Generation())
	if err != nil {
		t.Fatal(err)
	}
	handoff, err := NewDumpHandoff(context.Background(), &sqlOutput{}, 32)
	if err != nil {
		t.Fatal(err)
	}
	runner := &cacheRunner{}
	dump, err := adapter.Dump(context.Background(), request, handoff, runner)
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := NewAttempt(AttemptSpec{OrganizationID: "org-1", ResourceID: source.ResourceID(), BackupID: "operation-1", KeyVersion: "key-1", Number: 2, FirstClaimAt: time.Unix(1, 0)})
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := NewRecoveryArtifact(dump, VerifiedArtifact{record: ArtifactRecord{Attempt: attempt.Spec(), StoredBytes: 20, PlaintextBytes: 3, SHA256: [32]byte{1}}})
	if err != nil {
		t.Fatal(err)
	}
	return artifact, runner.runs[0].job
}

func Test_CacheAdapters_build_fixed_helper_actions_and_isolate_endpoint(t *testing.T) {
	tests := []struct {
		name, version, backup, restore, verify string
		adapter                                RecoveryAdapter
		engine                                 Engine
	}{
		{"redis", "7.2.4", "redis-backup", "redis-restore", "redis-verify", NewRedisRecoveryAdapter(), EngineRedis},
		{"valkey", "8.0.1", "valkey-backup", "valkey-restore", "valkey-verify", NewValkeyRecoveryAdapter(), EngineValkey},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given: an indexed endpoint whose values resemble injected command fragments.
			source := cacheConnection(t, test.engine, "source", "cache.internal", test.version)
			artifact, dumpJob := cacheArtifact(t, test.adapter, source)
			target := cacheConnection(t, test.engine, "target", "other-cache.internal", test.version)
			restore, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
			if err != nil {
				t.Fatal(err)
			}
			handoff, err := NewRestoreHandoff(context.Background(), io.NopCloser(strings.NewReader("rdb")), 32)
			if err != nil {
				t.Fatal(err)
			}
			runner := &cacheRunner{}

			// When: both backup and restore jobs are constructed through the adapter.
			receipt, err := test.adapter.Restore(context.Background(), restore, handoff, runner)
			if err != nil {
				t.Fatal(err)
			}

			// Then: every helper invocation has exactly one static action, with streams only on transfer actions.
			assertCacheJob(t, dumpJob, []string{test.verify, test.backup}, StreamStdout)
			assertCacheJob(t, runner.runs[0].job, []string{test.restore, test.verify}, StreamStdin)
			if receipt.Target().ResourceID() != "target" || runner.runs[0].input != "rdb" {
				t.Fatalf("receipt=%+v input=%q", receipt, runner.runs[0].input)
			}
			for _, job := range []IsolatedJob{dumpJob, runner.runs[0].job} {
				for _, step := range job.Spec().Steps {
					if step.Command().Executable() != "raibit-recovery-cache" || len(step.Command().Args()) != 1 {
						t.Fatalf("command=%q args=%q", step.Command().Executable(), step.Command().Args())
					}
					for _, identity := range []string{"cache.internal", "other-cache.internal", "6379", "cache-user", "3"} {
						if strings.Contains(strings.Join(step.Command().Args(), " "), identity) {
							t.Fatalf("endpoint leaked into argv: %q", step.Command().Args())
						}
					}
				}
			}
		})
	}
}

func Test_CacheAdapters_preserve_engine_sentinel_and_ttl_metadata(t *testing.T) {
	for _, test := range []struct {
		adapter RecoveryAdapter
		engine  Engine
		version string
	}{
		{NewRedisRecoveryAdapter(), EngineRedis, "7.2.4"},
		{NewValkeyRecoveryAdapter(), EngineValkey, "8.0.1"},
	} {
		source := cacheConnection(t, test.engine, "source", "cache.internal", test.version)
		artifact, _ := cacheArtifact(t, test.adapter, source)
		metadata := artifact.Baseline().Spec()
		if metadata.Schema != "cache-recovery" || !slices.Contains(metadata.Fields, VerificationField{Name: "engine", Value: string(test.engine)}) || !slices.Contains(metadata.Fields, VerificationField{Name: "sentinel_value", Value: "raibitserver-recovery-sentinel"}) || !slices.Contains(metadata.Fields, VerificationField{Name: "sentinel_ttl", Value: "positive-preserved"}) {
			t.Fatalf("metadata=%+v", metadata)
		}
	}
}

func Test_CacheAdapters_fail_closed_and_release_stream_when_runner_fails_or_context_is_cancelled(t *testing.T) {
	adapter := NewRedisRecoveryAdapter()
	source := cacheConnection(t, EngineRedis, "source", "cache.internal", "7.2.4")
	request, err := NewDumpRequest(source, source.Generation())
	if err != nil {
		t.Fatal(err)
	}
	output := &countingWriteCloser{}
	handoff, err := NewDumpHandoff(context.Background(), output, 32)
	if err != nil {
		t.Fatal(err)
	}

	// When: the job runner fails after receiving the stream capability.
	_, runErr := adapter.Dump(context.Background(), request, handoff, &cacheRunner{fail: errors.New("runner failed")})

	// Then: no result is minted and the owned output closes exactly once.
	if runErr == nil || output.closes.Load() != 1 {
		t.Fatalf("err=%v closes=%d", runErr, output.closes.Load())
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cancelledOutput := &countingWriteCloser{}
	cancelled, err := NewDumpHandoff(ctx, cancelledOutput, 32)
	if err != nil {
		t.Fatal(err)
	}
	if _, cancelErr := adapter.Dump(ctx, request, cancelled, &cacheRunner{}); !errors.Is(cancelErr, context.Canceled) || cancelledOutput.closes.Load() != 1 {
		t.Fatalf("cancelErr=%v closes=%d", cancelErr, cancelledOutput.closes.Load())
	}
	wrongEngine := cacheConnection(t, EngineValkey, "other", "other-cache.internal", "8.0.1")
	wrongRequest, err := NewDumpRequest(wrongEngine, wrongEngine.Generation())
	if err != nil {
		t.Fatal(err)
	}
	wrongOutput := &countingWriteCloser{}
	wrongHandoff, err := NewDumpHandoff(context.Background(), wrongOutput, 32)
	if err != nil {
		t.Fatal(err)
	}
	if _, wrongErr := adapter.Dump(context.Background(), wrongRequest, wrongHandoff, &cacheRunner{}); !errors.Is(wrongErr, ErrRecoveryRequest) {
		t.Fatalf("wrong engine accepted: %v", wrongErr)
	}
	if abortErr := wrongHandoff.Abort(); abortErr != nil || wrongOutput.closes.Load() != 1 {
		t.Fatalf("wrong request leaked stream: err=%v closes=%d", abortErr, wrongOutput.closes.Load())
	}
}

func assertCacheJob(t *testing.T, job IsolatedJob, actions []string, stream StreamBinding) {
	t.Helper()
	spec := job.Spec()
	if len(spec.Steps) != len(actions) {
		t.Fatalf("steps=%d actions=%q", len(spec.Steps), actions)
	}
	for index, action := range actions {
		step := spec.Steps[index]
		binding := StreamNone
		if (index == 1 && stream == StreamStdout) || (index == 0 && stream == StreamStdin) {
			binding = stream
		}
		if step.Command().Executable() != "raibit-recovery-cache" || !slices.Equal(step.Command().Args(), []string{action}) || step.Binding() != binding {
			t.Fatalf("step[%d]=%q/%q/%d", index, step.Command().Executable(), step.Command().Args(), step.Binding())
		}
	}
	if spec.RunAsUser != 65532 || spec.CPUMilli != 250 || spec.MemoryMiB != 256 || spec.EphemeralMiB != 512 || spec.Deadline != 15*time.Minute || len(spec.Secrets) != 0 || len(spec.SecretFiles) != 1 || spec.SecretFiles[0].MountPath() != "/var/run/raibit-recovery/credential" || spec.SecretFiles[0].Ref() != spec.Connection.spec.Secret || !spec.SecretFiles[0].ReadOnly() {
		t.Fatalf("spec=%+v", spec)
	}
}
