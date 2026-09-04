package backup

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type sqlRun struct {
	job   IsolatedJob
	input string
}

type sqlRunner struct {
	runs      []sqlRun
	fail      error
	completed int
}

func (r *sqlRunner) Run(ctx context.Context, job IsolatedJob, stream JobStream) (completedJobObservation, error) {
	if err := ctx.Err(); err != nil {
		return completedJobObservation{}, err
	}
	if r.fail != nil {
		return completedJobObservation{}, r.fail
	}
	recorded := sqlRun{job: job}
	if bindingMatches(job, dumpDirection) {
		if _, err := io.WriteString(stream.Output(), "dump"); err != nil {
			return completedJobObservation{}, err
		}
	} else {
		payload, err := io.ReadAll(stream.Input())
		if err != nil {
			return completedJobObservation{}, err
		}
		recorded.input = string(payload)
	}
	r.runs = append(r.runs, recorded)
	r.completed++
	return testCompletedJob(job, "sql-job"), nil
}

type sqlOutput struct{ strings.Builder }

func (*sqlOutput) Close() error { return nil }

type corruptSQLInput struct{ sent bool }

func (r *corruptSQLInput) Read(payload []byte) (int, error) {
	if r.sent {
		return 0, errors.New("corrupt SQL artifact")
	}
	r.sent = true
	return copy(payload, "partial"), nil
}

func (*corruptSQLInput) Close() error { return nil }

func sqlConnection(t *testing.T, engine Engine, resource, host, database, user, version string) Connection {
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
	port := uint16(5432)
	secretKey := "PGPASSWORD"
	if engine == EngineMySQL || engine == EngineMariaDB {
		port = 3306
		secretKey = "MYSQL_PASSWORD"
	}
	endpoint, err := NewNetworkEndpoint(NetworkEndpointSpec{Host: host, Port: port, Database: database, User: user})
	if err != nil {
		t.Fatal(err)
	}
	secret, err := NewSecretRef("project-1", resource+"-secret", secretKey)
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

func sqlArtifact(t *testing.T, adapter RecoveryAdapter, source Connection) RecoveryArtifact {
	t.Helper()
	artifact, _ := sqlArtifactWithJob(t, adapter, source)
	return artifact
}

func sqlArtifactWithJob(t *testing.T, adapter RecoveryAdapter, source Connection) (RecoveryArtifact, IsolatedJob) {
	t.Helper()
	request, err := NewDumpRequest(source, source.Generation())
	if err != nil {
		t.Fatal(err)
	}
	output := &sqlOutput{}
	handoff, err := NewDumpHandoff(context.Background(), output, 32)
	if err != nil {
		t.Fatal(err)
	}
	runner := &sqlRunner{}
	result, err := adapter.Dump(context.Background(), request, handoff, runner)
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := NewAttempt(AttemptSpec{
		OrganizationID: "org-1", ResourceID: source.ResourceID(), BackupID: "operation-1",
		KeyVersion: "key-1", Number: 2, FirstClaimAt: time.Unix(1, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := NewRecoveryArtifact(result, VerifiedArtifact{record: ArtifactRecord{
		Attempt: attempt.Spec(), StoredBytes: 20, PlaintextBytes: 4, SHA256: [32]byte{1},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return artifact, runner.runs[0].job
}

func sqlRestore(t *testing.T, source, target Connection, artifact RecoveryArtifact) RestoreRequest {
	t.Helper()
	request, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func restoreHandoff(t *testing.T, input io.ReadCloser) *StreamHandoff {
	t.Helper()
	handoff, err := NewRestoreHandoff(context.Background(), input, 32)
	if err != nil {
		t.Fatal(err)
	}
	return handoff
}

func ioNopCloser(value string) io.ReadCloser {
	return io.NopCloser(strings.NewReader(value))
}

func cancelledSQLContext() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

func expectedSQLArgs(engine Engine, database, user string) (dump, restore []string) {
	if engine == EnginePostgreSQL {
		return []string{"--format=custom", "--no-owner", "--no-privileges", "--port", "5432", "--username", user, "--dbname", database},
			[]string{"--exit-on-error", "--no-owner", "--no-privileges", "--port", "5432", "--username", user, "--dbname", database}
	}
	connection := []string{"--protocol=TCP", "--port", "3306", "--user", user}
	dump = append([]string{"--single-transaction", "--routines", "--events", "--triggers", "--hex-blob"}, connection...)
	dump = append(dump, "--databases", database)
	restore = append([]string{"--binary-mode"}, connection...)
	restore = append(restore, "--database", database)
	return dump, restore
}
