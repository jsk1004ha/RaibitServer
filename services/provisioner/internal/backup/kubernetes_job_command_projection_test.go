package backup

import (
	"errors"
	"reflect"
	"testing"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

func Test_RecoveryJobManifest_materializes_reserved_helpers_to_absolute_runtime_paths(t *testing.T) {
	tests := []struct {
		name     string
		engine   Engine
		sequence helperCommandSequence
		want     string
	}{
		{name: "database", engine: EnginePostgreSQL, sequence: databaseDumpSequence("postgresql"), want: "/usr/local/bin/raibit-recovery-db"},
		{name: "cache", engine: EngineRedis, sequence: cacheBackupSequence("redis"), want: "/usr/local/bin/raibit-recovery-cache"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given
			connection := testHelperCommandConnection(t, test.engine)
			job, err := NewIsolatedJob(helperJobSpec(t, connection, test.sequence))
			if err != nil {
				t.Fatal(err)
			}

			// When
			manifest, _, err := recoveryJobManifest(job, "recovery-job", "credential-snapshot", "snapshot-uid")

			// Then
			if err != nil {
				t.Fatal(err)
			}
			for _, container := range recoveryManifestContainers(manifest) {
				if !reflect.DeepEqual(container["command"], []any{test.want}) {
					t.Fatalf("command=%#v", container["command"])
				}
			}
		})
	}
}

func Test_CommandKubernetesJobClient_receipt_identity_uses_materialized_helper_path(t *testing.T) {
	tests := []struct {
		name       string
		engine     Engine
		sequence   helperCommandSequence
		action     recoveryreceipt.Action
		executable string
	}{
		{name: "database", engine: EnginePostgreSQL, sequence: databaseDumpSequence("postgresql"), action: recoveryreceipt.ActionPostgreSQLDump, executable: "/usr/local/bin/raibit-recovery-db"},
		{name: "cache", engine: EngineRedis, sequence: cacheBackupSequence("redis"), action: recoveryreceipt.ActionRedisBackup, executable: "/usr/local/bin/raibit-recovery-cache"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given
			connection := testHelperCommandConnection(t, test.engine)
			job, err := NewIsolatedJob(helperJobSpec(t, connection, test.sequence))
			if err != nil {
				t.Fatal(err)
			}
			commands := &fakeRecoveryCommands{jobReceipt: testTerminationReceipt(t, test.action, recoveryreceipt.DirectionDump)}
			commands.mutateJobPod = func(pod map[string]any) {
				for _, container := range recoveryPodContainers(pod) {
					container["command"] = []any{test.executable}
				}
			}

			// When
			err = runObservedHelperJob(t, job, commands, recoveryreceipt.DirectionDump)

			// Then
			if err != nil {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func Test_RecoveryHelperProjection_rejects_unknown_basename_and_absolute_model_path(t *testing.T) {
	// Given
	connection := testHelperCommandConnection(t, EnginePostgreSQL)
	unknown := helperJobSpec(t, connection, databaseDumpSequence("postgresql"))
	for index, action := range []string{"postgresql-verify", "postgresql-dump"} {
		step, err := newHelperCommandStep("raibit-recovery-other", action, unknown.Steps[index].Binding())
		if err != nil {
			t.Fatal(err)
		}
		unknown.Steps[index] = step
	}

	// When
	_, unknownErr := NewIsolatedJob(unknown)
	_, pathErr := newDirectCommand("/usr/local/bin/raibit-recovery-db", "postgresql-dump")

	// Then
	if !errors.Is(unknownErr, ErrRecoveryJob) || !errors.Is(pathErr, ErrRecoveryJob) {
		t.Fatalf("unknown=%v path=%v", unknownErr, pathErr)
	}
}

func recoveryManifestContainers(manifest map[string]any) []map[string]any {
	podSpec := manifest["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
	result := make([]map[string]any, 0, 2)
	for _, key := range []string{"initContainers", "containers"} {
		for _, raw := range podSpec[key].([]any) {
			result = append(result, raw.(map[string]any))
		}
	}
	return result
}

func recoveryPodContainers(pod map[string]any) []map[string]any {
	podSpec := pod["spec"].(map[string]any)
	result := make([]map[string]any, 0, 2)
	for _, key := range []string{"initContainers", "containers"} {
		for _, raw := range podSpec[key].([]any) {
			result = append(result, raw.(map[string]any))
		}
	}
	return result
}
