package backup

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func Test_MongoDBAdapter_dump_and_restore_archive_after_helper_verification(t *testing.T) {
	// Given: source and isolated target MongoDB resources.
	adapter := NewMongoDBRecoveryAdapter()
	source := mongoConnection(t, "source", "source.mongodb.internal", "app", "provider", "7.0.12")
	artifact, dumpJob := mongoArtifact(t, adapter, source)
	target := mongoConnection(t, "target", "target.mongodb.internal", "app_restore", "restore-user", "7.0.15")
	restore := mongoRestore(t, source, target, artifact)
	handoff, err := NewRestoreHandoff(context.Background(), io.NopCloser(strings.NewReader("mongodb-archive-gzip")), 64)
	if err != nil {
		t.Fatal(err)
	}
	runner := &mongoRunner{}

	// When: archive dump and restore jobs complete through the fixed helper actions.
	receipt, err := adapter.Restore(context.Background(), restore, handoff, runner)

	// Then: a typed receipt is issued only after restore and verification complete.
	if err != nil || receipt.Target().ResourceID() != "target" || len(runner.runs) != 1 || artifact.Format().Spec() != (EngineFormatSpec{Engine: EngineMongoDB, Name: mongoDBArchiveFormat, Version: 1}) {
		t.Fatalf("receipt=%+v runs=%d format=%+v err=%v", receipt, len(runner.runs), artifact.Format().Spec(), err)
	}
	assertMongoJob(t, dumpJob, source.spec.Secret, []string{mongoDBVerifyAction, mongoDBDumpAction}, []StreamBinding{StreamNone, StreamStdout})
	assertMongoJob(t, runner.runs[0].job, target.spec.Secret, []string{mongoDBRestoreAction, mongoDBVerifyAction}, []StreamBinding{StreamStdin, StreamNone})
	if runner.runs[0].input != "mongodb-archive-gzip" || receipt.Observed().Spec().Schema != mongoDBRecoverySchema {
		t.Fatalf("input=%q observed=%+v", runner.runs[0].input, receipt.Observed().Spec())
	}
}

func Test_MongoDBAdapter_uses_static_helper_actions_without_endpoint_argv(t *testing.T) {
	// Given: endpoint values shaped like command injection attempts.
	adapter := NewMongoDBRecoveryAdapter()
	database := "tenant;db --drop"
	user := "owner --eval=evil"
	source := mongoConnection(t, "source", "source.mongodb.internal", database, user, "7.0.12")
	artifact, dumpJob := mongoArtifact(t, adapter, source)
	target := mongoConnection(t, "target", "target.mongodb.internal", "restore;db --drop", "restore --eval=evil", "7.0.15")
	restore := mongoRestore(t, source, target, artifact)
	handoff, err := NewRestoreHandoff(context.Background(), io.NopCloser(strings.NewReader("mongodb-archive-gzip")), 64)
	if err != nil {
		t.Fatal(err)
	}
	runner := &mongoRunner{}

	// When: both jobs are constructed and execute with typed endpoint projection.
	_, err = adapter.Restore(context.Background(), restore, handoff, runner)

	// Then: the helper gets only fixed action tokens; endpoint identities remain outside argv.
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range []IsolatedJob{dumpJob, runner.runs[0].job} {
		for _, step := range job.Spec().Steps {
			for _, argument := range step.Command().Args() {
				for _, forbidden := range []string{"source.mongodb.internal", "target.mongodb.internal", database, user, "restore;db --drop", "restore --eval=evil", "27017"} {
					if strings.Contains(argument, forbidden) {
						t.Fatalf("endpoint value %q leaked into argv %#v", forbidden, step.Command().Args())
					}
				}
			}
		}
	}
}

func Test_MongoDBAdapter_rejects_incompatible_artifact_and_stale_source(t *testing.T) {
	// Given: a MongoDB archive bound to one source generation and major version.
	adapter := NewMongoDBRecoveryAdapter()
	source := mongoConnection(t, "source", "source.mongodb.internal", "app", "provider", "7.0.12")
	artifact, _ := mongoArtifact(t, adapter, source)
	target := mongoConnection(t, "target", "target.mongodb.internal", "restore", "restore-user", "7.0.15")
	restore := mongoRestore(t, source, target, artifact)
	wrongEngine := restore
	wrongEngine.artifact.dump.format = testFormat(t, EnginePostgreSQL)
	wrongFormat := restore
	wrongFormatValue, err := NewEngineFormat(EngineFormatSpec{Engine: EngineMongoDB, Name: "wrong-format", Version: 1})
	if err != nil {
		t.Fatal(err)
	}
	wrongFormat.artifact.dump.format = wrongFormatValue
	wrongVersion := restore
	wrongVersionValue, err := NewEngineFormat(EngineFormatSpec{Engine: EngineMongoDB, Name: mongoDBArchiveFormat, Version: 2})
	if err != nil {
		t.Fatal(err)
	}
	wrongVersion.artifact.dump.format = wrongVersionValue
	changedSpec := source.Spec()
	changedGeneration, err := NewSourceGeneration("resource-incarnation/v1:sha256:" + strings.Repeat("f", 64))
	if err != nil {
		t.Fatal(err)
	}
	changedSpec.Generation = changedGeneration
	changed, err := newConnection(changedSpec, source.toolImage, source.operationID, source.attempt)
	if err != nil {
		t.Fatal(err)
	}

	// When / Then: wrong engine, wrong format/version, and stale source generation fail before jobs run.
	for _, request := range []RestoreRequest{wrongEngine, wrongFormat, wrongVersion} {
		handoff, handoffErr := NewRestoreHandoff(context.Background(), io.NopCloser(strings.NewReader("archive")), 64)
		if handoffErr != nil {
			t.Fatal(handoffErr)
		}
		if _, restoreErr := adapter.Restore(context.Background(), request, handoff, &mongoRunner{}); !errors.Is(restoreErr, ErrRecoveryRequest) {
			t.Fatalf("request=%+v err=%v", request.Artifact().Format().Spec(), restoreErr)
		}
	}
	if _, requestErr := NewRestoreRequest(changed, target, artifact, NewMajorVersionCompatibility(artifact.Format())); !errors.Is(requestErr, ErrRecoveryRequest) {
		t.Fatalf("stale source generation accepted: %v", requestErr)
	}
}

func Test_MongoDBAdapter_closes_handoffs_when_runner_fails_input_corrupt_or_context_cancelled(t *testing.T) {
	// Given: a valid restore request and failure-capable stream/runner inputs.
	adapter := NewMongoDBRecoveryAdapter()
	source := mongoConnection(t, "source", "source.mongodb.internal", "app", "provider", "7.0.12")
	artifact, _ := mongoArtifact(t, adapter, source)
	target := mongoConnection(t, "target", "target.mongodb.internal", "restore", "restore-user", "7.0.15")
	restore := mongoRestore(t, source, target, artifact)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	tests := []struct {
		name   string
		ctx    context.Context
		input  mongoClosedInput
		runner *mongoRunner
	}{
		{name: "runner failure", ctx: context.Background(), input: &trackedMongoInput{reader: strings.NewReader("archive")}, runner: &mongoRunner{fail: errors.New("runner failed")}},
		{name: "corrupt input", ctx: context.Background(), input: &corruptMongoInput{}, runner: &mongoRunner{}},
		{name: "cancelled context", ctx: cancelled, input: &trackedMongoInput{reader: strings.NewReader("archive")}, runner: &mongoRunner{}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handoff, err := NewRestoreHandoff(context.Background(), test.input, 64)
			if err != nil {
				t.Fatal(err)
			}

			// When: restore executes through a failing, corrupt, or cancelled path.
			receipt, restoreErr := adapter.Restore(test.ctx, restore, handoff, test.runner)

			// Then: no receipt is minted and stream ownership is closed for cleanup.
			if restoreErr == nil || receipt.Target().ResourceID() != "" || test.runner.completed != 0 {
				t.Fatalf("receipt=%+v completed=%d err=%v", receipt, test.runner.completed, restoreErr)
			}
			if abortErr := handoff.Abort(); abortErr != nil || !test.input.IsClosed() {
				t.Fatalf("handoff cleanup=%v", abortErr)
			}
		})
	}
}

type mongoClosedInput interface {
	io.ReadCloser
	IsClosed() bool
}

func assertMongoJob(t *testing.T, job IsolatedJob, credential SecretRef, actions []string, bindings []StreamBinding) {
	t.Helper()
	spec := job.Spec()
	if spec.RunAsUser != 65532 || spec.CPUMilli != 250 || spec.MemoryMiB != 256 || spec.EphemeralMiB != 512 || spec.Deadline != 15*time.Minute {
		t.Fatalf("runtime=%+v", spec)
	}
	if len(spec.Secrets) != 0 || len(spec.SecretFiles) != 1 || !spec.SecretFiles[0].ReadOnly() || spec.SecretFiles[0].Ref() != credential || spec.SecretFiles[0].MountPath() != mongoDBCredentialPath {
		t.Fatalf("credential projection=%+v/%+v", spec.Secrets, spec.SecretFiles)
	}
	if len(actions) != 2 || len(bindings) != 2 || len(spec.Steps) != 2 {
		t.Fatalf("steps=%+v", spec.Steps)
	}
	for index, step := range spec.Steps {
		if step.Binding() != bindings[index] || step.Command().Executable() != mongoDBRecoveryHelper || len(step.Command().Args()) != 1 || step.Command().Args()[0] != actions[index] {
			t.Fatalf("steps=%+v", spec.Steps)
		}
	}
}
