package backup

import (
	"reflect"
	"testing"
)

func Test_EndpointProjection_when_job_manifest_is_rendered(t *testing.T) {
	// Given: a network recovery job whose command contains only package-owned fixed tokens.
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}

	// When: the Kubernetes Job manifest is rendered.
	manifest, _, err := recoveryJobManifest(job, "recovery-job", "credential-snapshot", "snapshot-uid")
	if err != nil {
		t.Fatal(err)
	}
	podSpec := manifest["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
	container := podSpec["containers"].([]any)[0].(map[string]any)

	// Then: endpoint data uses distinct plain env fields while command tokens stay fixed.
	wantEnv := map[string]string{
		"RAIBIT_RECOVERY_HOST":     "source.db.internal",
		"RAIBIT_RECOVERY_PORT":     "5432",
		"RAIBIT_RECOVERY_DATABASE": "app",
		"RAIBIT_RECOVERY_USERNAME": "provider",
	}
	gotEnv := map[string]string{}
	for _, raw := range container["env"].([]any) {
		entry := raw.(map[string]any)
		if value, ok := entry["value"].(string); ok {
			gotEnv[entry["name"].(string)] = value
		}
	}
	if !reflect.DeepEqual(gotEnv, wantEnv) || !reflect.DeepEqual(container["command"], []any{"recovery-tool"}) || !reflect.DeepEqual(container["args"], []any{"--fixed-query", "SELECT (1 + 1)"}) {
		t.Fatalf("env=%v command=%v args=%v", gotEnv, container["command"], container["args"])
	}
}

func Test_SharedScratch_when_job_has_init_and_main_steps(t *testing.T) {
	// Given: a two-step recovery job that stages data before the streaming step.
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	spec := testJobSpec(t, connection, StreamStdout)
	prepareCommand, err := newDirectCommand("recovery-tool", "--prepare")
	if err != nil {
		t.Fatal(err)
	}
	prepare, err := newCommandStep(prepareCommand, StreamNone)
	if err != nil {
		t.Fatal(err)
	}
	spec.Steps = append([]CommandStep{prepare}, spec.Steps...)
	job, err := NewIsolatedJob(spec)
	if err != nil {
		t.Fatal(err)
	}

	// When: the Kubernetes Job manifest is rendered.
	manifest, _, err := recoveryJobManifest(job, "recovery-job", "credential-snapshot", "snapshot-uid")
	if err != nil {
		t.Fatal(err)
	}
	jobSpec := manifest["spec"].(map[string]any)
	podSpec := jobSpec["template"].(map[string]any)["spec"].(map[string]any)
	volumes := podSpec["volumes"].([]any)
	initContainer := podSpec["initContainers"].([]any)[0].(map[string]any)
	mainContainer := podSpec["containers"].([]any)[0].(map[string]any)

	// Then: exactly one bounded emptyDir is mounted read-write at the same deterministic path in both steps.
	if len(volumes) != 1 {
		t.Fatalf("volumes=%#v", volumes)
	}
	volume := volumes[0].(map[string]any)
	if volume["name"] != "recovery-scratch" || !reflect.DeepEqual(volume["emptyDir"], map[string]any{"sizeLimit": "256Mi"}) || volume["hostPath"] != nil {
		t.Fatalf("volume=%#v", volume)
	}
	wantMount := []any{map[string]any{"name": "recovery-scratch", "mountPath": "/var/run/raibit-recovery/scratch", "readOnly": false}}
	if !reflect.DeepEqual(initContainer["volumeMounts"], wantMount) || !reflect.DeepEqual(mainContainer["volumeMounts"], wantMount) {
		t.Fatalf("init=%#v main=%#v", initContainer["volumeMounts"], mainContainer["volumeMounts"])
	}
	if _, suspended := jobSpec["suspend"]; suspended {
		t.Fatalf("job unexpectedly suspended: %#v", jobSpec)
	}
	for _, container := range []map[string]any{initContainer, mainContainer} {
		security := container["securityContext"].(map[string]any)
		if security["privileged"] == true || security["allowPrivilegeEscalation"] != false || security["readOnlyRootFilesystem"] != true {
			t.Fatalf("security=%#v", security)
		}
	}
}
