package backup

import (
	"context"
	"testing"
	"time"

	"github.com/raibitserver/provisioner/internal/command"
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
	if runErr != nil || receipt.UID() != "job-uid" || commands.snapshotVerifications != 1 {
		t.Fatalf("receipt=%+v err=%v", receipt, runErr)
	}
}

func Test_CommandKubernetesJobClient_does_not_adopt_or_delete_a_mismatched_snapshot(t *testing.T) {
	// Given: atomic snapshot comparison fails, with all Secret GETs denied.
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	commands := &fakeRecoveryCommands{job: job, snapshotAlreadyExists: true, snapshotVerifyErr: &command.KubernetesAPIError{StatusCode: 422}}
	client, err := NewCommandKubernetesJobClient(commands, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	runner, _ := NewKubernetesJobRunner(client)
	handoff, _ := NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)
	// When: a recovery attempt encounters the colliding snapshot.
	_, runErr := handoff.Execute(context.Background(), job, runner)
	// Then: the foreign snapshot is not adopted or cleaned up as our creation.
	if runErr == nil || commands.jobCreates != 0 || len(commands.deleted) != 0 || commands.snapshotVerifications != 1 {
		t.Fatalf("jobCreates=%d deletes=%v verifications=%d err=%v", commands.jobCreates, commands.deleted, commands.snapshotVerifications, runErr)
	}
}
