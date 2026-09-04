package backup

import (
	"context"
	"errors"
	"io"
	"reflect"
	"slices"
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

func Test_SQLAdapters_build_fixed_direct_commands_with_bounded_runtime(t *testing.T) {
	tests := []struct {
		name        string
		adapter     RecoveryAdapter
		engine      Engine
		version     string
		format      string
		dumpExec    string
		restoreExec string
		dumpFlags   []string
	}{
		{"postgresql", NewPostgreSQLAdapter(), EnginePostgreSQL, "16.4", postgresqlCustomFormat, "pg_dump", "pg_restore", []string{"--format=custom", "--no-owner", "--no-privileges"}},
		{"mysql", NewMySQLRecoveryAdapter(), EngineMySQL, "8.4.1", mysqlLogicalFormat, "mysqldump", "mysql", []string{"--single-transaction", "--routines", "--events", "--triggers", "--hex-blob"}},
		{"mariadb", NewMariaDBRecoveryAdapter(), EngineMariaDB, "11.4.2", mariaDBLogicalFormat, "mysqldump", "mysql", []string{"--single-transaction", "--routines", "--events", "--triggers", "--hex-blob"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			injection := "tenant;DROP TABLE raibitserver_restore_sentinel--"
			source := sqlConnection(t, test.engine, "source", "source.db.internal", injection, "owner --execute=evil", test.version)
			artifact, dumpJob := sqlArtifactWithJob(t, test.adapter, source)
			if artifact.Format().Spec() != (EngineFormatSpec{Engine: test.engine, Name: test.format, Version: 1}) {
				t.Fatalf("format=%+v", artifact.Format().Spec())
			}
			target := sqlConnection(t, test.engine, "target", "target.db.internal", injection, "owner --execute=evil", test.version)
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
			assertSQLJob(t, runner.runs[0].job, test.restoreExec, StreamStdin)
			assertSQLJob(t, dumpJob, test.dumpExec, StreamStdout)
			steps := runner.runs[0].job.Spec().Steps
			wantDump, wantRestore := expectedSQLArgs(test.engine, injection, "owner --execute=evil")
			if !reflect.DeepEqual(dumpJob.Spec().Steps[1].Command().Args(), wantDump) || !reflect.DeepEqual(steps[0].Command().Args(), wantRestore) {
				t.Fatalf("dump=%#v restore=%#v", dumpJob.Spec().Steps[1].Command().Args(), steps[0].Command().Args())
			}
			if !slices.Contains(steps[0].Command().Args(), injection) {
				t.Fatalf("database was not preserved as one argv element: %#v", steps[0].Command().Args())
			}
			for _, step := range steps {
				args := step.Command().Args()
				for index, arg := range args {
					if (arg == "--command" || arg == "--execute") && index+1 < len(args) && strings.Contains(args[index+1], "DROP TABLE") {
						t.Fatalf("tenant input entered verification SQL: %#v", args)
					}
				}
			}
			for _, flag := range test.dumpFlags {
				if !slices.Contains(dumpJob.Spec().Steps[1].Command().Args(), flag) {
					t.Fatalf("missing dump flag %q", flag)
				}
			}
			if dumpJob.Spec().Steps[1].Command().Executable() != test.dumpExec {
				t.Fatalf("dump executable=%q", dumpJob.Spec().Steps[1].Command().Executable())
			}
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
		steps := runner.runs[0].job.Spec().Steps
		if len(steps) != 2 || steps[0].Binding() != StreamStdin || steps[1].Binding() != StreamNone {
			t.Fatalf("restore/verify order=%+v", steps)
		}
		query := strings.Join(steps[1].Command().Args(), " ")
		if !strings.Contains(query, "information_schema") || !strings.Contains(query, "raibitserver_restore_sentinel") {
			t.Fatalf("verification query lacks schema/sentinel checks: %q", query)
		}
		metadata := receipt.Observed().Spec()
		if metadata.Schema != "sql-recovery" || len(metadata.Fields) < 3 || artifact.Format().Spec().Engine != engine {
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
		input *StreamHandoff
	}{
		{"corrupt", context.Background(), restoreHandoff(t, &corruptSQLInput{})},
		{"cancelled", cancelledSQLContext(), restoreHandoff(t, ioNopCloser("dump"))},
	} {
		t.Run(test.name, func(t *testing.T) {
			runner := &sqlRunner{}
			receipt, err := adapter.Restore(test.ctx, restore, test.input, runner)
			if err == nil || receipt.Target().ResourceID() != "" || runner.completed != 0 {
				t.Fatalf("receipt=%+v completed=%d err=%v", receipt, runner.completed, err)
			}
		})
	}
}

func assertSQLJob(t *testing.T, job IsolatedJob, executable string, binding StreamBinding) {
	t.Helper()
	spec := job.Spec()
	streamStep := spec.Steps[0]
	for _, step := range spec.Steps {
		if step.Binding() == binding {
			streamStep = step
		}
	}
	if streamStep.Command().Executable() != executable || streamStep.Binding() != binding {
		t.Fatalf("steps=%+v", spec.Steps)
	}
	if spec.RunAsUser != 65532 || spec.CPUMilli != 250 || spec.MemoryMiB != 256 || spec.EphemeralMiB != 512 || spec.Deadline != 15*time.Minute {
		t.Fatalf("unbounded runtime=%+v", spec)
	}
	if len(spec.Secrets) != 1 || len(spec.SecretFiles) != 1 || !spec.SecretFiles[0].ReadOnly() || spec.SecretFiles[0].Ref() != spec.Connection.spec.Secret {
		t.Fatalf("credential projections=%+v/%+v", spec.Secrets, spec.SecretFiles)
	}
	wantEnv := "PGPASSWORD"
	if spec.Connection.Engine() == EngineMySQL || spec.Connection.Engine() == EngineMariaDB {
		wantEnv = "MYSQL_PWD"
	}
	if spec.Secrets[0].Name() != wantEnv || spec.Secrets[0].Ref() != spec.Connection.spec.Secret || spec.SecretFiles[0].MountPath() != "/var/run/raibit-recovery/sql/password" {
		t.Fatalf("credential identity=%+v/%+v", spec.Secrets[0], spec.SecretFiles[0])
	}
}
