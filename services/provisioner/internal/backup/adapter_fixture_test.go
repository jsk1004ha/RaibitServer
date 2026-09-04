package backup

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

const (
	testGeneration = "resource-incarnation/v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testImage      = "registry.example/recovery/postgres@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func testNetworkConnection(t *testing.T, resource, host, secretName, secretKey, version string) Connection {
	t.Helper()
	generation, err := NewSourceGeneration(testGeneration)
	if err != nil {
		t.Fatal(err)
	}
	provenance, err := NewProviderProvenance(ProviderProvenanceSpec{Namespace: "project-1", Name: resource + "-provider", UID: resource + "-uid", CredentialUID: resource + "-credential", CredentialGeneration: strings.Repeat("g", 43), Generation: 7, Image: testImage})
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := NewNetworkEndpoint(NetworkEndpointSpec{Host: host, Port: 5432, Database: "app", User: "provider"})
	if err != nil {
		t.Fatal(err)
	}
	secret, err := NewSecretRef("project-1", secretName, secretKey)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := NewConnection(ConnectionSpec{OrganizationID: "org-1", ProjectID: "project-1", ResourceID: resource, Engine: EngineVersion{Engine: EnginePostgreSQL, Version: version}, Generation: generation, Provenance: provenance, Endpoint: endpoint, Secret: secret})
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func testSQLiteConnection(t *testing.T, resource, file string) Connection {
	t.Helper()
	generation, err := NewSourceGeneration(testGeneration)
	if err != nil {
		t.Fatal(err)
	}
	provenance, err := NewProviderProvenance(ProviderProvenanceSpec{Namespace: "project-1", Name: resource + "-provider", UID: resource + "-uid", CredentialUID: resource + "-credential", CredentialGeneration: strings.Repeat("g", 43), Generation: 7, Image: testImage})
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := NewSQLiteEndpoint(SQLiteEndpointSpec{Volume: "provider-data", Root: "sqlite-root", RelativePath: file})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := NewConnection(ConnectionSpec{OrganizationID: "org-1", ProjectID: "project-1", ResourceID: resource, Engine: EngineVersion{Engine: EngineSQLite, Version: "3.46.1"}, Generation: generation, Provenance: provenance, Endpoint: endpoint})
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func testBaseline(t *testing.T) VerificationMetadata {
	t.Helper()
	metadata, err := NewVerificationMetadata(VerificationMetadataSpec{Schema: "postgres-catalog", Version: 1, Fields: []VerificationField{{Name: "schema_digest", Value: "sha256:catalog"}, {Name: "sentinel_rows", Value: "42"}}})
	if err != nil {
		t.Fatal(err)
	}
	return metadata
}

func testFormat(t *testing.T, engine Engine) EngineFormat {
	t.Helper()
	format, err := NewEngineFormat(EngineFormatSpec{Engine: engine, Name: "logical-dump", Version: 1})
	if err != nil {
		t.Fatal(err)
	}
	return format
}

func testArtifact(t *testing.T, source Connection) RecoveryArtifact {
	t.Helper()
	request, err := NewDumpRequest(source, source.Generation())
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := newJobReceipt("dump-job", 4)
	if err != nil {
		t.Fatal(err)
	}
	result, err := newDumpResult(request, receipt, testFormat(t, source.Engine()), testBaseline(t))
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := NewAttempt(AttemptSpec{OrganizationID: "org-1", ResourceID: source.ResourceID(), BackupID: "backup-1", KeyVersion: "key-1", Number: 1, FirstClaimAt: time.Unix(1, 0)})
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := NewRecoveryArtifact(result, ArtifactRecord{Attempt: attempt.Spec(), StoredBytes: 20, PlaintextBytes: 4, SHA256: [32]byte{1}})
	if err != nil {
		t.Fatal(err)
	}
	return artifact
}

type writeRunner struct{ payload string }

func (r writeRunner) Run(_ context.Context, _ IsolatedJob, stream JobStream) (JobExecution, error) {
	if _, err := io.Copy(stream.Output(), strings.NewReader(r.payload)); err != nil {
		return JobExecution{}, err
	}
	return NewJobExecution("job-1")
}
