package backup

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func Test_RecoveryNetworkPolicyManifest_emits_trusted_provider_identity(t *testing.T) {
	tests := []struct {
		engine       Engine
		endpointPort uint16
		wantPort     uint16
	}{
		{EnginePostgreSQL, 5432, 5432},
		{EngineMySQL, 3306, 3306},
		{EngineMariaDB, 3306, 3306},
		{EngineMongoDB, 27017, 27017},
		{EngineRedis, 6379, 6379},
		{EngineValkey, 6379, 6379},
	}
	for _, tt := range tests {
		t.Run(string(tt.engine), func(t *testing.T) {
			// Given: a validated recovery job bound to one supported network engine.
			job := testRecoveryJobForEngine(t, tt.engine, tt.endpointPort)

			// When: the real Kubernetes NetworkPolicy producer renders the job policy.
			manifest := recoveryNetworkPolicyManifest(job, "recovery-egress-operation-1-2", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
			metadata := manifest["metadata"].(map[string]any)
			spec := manifest["spec"].(map[string]any)
			egress := spec["egress"].([]any)
			providerRule := egress[0].(map[string]any)
			providerPeer := providerRule["to"].([]any)[0].(map[string]any)

			// Then: admission can bind immutable engine identity to the exact authority selector and canonical port.
			labels := metadata["labels"].(map[string]string)
			providerLabels := providerPeer["podSelector"].(map[string]any)["matchLabels"]
			wantProviderLabels := map[string]any{
				recoveryAuthorityLabel:     "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"raibitserver.io/provider": string(tt.engine),
			}
			wantPort := []any{map[string]any{"protocol": "TCP", "port": tt.wantPort}}
			if labels["raibitserver.io/provider"] != string(tt.engine) || !reflect.DeepEqual(providerLabels, wantProviderLabels) || !reflect.DeepEqual(providerRule["ports"], wantPort) {
				t.Fatalf("engine=%q labels=%#v provider=%#v ports=%#v", tt.engine, labels, providerLabels, providerRule["ports"])
			}
			if !reflect.DeepEqual(spec["podSelector"], map[string]any{"matchLabels": expectedJobLabels(job)}) {
				t.Fatalf("job selector does not exactly match policy labels: %#v", spec["podSelector"])
			}
			wantDNS := map[string]any{"to": []any{map[string]any{
				"namespaceSelector": map[string]any{"matchLabels": map[string]any{"kubernetes.io/metadata.name": "kube-system"}},
				"podSelector":       map[string]any{"matchLabels": map[string]any{"k8s-app": "kube-dns"}},
			}}, "ports": []any{map[string]any{"protocol": "UDP", "port": 53}, map[string]any{"protocol": "TCP", "port": 53}}}
			if !reflect.DeepEqual(egress[1], wantDNS) {
				t.Fatalf("dns=%#v", egress[1])
			}
		})
	}
}

func Test_RecoveryNetworkPolicyManifest_emits_admission_fixture(t *testing.T) {
	// Given: the same validated PostgreSQL job used by the admission integration test.
	job := testRecoveryJobForEngine(t, EnginePostgreSQL, 5432)

	// When: the real producer renders and serializes its NetworkPolicy.
	manifest := recoveryNetworkPolicyManifest(job, "recovery-egress-operation-1-2", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}

	// Then: expose the exact generated object to the cross-file Node admission model.
	t.Logf("ADMISSION_FIXTURE=%s", payload)
}

func Test_RecoveryJobManifest_rejects_noncanonical_engine_port(t *testing.T) {
	tests := []struct {
		engine Engine
		port   uint16
	}{
		{EnginePostgreSQL, 15432},
		{EngineMySQL, 13306},
		{EngineMariaDB, 23306},
		{EngineMongoDB, 17017},
		{EngineRedis, 16379},
		{EngineValkey, 26379},
	}
	for _, tt := range tests {
		t.Run(string(tt.engine), func(t *testing.T) {
			// Given: a typed connection whose port is not the managed engine's canonical port.
			job := testRecoveryJobForEngine(t, tt.engine, tt.port)

			// When: the runtime Job manifest boundary validates the connection.
			_, _, err := recoveryJobManifest(job, "recovery-job-operation-1-2", "recovery-credential-operation-1-2", "snapshot-uid")

			// Then: the Job is rejected before it can dial a port forbidden by admission.
			if !errors.Is(err, ErrRecoveryJob) {
				t.Fatalf("engine=%q port=%d err=%v", tt.engine, tt.port, err)
			}
		})
	}
}

func testRecoveryJobForEngine(t *testing.T, engine Engine, port uint16) IsolatedJob {
	t.Helper()
	base := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "1.0")
	spec := base.Spec()
	spec.Engine = EngineVersion{Engine: engine, Version: "1.0"}
	endpointSpec := NetworkEndpointSpec{Host: "source.db.internal", Port: port, Database: "app", User: "provider"}
	if engine == EngineRedis || engine == EngineValkey {
		index := uint16(0)
		endpointSpec.Database = ""
		endpointSpec.Index = &index
	}
	endpoint, err := NewNetworkEndpoint(endpointSpec)
	if err != nil {
		t.Fatal(err)
	}
	spec.Endpoint = endpoint
	connection, err := newConnection(spec, base.toolImage, base.operationID, base.attempt)
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	return job
}
