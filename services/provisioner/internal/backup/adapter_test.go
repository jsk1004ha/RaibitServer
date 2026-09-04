package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func Test_RecoveryAdapter_Dump_streams_source_to_writer(t *testing.T) {
	// Given: a server-owned source, bounded artifact, and a runner that copies incrementally.
	source := adapterConnection(t, "source", "source-connection")
	artifact := adapterArtifact(t, source)
	request, err := NewDumpRequest(source, artifact)
	if err != nil {
		t.Fatal(err)
	}
	runner := &adapterFakeRunner{}
	adapter := adapterFake{engine: EnginePostgreSQL}
	output := &adapterWriteCloser{}

	// When: the adapter starts its dump job.
	receipt, err := adapter.Dump(context.Background(), request, output, runner)

	// Then: output is emitted before input EOF and closed by the runner.
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Bytes() != int64(len("logical-dump")) || output.String() != "logical-dump" || !output.closed {
		t.Fatalf("receipt=%+v output=%q closed=%t", receipt, output.String(), output.closed)
	}
	if runner.job.Command().Executable() != "tool" || runner.streamed == 0 {
		t.Fatalf("job=%+v streamed=%d", runner.job, runner.streamed)
	}
}

func Test_RecoveryAdapter_Restore_streams_plaintext_from_reader(t *testing.T) {
	// Given: a distinct target in the same tenant and a streamed plaintext archive.
	source := adapterConnection(t, "source", "source-connection")
	target := adapterConnection(t, "target", "target-connection")
	artifact := adapterArtifact(t, source)
	request, err := NewRestoreRequest(source, target, artifact)
	if err != nil {
		t.Fatal(err)
	}
	runner := &adapterFakeRunner{}
	adapter := adapterFake{engine: EnginePostgreSQL}
	input := &adapterReadCloser{Reader: strings.NewReader("logical-dump")}

	// When: the adapter starts its restore job.
	receipt, err := adapter.Restore(context.Background(), request, input, runner)

	// Then: the runner consumed and closed the plaintext stream before returning verification.
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Target().ResourceID() != "target" || runner.restored.String() != "logical-dump" || !input.closed {
		t.Fatalf("receipt=%+v restored=%q closed=%t", receipt, runner.restored.String(), input.closed)
	}
}

func Test_RecoveryAdapter_Dump_closes_output_when_context_cancelled(t *testing.T) {
	// Given: a runner blocked on its job context and a cancellable dump.
	source := adapterConnection(t, "source", "source-connection")
	artifact := adapterArtifact(t, source)
	request, err := NewDumpRequest(source, artifact)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner := &adapterFakeRunner{block: true, started: make(chan struct{})}
	output := &adapterWriteCloser{}
	finished := make(chan error, 1)

	// When: cancellation interrupts the active job.
	go func() {
		_, runErr := (adapterFake{engine: EnginePostgreSQL}).Dump(ctx, request, output, runner)
		finished <- runErr
	}()
	<-runner.started
	cancel()
	err = <-finished

	// Then: cancellation is observable and the owned output is closed without polling.
	if !errors.Is(err, context.Canceled) || !output.closed {
		t.Fatalf("err=%v closed=%t", err, output.closed)
	}
}

func Test_RecoveryRequest_rejects_foreign_same_or_unsupported_metadata(t *testing.T) {
	// Given: otherwise server-owned metadata with one invalid recovery boundary each.
	source := adapterConnection(t, "source", "source-connection")
	artifact := adapterArtifact(t, source)
	foreignSpec := source.Spec()
	foreignSpec.OrganizationID = "other-org"
	foreign, err := NewConnection(foreignSpec)
	if err != nil {
		t.Fatal(err)
	}
	sameSecret := adapterConnection(t, "target", "source-connection")
	foreignNamespace, err := NewSecretRef("other-project", "target-connection", "DATABASE_URL")
	if err != nil {
		t.Fatal(err)
	}
	namespaceSpec := source.Spec()
	namespaceSpec.ResourceID = "target-ns"
	namespaceSpec.Secret = foreignNamespace
	namespaceTarget, err := NewConnection(namespaceSpec)
	if err != nil {
		t.Fatal(err)
	}

	// When / Then: cross-tenant, in-place, shared-secret, and unsupported requests fail closed.
	for name, target := range map[string]Connection{
		"foreign":           foreign,
		"same resource":     source,
		"same secret":       sameSecret,
		"foreign namespace": namespaceTarget,
	} {
		t.Run(name, func(t *testing.T) {
			if _, restoreErr := NewRestoreRequest(source, target, artifact); !errors.Is(restoreErr, ErrRecoveryRequest) {
				t.Fatalf("err=%v", restoreErr)
			}
		})
	}
	unsupported := source.Spec()
	unsupported.Engine = Engine("tenant-command")
	if _, unsupportedErr := NewConnection(unsupported); !errors.Is(unsupportedErr, ErrRecoveryRequest) {
		t.Fatalf("err=%v", unsupportedErr)
	}
}

func Test_NewFixedCommand_rejects_shell_interpolation(t *testing.T) {
	// Given: a direct shell interpolation token in a purported fixed argument.

	// When: the fixed command is constructed.
	_, err := NewFixedCommand("tool", "--uri=$(DATABASE_URL)")

	// Then: the ABI rejects it instead of passing a shell fragment to a job runner.
	if !errors.Is(err, ErrRecoveryJob) {
		t.Fatalf("err=%v", err)
	}
}

func adapterConnection(t *testing.T, resourceID, secretName string) Connection {
	t.Helper()
	secret, err := NewSecretRef("project-1", secretName, "DATABASE_URL")
	if err != nil {
		t.Fatal(err)
	}
	connection, err := NewConnection(ConnectionSpec{OrganizationID: "org-1", ProjectID: "project-1", ResourceID: resourceID, Engine: EnginePostgreSQL, Version: "16.4", Secret: secret})
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func adapterArtifact(t *testing.T, source Connection) ArtifactMetadata {
	t.Helper()
	artifact, err := NewArtifactMetadata(ArtifactMetadataSpec{FormatVersion: 1, Engine: source.Engine(), EngineVersion: source.Version(), SourceResourceID: source.ResourceID(), SourceGeneration: "generation-1", KeyVersion: "key-1", StoredBytes: 128, PlaintextBytes: 64, SHA256: [32]byte{1}})
	if err != nil {
		t.Fatal(err)
	}
	return artifact
}

type adapterFake struct{ engine Engine }

func (a adapterFake) Engine() Engine { return a.engine }

func (a adapterFake) Dump(ctx context.Context, _ DumpRequest, output io.WriteCloser, runner JobRunner) (JobReceipt, error) {
	stream, err := NewDumpStream(output)
	if err != nil {
		return JobReceipt{}, err
	}
	job, err := adapterJob()
	if err != nil {
		return JobReceipt{}, err
	}
	return runner.Run(ctx, job, stream)
}

func (a adapterFake) Restore(ctx context.Context, request RestoreRequest, input io.ReadCloser, runner JobRunner) (VerificationReceipt, error) {
	stream, err := NewRestoreStream(input)
	if err != nil {
		return VerificationReceipt{}, err
	}
	job, err := adapterJob()
	if err != nil {
		return VerificationReceipt{}, err
	}
	if _, err = runner.Run(ctx, job, stream); err != nil {
		return VerificationReceipt{}, err
	}
	return NewVerificationReceipt(request.Target(), request.Artifact(), [32]byte{2})
}

type adapterFakeRunner struct {
	job      IsolatedJob
	streamed int64
	restored bytes.Buffer
	block    bool
	started  chan struct{}
}

func (r *adapterFakeRunner) Run(ctx context.Context, job IsolatedJob, stream JobStream) (receipt JobReceipt, resultErr error) {
	if r.started == nil {
		r.started = make(chan struct{})
	}
	defer func() { resultErr = errors.Join(resultErr, stream.Close()) }()
	r.job = job
	close(r.started)
	if r.block {
		<-ctx.Done()
		return JobReceipt{}, ctx.Err()
	}
	if output := stream.Output(); output != nil {
		r.streamed, resultErr = io.Copy(output, strings.NewReader("logical-dump"))
	} else {
		r.streamed, resultErr = io.Copy(&r.restored, stream.Input())
	}
	if resultErr != nil {
		return JobReceipt{}, resultErr
	}
	return NewJobReceipt("job-1", r.streamed)
}

func adapterJob() (IsolatedJob, error) {
	command, err := NewFixedCommand("tool", "--fixed")
	if err != nil {
		return IsolatedJob{}, err
	}
	return NewIsolatedJob(IsolatedJobSpec{Namespace: "project-1", Image: "tools:1", Command: command, RunAsUser: 65532, CPUMilli: 100, MemoryMiB: 128, Deadline: time.Minute})
}

type adapterWriteCloser struct {
	bytes.Buffer
	closed bool
}

func (w *adapterWriteCloser) Close() error { w.closed = true; return nil }

type adapterReadCloser struct {
	*strings.Reader
	closed bool
}

func (r *adapterReadCloser) Close() error { r.closed = true; return nil }
