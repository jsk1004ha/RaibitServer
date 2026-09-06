package backup

import (
	"context"
	"testing"
	"time"
)

func Test_CommandKubernetesJobClient_adopts_only_exact_immutable_snapshot_after_already_exists(t *testing.T) {
	// Given
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	commands := &fakeRecoveryCommands{job: job, snapshotAlreadyExists: true}
	client, err := NewCommandKubernetesJobClient(commands, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	runner, _ := NewKubernetesJobRunner(client)
	handoff, _ := NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)

	// When
	receipt, runErr := handoff.Execute(context.Background(), job, runner)

	// Then
	if runErr != nil || receipt.UID() != "job-uid" {
		t.Fatalf("receipt=%+v err=%v", receipt, runErr)
	}
}
