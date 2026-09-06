package backup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

func (f *fakeRecoveryCommands) recoveryJobPods() []any {
	if len(f.created) == 0 || f.omitJobPods {
		return []any{}
	}
	jobManifest := f.created[len(f.created)-1]
	metadata := jobManifest["metadata"].(map[string]any)
	template := jobManifest["spec"].(map[string]any)["template"].(map[string]any)
	podSpec := template["spec"].(map[string]any)
	initStatuses := make([]any, len(f.job.spec.Steps)-1)
	for index := range initStatuses {
		initStatuses[index] = map[string]any{"name": fmt.Sprintf("step-%d", index), "state": map[string]any{"terminated": map[string]any{"exitCode": 0, "reason": "Completed"}}}
	}
	finalIndex := len(f.job.spec.Steps) - 1
	status := map[string]any{
		"phase": "Succeeded", "initContainerStatuses": initStatuses,
		"containerStatuses": []any{map[string]any{"name": fmt.Sprintf("step-%d", finalIndex), "state": map[string]any{"terminated": map[string]any{"exitCode": 0, "reason": "Completed", "message": f.jobReceipt}}}},
	}
	pod := map[string]any{
		"metadata": map[string]any{
			"name": "recovery-job-pod", "namespace": metadata["namespace"], "uid": "recovery-job-pod-uid",
			"labels":          template["metadata"].(map[string]any)["labels"],
			"ownerReferences": []any{map[string]any{"apiVersion": "batch/v1", "kind": "Job", "name": metadata["name"], "uid": "job-uid", "controller": true}},
		},
		"spec": podSpec, "status": status,
	}
	if f.mutateJobPod != nil {
		f.mutateJobPod(pod)
	}
	count := f.jobPodCount
	if count == 0 {
		count = 1
	}
	pods := make([]any, count)
	for index := range pods {
		pods[index] = pod
	}
	return pods
}

func testTerminationReceipt(t *testing.T, action recoveryreceipt.Action, direction recoveryreceipt.Direction) string {
	t.Helper()
	verified := true
	verification := recoveryreceipt.VerificationSpec{Version: true, Schema: true, DecodedArtifact: true}
	if direction == recoveryreceipt.DirectionRestore {
		verification.Sentinel = &verified
		if action == recoveryreceipt.ActionRedisRestore || action == recoveryreceipt.ActionValkeyRestore {
			verification.TTL = &verified
		}
	}
	receipt, err := recoveryreceipt.New(recoveryreceipt.Spec{
		Engine: action.Engine(), Action: action, Direction: direction,
		DecodedBytes: 4, DecodedSHA256: strings.Repeat("a", 64),
		Baseline:     &recoveryreceipt.BaselineSpec{SchemaSHA256: strings.Repeat("b", 64), DataSHA256: strings.Repeat("c", 64), RecordCount: 1},
		Verification: verification,
	})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := recoveryreceipt.Write(&output, receipt); err != nil {
		t.Fatal(err)
	}
	return output.String()
}

func testPostgreSQLHelperJob(t *testing.T, direction recoveryreceipt.Direction) IsolatedJob {
	t.Helper()
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	var plans []sqlCommandPlan
	var err error
	if direction == recoveryreceipt.DirectionDump {
		plans, err = postgresqlDumpPlan(connection)
	} else {
		plans, err = postgresqlRestorePlan(connection)
	}
	if err != nil {
		t.Fatal(err)
	}
	job, err := newSQLJob(connection, plans)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func runObservedHelperJob(t *testing.T, job IsolatedJob, commands *fakeRecoveryCommands, direction recoveryreceipt.Direction) error {
	t.Helper()
	commands.job = job
	client, err := NewCommandKubernetesJobClient(commands, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewKubernetesJobRunner(client)
	if err != nil {
		t.Fatal(err)
	}
	if direction == recoveryreceipt.DirectionDump {
		handoff, handoffErr := NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)
		if handoffErr != nil {
			t.Fatal(handoffErr)
		}
		_, err = handoff.Execute(context.Background(), job, runner)
		return err
	}
	handoff, handoffErr := NewRestoreHandoff(context.Background(), io.NopCloser(strings.NewReader("wire")), 16)
	if handoffErr != nil {
		t.Fatal(handoffErr)
	}
	_, err = handoff.Execute(context.Background(), job, runner)
	return err
}

func Test_CommandKubernetesJobClient_accepts_receipt_from_dump_main_container(t *testing.T) {
	// Given
	job := testPostgreSQLHelperJob(t, recoveryreceipt.DirectionDump)
	commands := &fakeRecoveryCommands{jobReceipt: testTerminationReceipt(t, recoveryreceipt.ActionPostgreSQLDump, recoveryreceipt.DirectionDump)}

	// When
	err := runObservedHelperJob(t, job, commands, recoveryreceipt.DirectionDump)

	// Then
	if err != nil {
		t.Fatalf("error=%v", err)
	}
}

func Test_CommandKubernetesJobClient_accepts_aggregate_receipt_after_restore_init_container(t *testing.T) {
	// Given
	job := testPostgreSQLHelperJob(t, recoveryreceipt.DirectionRestore)
	commands := &fakeRecoveryCommands{jobReceipt: testTerminationReceipt(t, recoveryreceipt.ActionPostgreSQLRestore, recoveryreceipt.DirectionRestore)}

	// When
	err := runObservedHelperJob(t, job, commands, recoveryreceipt.DirectionRestore)

	// Then
	if err != nil {
		t.Fatalf("error=%v", err)
	}
}

func Test_CommandKubernetesJobClient_rejects_untrusted_helper_receipt_or_pod(t *testing.T) {
	valid := testTerminationReceipt(t, recoveryreceipt.ActionPostgreSQLDump, recoveryreceipt.DirectionDump)
	tests := []struct {
		name    string
		receipt string
		prepare func(*fakeRecoveryCommands)
	}{
		{name: "missing receipt"},
		{name: "truncated receipt", receipt: valid[:len(valid)-2]},
		{name: "wrong action", receipt: strings.Replace(valid, "postgresql-dump", "postgresql-restore", 1)},
		{name: "wrong engine", receipt: strings.Replace(valid, `"engine":"postgresql"`, `"engine":"mysql"`, 1)},
		{name: "wrong digest", receipt: strings.Replace(valid, strings.Repeat("a", 64), strings.Repeat("0", 64), 1)},
		{name: "failed flags", receipt: strings.Replace(valid, `"data":true`, `"data":false`, 1)},
		{name: "secret field", receipt: strings.Replace(valid, `"wire_version"`, `"password":"hunter2","wire_version"`, 1)},
		{name: "missing pod", receipt: valid, prepare: func(commands *fakeRecoveryCommands) { commands.omitJobPods = true }},
		{name: "extra pod", receipt: valid, prepare: func(commands *fakeRecoveryCommands) { commands.jobPodCount = 2 }},
		{name: "wrong owner", receipt: valid, prepare: func(commands *fakeRecoveryCommands) {
			commands.mutateJobPod = func(pod map[string]any) {
				pod["metadata"].(map[string]any)["ownerReferences"].([]any)[0].(map[string]any)["name"] = "other-job"
			}
		}},
		{name: "wrong uid", receipt: valid, prepare: func(commands *fakeRecoveryCommands) {
			commands.mutateJobPod = func(pod map[string]any) {
				pod["metadata"].(map[string]any)["ownerReferences"].([]any)[0].(map[string]any)["uid"] = "other-job-uid"
			}
		}},
		{name: "wrong container", receipt: valid, prepare: func(commands *fakeRecoveryCommands) {
			commands.mutateJobPod = func(pod map[string]any) {
				pod["status"].(map[string]any)["containerStatuses"].([]any)[0].(map[string]any)["name"] = "step-0"
			}
		}},
		{name: "failed init step", receipt: valid, prepare: func(commands *fakeRecoveryCommands) {
			commands.mutateJobPod = func(pod map[string]any) {
				pod["status"].(map[string]any)["initContainerStatuses"].([]any)[0].(map[string]any)["state"].(map[string]any)["terminated"].(map[string]any)["exitCode"] = 1
			}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given
			job := testPostgreSQLHelperJob(t, recoveryreceipt.DirectionDump)
			commands := &fakeRecoveryCommands{jobReceipt: test.receipt}
			if test.prepare != nil {
				test.prepare(commands)
			}

			// When
			err := runObservedHelperJob(t, job, commands, recoveryreceipt.DirectionDump)

			// Then
			if !errors.Is(err, ErrRecoveryJob) || strings.Contains(err.Error(), "hunter2") {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func Test_RecoveryJobManifest_writes_bounded_file_termination_messages(t *testing.T) {
	// Given
	job := testPostgreSQLHelperJob(t, recoveryreceipt.DirectionRestore)

	// When
	manifest, _, err := recoveryJobManifest(job, "recovery-job", "credential-snapshot", "snapshot-uid")
	if err != nil {
		t.Fatal(err)
	}
	podSpec := manifest["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
	containers := append(podSpec["initContainers"].([]any), podSpec["containers"].([]any)...)

	// Then
	for _, raw := range containers {
		container := raw.(map[string]any)
		if container["terminationMessagePath"] != recoveryreceipt.TerminationLogPath || container["terminationMessagePolicy"] != "File" {
			t.Fatalf("termination contract=%#v", container)
		}
	}
}

func Test_CommandKubernetesJobClient_rejects_failed_streamed_restore_init_container(t *testing.T) {
	// Given
	job := testPostgreSQLHelperJob(t, recoveryreceipt.DirectionRestore)
	commands := &fakeRecoveryCommands{jobReceipt: testTerminationReceipt(t, recoveryreceipt.ActionPostgreSQLRestore, recoveryreceipt.DirectionRestore)}
	commands.mutateJobPod = func(pod map[string]any) {
		pod["status"].(map[string]any)["initContainerStatuses"].([]any)[0].(map[string]any)["state"].(map[string]any)["terminated"].(map[string]any)["exitCode"] = 1
	}

	// When
	err := runObservedHelperJob(t, job, commands, recoveryreceipt.DirectionRestore)

	// Then
	if !errors.Is(err, ErrRecoveryJob) {
		t.Fatalf("error=%v", err)
	}
}

func Test_CommandKubernetesJobClient_keeps_legacy_non_helper_job_compatible(t *testing.T) {
	// Given
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	commands := &fakeRecoveryCommands{job: job}

	// When
	err = runObservedHelperJob(t, job, commands, recoveryreceipt.DirectionDump)

	// Then
	if err != nil {
		t.Fatalf("error=%v", err)
	}
}
