package backup

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type mongoRun struct {
	job   IsolatedJob
	input string
}

type mongoRunner struct {
	runs      []mongoRun
	fail      error
	completed int
}

func (r *mongoRunner) Run(ctx context.Context, job IsolatedJob, stream JobStream) (completedJobObservation, error) {
	if err := ctx.Err(); err != nil {
		return completedJobObservation{}, err
	}
	if r.fail != nil {
		return completedJobObservation{}, r.fail
	}
	run := mongoRun{job: job}
	if bindingMatches(job, dumpDirection) {
		if _, err := io.WriteString(stream.Output(), "mongodb-archive-gzip"); err != nil {
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
	r.completed++
	return completedHelperJob(job, "mongodb-job")
}

type mongoOutput struct {
	strings.Builder
	closed bool
}

func (o *mongoOutput) Close() error {
	o.closed = true
	return nil
}

type trackedMongoInput struct {
	reader io.Reader
	closed bool
}

func (r *trackedMongoInput) Read(payload []byte) (int, error) { return r.reader.Read(payload) }

func (r *trackedMongoInput) Close() error {
	r.closed = true
	return nil
}
func (r *trackedMongoInput) IsClosed() bool { return r.closed }

type corruptMongoInput struct {
	sent   bool
	closed bool
}

func (r *corruptMongoInput) Read(payload []byte) (int, error) {
	if r.sent {
		return 0, errors.New("corrupt mongodb archive")
	}
	r.sent = true
	return copy(payload, "partial"), nil
}

func (r *corruptMongoInput) Close() error {
	r.closed = true
	return nil
}

func (r *corruptMongoInput) IsClosed() bool { return r.closed }

func mongoConnection(t *testing.T, resource, host, database, user, version string) Connection {
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
	endpoint, err := NewNetworkEndpoint(NetworkEndpointSpec{Host: host, Port: 27017, Database: database, User: user})
	if err != nil {
		t.Fatal(err)
	}
	secret, err := NewSecretRef("project-1", resource+"-secret", "MONGODB_PASSWORD")
	if err != nil {
		t.Fatal(err)
	}
	connection, err := newConnection(ConnectionSpec{
		OrganizationID: "org-1", ProjectID: "project-1", ResourceID: resource,
		Engine: EngineVersion{Engine: EngineMongoDB, Version: version}, Generation: generation,
		Provenance: provenance, Endpoint: endpoint, Secret: secret,
	}, testImage, "operation-1", 2)
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func mongoArtifact(t *testing.T, adapter RecoveryAdapter, source Connection) (RecoveryArtifact, IsolatedJob) {
	t.Helper()
	request, err := NewDumpRequest(source, source.Generation())
	if err != nil {
		t.Fatal(err)
	}
	output := &mongoOutput{}
	handoff, err := NewDumpHandoff(context.Background(), output, 64)
	if err != nil {
		t.Fatal(err)
	}
	runner := &mongoRunner{}
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
		Attempt: attempt.Spec(), StoredBytes: 20, PlaintextBytes: int64(len("mongodb-archive-gzip")), SHA256: [32]byte{1},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return artifact, runner.runs[0].job
}

func mongoRestore(t *testing.T, source, target Connection, artifact RecoveryArtifact) RestoreRequest {
	t.Helper()
	request, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	if err != nil {
		t.Fatal(err)
	}
	return request
}
