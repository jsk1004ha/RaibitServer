package backup

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func Test_SQLAdapter_dump_stream_is_encrypted_and_authenticated_before_artifact(t *testing.T) {
	service, _, journal, attempt := fixture(t, "", Options{})
	adapter := NewPostgreSQLAdapter()
	source := sqlConnection(t, EnginePostgreSQL, attempt.Spec().ResourceID, "source.db.internal", "app", "provider", "16.4")
	var err error
	source, err = newConnection(source.Spec(), source.toolImage, attempt.Spec().BackupID, attempt.Spec().Number)
	if err != nil {
		t.Fatal(err)
	}
	request, err := NewDumpRequest(source, source.Generation())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	reader, writer := io.Pipe()
	handoff, err := NewDumpHandoff(ctx, writer, 32)
	if err != nil {
		t.Fatal(err)
	}
	type uploadResult struct {
		candidate Candidate
		err       error
	}
	uploaded := make(chan uploadResult, 1)
	go func() {
		candidate, uploadErr := service.Upload(ctx, UploadRequest{Attempt: attempt, Source: reader}, journal)
		uploaded <- uploadResult{candidate: candidate, err: uploadErr}
	}()
	dump, err := adapter.Dump(ctx, request, handoff, &sqlRunner{})
	if err != nil {
		t.Fatal(err)
	}
	result := <-uploaded
	if result.err != nil {
		t.Fatal(result.err)
	}
	sink := &bufferSink{}
	verified, err := service.Readback(ctx, result.candidate, sink)
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := NewRecoveryArtifact(dump, verified)
	if err != nil || sink.String() != "dump" || artifact.Record().StoredBytes <= artifact.Record().PlaintextBytes {
		t.Fatalf("artifact=%+v plaintext=%q err=%v", artifact.Record(), sink.String(), err)
	}
}

func Test_SQLAdapters_route_sql_steps_through_fixed_helper_without_endpoint_argv(t *testing.T) {
	tests := []struct {
		name    string
		adapter RecoveryAdapter
		engine  Engine
		version string
		format  string
	}{
		{"postgresql", NewPostgreSQLAdapter(), EnginePostgreSQL, "16.4", postgresqlCustomFormat},
		{"mysql", NewMySQLRecoveryAdapter(), EngineMySQL, "8.4.1", mysqlLogicalFormat},
		{"mariadb", NewMariaDBRecoveryAdapter(), EngineMariaDB, "11.4.2", mariaDBLogicalFormat},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given: endpoint values that must stay in the typed projection, not executable tokens.
			host := "source-tenant.example.internal"
			injection := "tenant;DROP TABLE raibitserver_restore_sentinel--"
			user := "owner --execute=evil"
			source := sqlConnection(t, test.engine, "source", host, injection, user, test.version)

			// When: the source dump and distinct target restore jobs are planned.
			artifact, dumpJob := sqlArtifactWithJob(t, test.adapter, source)
			if artifact.Format().Spec() != (EngineFormatSpec{Engine: test.engine, Name: test.format, Version: 1}) {
				t.Fatalf("format=%+v", artifact.Format().Spec())
			}
			target := sqlConnection(t, test.engine, "target", "target-tenant.example.internal", injection, user, test.version)
			restore := sqlRestore(t, source, target, artifact)
			handoff, err := NewRestoreHandoff(context.Background(), ioNopCloser("dump"), 32)
			if err != nil {
				t.Fatal(err)
			}
			runner := &sqlRunner{}
			receipt, err := test.adapter.Restore(context.Background(), restore, handoff, runner)
			if err != nil {
				t.Fatal(err)
			}
			if receipt.Target().ResourceID() != "target" || len(runner.runs) != 1 {
				t.Fatalf("receipt=%+v runs=%d", receipt, len(runner.runs))
			}

			// Then: every step uses exactly one fixed helper action; source and target credentials stay isolated.
			assertSQLHelperJob(t, dumpJob, []string{string(test.engine) + "-verify", string(test.engine) + "-dump"}, []StreamBinding{StreamNone, StreamStdout}, source.spec.Secret, []string{host, "5432", "3306", injection, user})
			assertSQLHelperJob(t, runner.runs[0].job, []string{string(test.engine) + "-restore", string(test.engine) + "-verify"}, []StreamBinding{StreamStdin, StreamNone}, target.spec.Secret, []string{"target-tenant.example.internal", "5432", "3306", injection, user})
		})
	}
}

func Test_SQLAdapters_restore_verifies_schema_and_sentinel_before_receipt(t *testing.T) {
	for _, adapter := range []RecoveryAdapter{NewPostgreSQLAdapter(), NewMySQLRecoveryAdapter(), NewMariaDBRecoveryAdapter()} {
		engine := adapter.Engine()
		version := map[Engine]string{EnginePostgreSQL: "16.4", EngineMySQL: "8.4.1", EngineMariaDB: "11.4.2"}[engine]
		source := sqlConnection(t, engine, "source", "source.db.internal", "app", "provider", version)
		artifact := sqlArtifact(t, adapter, source)
		target := sqlConnection(t, engine, "target", "target.db.internal", "app_restore", "provider", version)
		restore := sqlRestore(t, source, target, artifact)
		handoff, _ := NewRestoreHandoff(context.Background(), ioNopCloser("dump"), 32)
		runner := &sqlRunner{}
		receipt, err := adapter.Restore(context.Background(), restore, handoff, runner)
		if err != nil {
			t.Fatal(err)
		}
		assertSQLHelperJob(t, runner.runs[0].job, []string{string(engine) + "-restore", string(engine) + "-verify"}, []StreamBinding{StreamStdin, StreamNone}, target.spec.Secret, []string{"target.db.internal", "5432", "3306", "app_restore", "provider"})
		metadata := receipt.Observed().Spec()
		if metadata.Schema != "sql-recovery" || len(metadata.Fields) != 5 || metadata.Fields[3] != (VerificationField{Name: "schema_check", Value: "information-schema"}) || metadata.Fields[4] != (VerificationField{Name: "sentinel_check", Value: "raibitserver-restore-sentinel"}) || artifact.Format().Spec().Engine != engine {
			t.Fatalf("metadata=%+v format=%+v", metadata, artifact.Format().Spec())
		}
	}
}

func Test_SQLAdapters_fail_closed_for_wrong_version_corruption_and_cancel(t *testing.T) {
	adapter := NewPostgreSQLAdapter()
	source := sqlConnection(t, EnginePostgreSQL, "source", "source.db.internal", "app", "provider", "16.4")
	artifact := sqlArtifact(t, adapter, source)
	wrongVersion := sqlConnection(t, EnginePostgreSQL, "wrong", "wrong.db.internal", "restore", "provider", "17.1")
	if _, err := NewRestoreRequest(source, wrongVersion, artifact, NewMajorVersionCompatibility(artifact.Format())); !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("wrong version accepted: %v", err)
	}
	target := sqlConnection(t, EnginePostgreSQL, "target", "target.db.internal", "restore", "provider", "16.8")
	restore := sqlRestore(t, source, target, artifact)
	for _, test := range []struct {
		name  string
		ctx   context.Context
		input *trackedSQLInput
	}{
		{"corrupt", context.Background(), &trackedSQLInput{reader: &corruptSQLInput{}}},
		{"cancelled", cancelledSQLContext(), &trackedSQLInput{reader: strings.NewReader("dump")}},
	} {
		t.Run(test.name, func(t *testing.T) {
			handoff := restoreHandoff(t, test.input)
			runner := &sqlRunner{}
			receipt, err := adapter.Restore(test.ctx, restore, handoff, runner)
			if err == nil || receipt.Target().ResourceID() != "" || runner.completed != 0 || !test.input.closed {
				t.Fatalf("receipt=%+v completed=%d closed=%t err=%v", receipt, runner.completed, test.input.closed, err)
			}
		})
	}
}

func assertSQLHelperJob(t *testing.T, job IsolatedJob, actions []string, bindings []StreamBinding, secret SecretRef, endpointValues []string) {
	t.Helper()
	spec := job.Spec()
	if len(spec.Steps) != len(actions) || len(actions) != len(bindings) {
		t.Fatalf("steps=%+v actions=%v bindings=%v", spec.Steps, actions, bindings)
	}
	for index, step := range spec.Steps {
		command := step.Command()
		if command.Executable() != sqlRecoveryHelper || len(command.Args()) != 1 || command.Args()[0] != actions[index] || step.Binding() != bindings[index] {
			t.Fatalf("step=%d executable=%q args=%q binding=%d", index, command.Executable(), command.Args(), step.Binding())
		}
		for _, endpointValue := range endpointValues {
			if strings.Contains(command.Executable(), endpointValue) || strings.Contains(command.Args()[0], endpointValue) {
				t.Fatalf("endpoint value %q entered command=%q args=%q", endpointValue, command.Executable(), command.Args())
			}
		}
	}
	if spec.RunAsUser != 65532 || spec.CPUMilli != 250 || spec.MemoryMiB != 512 || spec.EphemeralMiB != 12288 || spec.Deadline != 15*time.Minute {
		t.Fatalf("unbounded runtime=%+v", spec)
	}
	if len(spec.Secrets) != 0 || len(spec.SecretFiles) != 1 || !spec.SecretFiles[0].ReadOnly() || spec.SecretFiles[0].Ref() != secret {
		t.Fatalf("credential projections=%+v/%+v", spec.Secrets, spec.SecretFiles)
	}
	if spec.SecretFiles[0].MountPath() != "/var/run/raibit-recovery/credential" {
		t.Fatalf("credential identity=%+v/%+v", spec.Secrets, spec.SecretFiles)
	}
}
