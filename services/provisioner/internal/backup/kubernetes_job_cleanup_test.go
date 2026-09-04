package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func Test_CommandKubernetesJobClient_workload_replacement_at_last_precreate_check_never_executes_and_cannot_reach_replacement(t *testing.T) {
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	commands := &fakeRecoveryCommands{job: job, driftBeforeJob: true}
	client, _ := NewCommandKubernetesJobClient(commands, time.Minute)
	runner, _ := NewKubernetesJobRunner(client)
	handoff, _ := NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)
	if _, runErr := handoff.Execute(context.Background(), job, runner); !errors.Is(runErr, ErrRecoveryJob) || commands.jobCreates != 0 || len(commands.deleted) != 2 || commands.cleanupSawCanceled || !commands.cleanupSawDeadline || !commands.authorityReleased || replacementMatchesRecoveryPolicy(commands.created, job) {
		t.Fatalf("jobCreates=%d deletes=%v canceledCleanup=%v deadline=%v authorityReleased=%v replacementReachable=%v err=%v", commands.jobCreates, commands.deleted, commands.cleanupSawCanceled, commands.cleanupSawDeadline, commands.authorityReleased, replacementMatchesRecoveryPolicy(commands.created, job), runErr)
	}
}

func Test_CommandKubernetesJobClient_create_failure_cleans_every_confirmed_object_with_live_bounded_context(t *testing.T) {
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		kind          string
		wantDeletes   int
		wantAuthority bool
	}{
		{kind: "Secret", wantDeletes: 1},
		{kind: "NetworkPolicy", wantDeletes: 2, wantAuthority: true},
		{kind: "Job", wantDeletes: 3, wantAuthority: true},
	} {
		t.Run(scenario.kind, func(t *testing.T) {
			commands := &fakeRecoveryCommands{job: job, createFailureKind: scenario.kind}
			client, clientErr := NewCommandKubernetesJobClient(commands, time.Minute)
			if clientErr != nil {
				t.Fatal(clientErr)
			}
			runner, _ := NewKubernetesJobRunner(client)
			handoff, _ := NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)
			_, runErr := handoff.Execute(context.Background(), job, runner)
			if !errors.Is(runErr, context.Canceled) || len(commands.deleted) != scenario.wantDeletes || commands.cleanupSawCanceled || !commands.cleanupSawDeadline || commands.authorityReleased != scenario.wantAuthority {
				t.Fatalf("deletes=%v canceled=%v deadline=%v authorityReleased=%v err=%v", commands.deleted, commands.cleanupSawCanceled, commands.cleanupSawDeadline, commands.authorityReleased, runErr)
			}
		})
	}
}

func Test_CommandKubernetesJobClient_cancelled_transfer_still_cleans_with_live_bounded_context(t *testing.T) {
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	commands := &fakeRecoveryCommands{job: job, streamErr: context.Canceled}
	client, _ := NewCommandKubernetesJobClient(commands, time.Minute)
	runner, _ := NewKubernetesJobRunner(client)
	runContext, cancel := context.WithCancel(context.Background())
	cancel()
	handoff, _ := NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)
	_, runErr := handoff.Execute(runContext, job, runner)
	if !errors.Is(runErr, context.Canceled) || len(commands.deleted) != 0 {
		t.Fatalf("pre-create cancellation deletes=%v err=%v", commands.deleted, runErr)
	}
	commands = &fakeRecoveryCommands{job: job, streamErr: context.Canceled}
	client, _ = NewCommandKubernetesJobClient(commands, time.Minute)
	runner, _ = NewKubernetesJobRunner(client)
	handoff, _ = NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)
	if _, runErr = handoff.Execute(context.Background(), job, runner); !errors.Is(runErr, context.Canceled) || len(commands.deleted) != 3 || commands.cleanupSawCanceled || !commands.cleanupSawDeadline || !commands.authorityReleased {
		t.Fatalf("deletes=%v canceledCleanup=%v deadline=%v authorityReleased=%v err=%v", commands.deleted, commands.cleanupSawCanceled, commands.cleanupSawDeadline, commands.authorityReleased, runErr)
	}
}

func Test_CommandKubernetesJobClient_cancelled_authority_patch_releases_server_applied_label_and_snapshot(t *testing.T) {
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	commands := &fakeRecoveryCommands{job: job, bindErrAfterSideEffect: true}
	client, _ := NewCommandKubernetesJobClient(commands, time.Minute)
	runner, _ := NewKubernetesJobRunner(client)
	handoff, _ := NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)
	_, runErr := handoff.Execute(context.Background(), job, runner)
	if !errors.Is(runErr, context.Canceled) || len(commands.deleted) != 1 || commands.cleanupSawCanceled || !commands.cleanupSawDeadline || !commands.authorityReleased {
		t.Fatalf("deletes=%v canceledCleanup=%v deadline=%v authorityReleased=%v err=%v", commands.deleted, commands.cleanupSawCanceled, commands.cleanupSawDeadline, commands.authorityReleased, runErr)
	}
}

func (f *fakeRecoveryCommands) providerPod(resourceVersion, authority string) map[string]any {
	provider := f.job.spec.Connection.spec.Provenance.spec
	labels := map[string]any{
		"app.kubernetes.io/name":       provider.Name,
		"app.kubernetes.io/managed-by": "raibitserver",
		"raibitserver.io/managed":      "true",
		"raibitserver.io/provider":     string(f.job.spec.Connection.Engine()),
		"raibitserver.io/resource-id":  f.job.spec.Connection.ResourceID(),
		"raibitserver.io/project-id":   f.job.spec.Connection.spec.ProjectID,
	}
	if authority != "" {
		labels[recoveryAuthorityLabel] = authority
	}
	controller := true
	return map[string]any{
		"metadata": map[string]any{
			"name": "provider-0", "namespace": provider.Namespace, "uid": "provider-pod-uid", "resourceVersion": resourceVersion, "labels": labels,
			"ownerReferences": []any{map[string]any{"apiVersion": "apps/v1", "kind": "StatefulSet", "name": provider.Name, "uid": provider.UID, "controller": controller}},
		},
		"spec": map[string]any{"containers": []any{map[string]any{"image": provider.Image}}},
	}
}

func patchValue(args []string) string {
	for index, arg := range args {
		if arg != "-p" || index+1 >= len(args) {
			continue
		}
		var operations []map[string]string
		if json.Unmarshal([]byte(args[index+1]), &operations) != nil {
			return ""
		}
		for _, operation := range operations {
			if operation["op"] == "add" && operation["path"] == "/metadata/labels/raibitserver.io~1recovery-authority" {
				return operation["value"]
			}
		}
	}
	return ""
}

func patchContains(args []string, op, path, value string) bool {
	for index, arg := range args {
		if arg != "-p" || index+1 >= len(args) {
			continue
		}
		var operations []map[string]string
		if json.Unmarshal([]byte(args[index+1]), &operations) != nil {
			return false
		}
		for _, operation := range operations {
			if operation["op"] == op && operation["path"] == path && operation["value"] == value {
				return true
			}
		}
	}
	return false
}

func policyProviderSelector(created []map[string]any) map[string]any {
	for _, object := range created {
		if object["kind"] != "NetworkPolicy" {
			continue
		}
		spec := object["spec"].(map[string]any)
		egress := spec["egress"].([]any)
		to := egress[0].(map[string]any)["to"].([]any)
		return to[0].(map[string]any)["podSelector"].(map[string]any)["matchLabels"].(map[string]any)
	}
	return nil
}

func replacementMatchesRecoveryPolicy(created []map[string]any, job IsolatedJob) bool {
	selector := policyProviderSelector(created)
	if len(selector) == 0 {
		return true
	}
	provider := job.spec.Connection.spec.Provenance.spec
	replacementLabels := map[string]string{
		"app.kubernetes.io/name":       provider.Name,
		"app.kubernetes.io/managed-by": "raibitserver",
		"raibitserver.io/managed":      "true",
		"raibitserver.io/provider":     string(job.spec.Connection.Engine()),
		"raibitserver.io/resource-id":  job.spec.Connection.ResourceID(),
		"raibitserver.io/project-id":   job.spec.Connection.spec.ProjectID,
	}
	for key, value := range selector {
		if replacementLabels[key] != fmt.Sprint(value) {
			return false
		}
	}
	return true
}

func mustJSON(value any) []byte {
	result, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return result
}

func containsString(value any, wanted string) bool {
	payload, _ := json.Marshal(value)
	return strings.Contains(string(payload), wanted)
}
