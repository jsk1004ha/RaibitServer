package kube

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/raibitserver/orchestrator/internal/store"
)

func TestWorkloadKindsCompileExactExposureSets(t *testing.T) {
	tests := []struct {
		serviceType string
		kind        string
		readiness   string
		kinds       []string
	}{
		{serviceType: "web", kind: "Deployment", readiness: "deployment-rollout", kinds: []string{"Deployment", "Ingress", "Namespace", "NetworkPolicy", "ResourceQuota", "Service"}},
		{serviceType: "private", kind: "Deployment", readiness: "deployment-rollout", kinds: []string{"Deployment", "Namespace", "NetworkPolicy", "ResourceQuota", "Service"}},
		{serviceType: "worker", kind: "Deployment", readiness: "deployment-rollout", kinds: []string{"Deployment", "Namespace", "NetworkPolicy", "ResourceQuota"}},
		{serviceType: "cron", kind: "CronJob", readiness: "cronjob-observed", kinds: []string{"CronJob", "Namespace", "NetworkPolicy", "ResourceQuota"}},
		{serviceType: "job", kind: "Job", readiness: "job-completion", kinds: []string{"Job", "Namespace", "NetworkPolicy", "ResourceQuota"}},
		{serviceType: "one-off", kind: "Job", readiness: "job-completion", kinds: []string{"Job", "Namespace", "NetworkPolicy", "ResourceQuota"}},
		{serviceType: "one_off", kind: "Job", readiness: "job-completion", kinds: []string{"Job", "Namespace", "NetworkPolicy", "ResourceQuota"}},
	}
	for _, tc := range tests {
		t.Run(tc.serviceType, func(t *testing.T) {
			plan := NewDeploymentPlan(workloadSpec(tc.serviceType, "dep-1", nil, nil))
			if !plan.Safe {
				t.Fatalf("expected supported service type to compile safely: %#v", plan)
			}
			if plan.Kind != tc.kind {
				t.Fatalf("expected workload kind %s, got %s", tc.kind, plan.Kind)
			}
			if got := reflectedString(plan, "ReadinessStrategy"); got != tc.readiness {
				t.Fatalf("expected readiness %q, got %q", tc.readiness, got)
			}
			gotKinds := manifestKinds(plan.Manifests)
			if fmt.Sprint(gotKinds) != fmt.Sprint(tc.kinds) {
				t.Fatalf("unexpected manifests for %s: got %v, want %v", tc.serviceType, gotKinds, tc.kinds)
			}
		})
	}
}

func TestApplicationNamespaceCarriesImmutableAdmissionBoundaryLabels(t *testing.T) {
	plan := NewDeploymentPlan(workloadSpec("web", "dep-1", nil, nil))
	namespace := findManifest(t, plan.Manifests, "Namespace", plan.Service.Namespace)
	labels := namespace["metadata"].(map[string]any)["labels"].(map[string]any)
	expected := map[string]any{
		"app.kubernetes.io/managed-by":       "raibitserver",
		"raibitserver.io/managed":            "true",
		"raibitserver.io/namespace-kind":     "application",
		"pod-security.kubernetes.io/enforce": "restricted",
		"pod-security.kubernetes.io/audit":   "restricted",
		"pod-security.kubernetes.io/warn":    "restricted",
	}
	for key, value := range expected {
		if labels[key] != value {
			t.Fatalf("namespace label %s = %#v, want %#v", key, labels[key], value)
		}
	}
	if labels["raibitserver.io/project-id"] == "" {
		t.Fatal("namespace must retain its authoritative project identity")
	}
}

func TestApplicationNamespaceHasDeterministicResourceQuota(t *testing.T) {
	plan := NewDeploymentPlan(workloadSpec("web", "dep-quota-a", nil, nil))
	if len(plan.Manifests) < 2 || plan.Manifests[0]["kind"] != "Namespace" || plan.Manifests[1]["kind"] != "ResourceQuota" {
		t.Fatalf("namespace quota must be applied before tenant workloads: %#v", manifestKinds(plan.Manifests))
	}
	quota := findManifest(t, plan.Manifests, "ResourceQuota", "tenant-resource-budget")
	metadata := quota["metadata"].(map[string]any)
	if metadata["namespace"] != plan.Service.Namespace {
		t.Fatalf("quota namespace = %#v, want %q", metadata["namespace"], plan.Service.Namespace)
	}
	labels := metadata["labels"].(map[string]any)
	wantLabels := map[string]any{
		"app.kubernetes.io/managed-by":   "raibitserver",
		"raibitserver.io/managed":        "true",
		"raibitserver.io/namespace-kind": "application",
		"raibitserver.io/project":        "project",
		"raibitserver.io/project-id":     "project-1",
		"raibitserver.io/resource-kind":  "tenant-resource-quota",
	}
	if len(labels) != len(wantLabels) {
		t.Fatalf("quota labels must be exact: %#v", labels)
	}
	for key, want := range wantLabels {
		if labels[key] != want {
			t.Fatalf("quota label %s = %#v, want %#v", key, labels[key], want)
		}
	}
	if _, exists := labels["raibitserver.io/deployment-id"]; exists {
		t.Fatalf("project quota must not be owned by one deployment: %#v", labels)
	}

	spec := quota["spec"].(map[string]any)
	if _, exists := spec["scopes"]; exists {
		t.Fatalf("tenant quota must cover the complete namespace, not selected scopes: %#v", spec)
	}
	if _, exists := spec["scopeSelector"]; exists {
		t.Fatalf("tenant quota must not have a bypassable scope selector: %#v", spec)
	}
	hard := spec["hard"].(map[string]any)
	wantHard := map[string]any{
		"resourcequotas":                    "1",
		"pods":                              "100",
		"count/pods":                        "200",
		"count/deployments.apps":            "50",
		"count/replicasets.apps":            "200",
		"count/statefulsets.apps":           "50",
		"count/jobs.batch":                  "100",
		"count/cronjobs.batch":              "50",
		"services":                          "100",
		"persistentvolumeclaims":            "50",
		"secrets":                           "200",
		"configmaps":                        "100",
		"count/ingresses.networking.k8s.io": "100",
		"count/networkpolicies.networking.k8s.io": "200",
		"requests.cpu":               "50",
		"requests.memory":            "100Gi",
		"requests.ephemeral-storage": "100Gi",
		"limits.cpu":                 "100",
		"limits.memory":              "200Gi",
		"limits.ephemeral-storage":   "200Gi",
		"requests.storage":           "1Ti",
	}
	if len(hard) != len(wantHard) {
		t.Fatalf("quota hard limits must be exact: got %#v, want %#v", hard, wantHard)
	}
	for key, want := range wantHard {
		if hard[key] != want {
			t.Fatalf("quota hard[%s] = %#v, want %#v", key, hard[key], want)
		}
	}

	otherPlan := NewDeploymentPlan(workloadSpec("job", "dep-quota-b", nil, nil))
	otherQuota := findManifest(t, otherPlan.Manifests, "ResourceQuota", "tenant-resource-budget")
	encoded, _ := json.Marshal(quota)
	otherEncoded, _ := json.Marshal(otherQuota)
	if string(encoded) != string(otherEncoded) {
		t.Fatalf("all services in one project must reconcile one deterministic quota: %s != %s", encoded, otherEncoded)
	}
	if manifestExists(CleanupManifests(plan), "ResourceQuota", "tenant-resource-budget") {
		t.Fatal("service cleanup must never delete the shared tenant quota")
	}
}

func TestUnknownWorkloadTypeFailsClosed(t *testing.T) {
	plan := NewDeploymentPlan(workloadSpec("database", "dep-1", nil, nil))
	if plan.Safe || len(plan.Manifests) != 0 {
		t.Fatalf("unknown workload types must fail closed without manifests: %#v", plan)
	}
	if got := reflectedString(plan, "Error"); !strings.Contains(strings.ToLower(got), "unsupported") {
		t.Fatalf("expected explicit unsupported type error, got %q", got)
	}
}

func TestRuntimeCommandAndArgsUseDesiredSpecPrecedenceWithoutShellConversion(t *testing.T) {
	spec := workloadSpec("worker", "dep-1",
		map[string]any{"command": []any{"node", "worker.js"}, "args": []any{"--queue", "critical"}},
		map[string]any{"command": []any{"ignored"}, "args": []any{"--ignored"}},
	)
	plan := NewDeploymentPlan(spec)
	if !plan.Safe {
		t.Fatalf("expected bounded command arrays to be accepted: %#v", plan)
	}
	payload, err := json.Marshal(plan.Manifests)
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	for _, expected := range []string{`"command":["node","worker.js"]`, `"args":["--queue","critical"]`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("manifest missing desiredSpec runtime field %s: %s", expected, text)
		}
	}
	if strings.Contains(text, "ignored") || strings.Contains(text, "sh\",\"-c") {
		t.Fatalf("runtime command must not fall through to desiredState or be shell-wrapped: %s", text)
	}
}

func TestRuntimeCommandValidationFailsClosed(t *testing.T) {
	tooMany := make([]any, 65)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("arg-%d", i)
	}
	tests := []struct {
		name    string
		desired map[string]any
	}{
		{name: "scalar command", desired: map[string]any{"command": "sh -c whoami"}},
		{name: "empty entry", desired: map[string]any{"command": []any{"node", ""}}},
		{name: "too many entries", desired: map[string]any{"args": tooMany}},
		{name: "oversized entry", desired: map[string]any{"args": []any{strings.Repeat("x", 4097)}}},
		{name: "non string entry", desired: map[string]any{"args": []any{"--port", 3000}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			plan := NewDeploymentPlan(workloadSpec("worker", "dep-1", tc.desired, nil))
			if plan.Safe || len(plan.Manifests) != 0 {
				t.Fatalf("invalid runtime array must fail closed: %#v", plan)
			}
		})
	}
}

func TestCronScheduleUsesDesiredSpecPrecedenceAndRejectsUnsafeValues(t *testing.T) {
	plan := NewDeploymentPlan(workloadSpec("cron", "dep-1", map[string]any{"schedule": "*/5 * * * *"}, map[string]any{"schedule": "0 0 * * *"}))
	if !plan.Safe {
		t.Fatalf("expected valid cron schedule: %#v", plan)
	}
	payload, _ := json.Marshal(plan.Manifests)
	if !strings.Contains(string(payload), `"schedule":"*/5 * * * *"`) || strings.Contains(string(payload), `"schedule":"0 0 * * *"`) {
		t.Fatalf("desiredSpec schedule must win: %s", payload)
	}

	fallback := NewDeploymentPlan(workloadSpec("cron", "dep-2", nil, nil))
	fallbackJSON, _ := json.Marshal(fallback.Manifests)
	if !strings.Contains(string(fallbackJSON), `"schedule":"0 * * * *"`) {
		t.Fatalf("expected safe hourly fallback schedule: %s", fallbackJSON)
	}

	for _, schedule := range []any{"* * *", "* * * * *\nmalicious", "0 * * * *\n", "99 99 99 99 99", "*/0 * * * *", "0_0 * * * *", strings.Repeat("*", 129), 42} {
		unsafe := NewDeploymentPlan(workloadSpec("cron", "dep-unsafe", map[string]any{"schedule": schedule}, nil))
		if unsafe.Safe || len(unsafe.Manifests) != 0 {
			t.Fatalf("unsafe cron schedule must fail closed (%v): %#v", schedule, unsafe)
		}
	}
}

func TestWorkloadNamesAndStableIdentityLabels(t *testing.T) {
	jobA := NewDeploymentPlan(workloadSpec("job", "dep-a", nil, nil))
	jobB := NewDeploymentPlan(workloadSpec("job", "dep-b", nil, nil))
	jobNameA := manifestName(t, jobA.Manifests, "Job")
	jobNameB := manifestName(t, jobB.Manifests, "Job")
	if jobNameA == jobNameB || jobNameA == "service" || len(jobNameA) > 63 || len(jobNameB) > 63 {
		t.Fatalf("job names must be deployment-unique DNS names: %q %q", jobNameA, jobNameB)
	}
	if got := reflectedString(jobA, "WorkloadName"); got != jobNameA {
		t.Fatalf("plan must expose actual workload name, got %q want %q", got, jobNameA)
	}

	for _, serviceType := range []string{"web", "private", "worker", "cron"} {
		plan := NewDeploymentPlan(workloadSpec(serviceType, "dep-a", nil, nil))
		if got := manifestName(t, plan.Manifests, plan.Kind); got != "service" {
			t.Fatalf("%s workload name must remain stable per service, got %q", serviceType, got)
		}
	}

	workload := findManifest(t, jobA.Manifests, "Job", jobNameA)
	labels := workload["metadata"].(map[string]any)["labels"].(map[string]any)
	wantLabels := map[string]any{
		"raibitserver.io/managed":       "true",
		"raibitserver.io/project-id":    "project-1",
		"raibitserver.io/service-id":    "service-1",
		"raibitserver.io/deployment-id": "dep-a",
	}
	for key, want := range wantLabels {
		if labels[key] != want {
			t.Fatalf("workload label %s=%v, want %v; labels=%#v", key, labels[key], want, labels)
		}
	}
}

func TestSpecFromStateUsesFlatSingleLabelHostnames(t *testing.T) {
	project := &store.Project{
		ID:               "project-1",
		OrganizationID:   "org-1",
		OrganizationSlug: "demo",
		Slug:             "hello",
	}

	web := &store.Service{
		ID:        "service-web",
		ProjectID: project.ID,
		Slug:      "web",
		Type:      "web",
		ImageURL:  "registry.local/web:1",
		Port:      3000,
		Replicas:  1,
	}

	production := &store.Deployment{
		ID:        "deployment-production",
		ServiceID: web.ID,
		ProjectID: project.ID,
		ImageURL:  "registry.local/web:1",
	}

	productionSpec := SpecFromState(project, web, production, "raibit.kr")
	if got, want := productionSpec.Host, "apps--demo--hello.raibit.kr"; got != want {
		t.Fatalf("production host = %q, want %q", got, want)
	}

	api := &store.Service{
		ID:        "service-api",
		ProjectID: project.ID,
		Slug:      "api",
		Type:      "web",
		ImageURL:  "registry.local/api:1",
		Port:      3000,
		Replicas:  1,
	}

	apiSpec := SpecFromState(project, api, &store.Deployment{
		ID:        "deployment-api",
		ServiceID: api.ID,
		ProjectID: project.ID,
		ImageURL:  "registry.local/api:1",
	}, "raibit.kr")

	if got, want := apiSpec.Host, "apps--demo--hello--api.raibit.kr"; got != want {
		t.Fatalf("additional service host = %q, want %q", got, want)
	}

	previewSpec := SpecFromState(project, web, &store.Deployment{
		ID:                "deployment-preview",
		ServiceID:         web.ID,
		ProjectID:         project.ID,
		DeploymentType:    "preview",
		PullRequestNumber: 32,
		ImageURL:          "registry.local/web:1",
	}, "raibit.kr")

	if got, want := previewSpec.Host, "preview--pr-32--demo--hello.raibit.kr"; got != want {
		t.Fatalf("preview host = %q, want %q", got, want)
	}

	for _, host := range []string{
		productionSpec.Host,
		apiSpec.Host,
		previewSpec.Host,
	} {
		label := strings.SplitN(host, ".", 2)[0]
		if len(label) > 63 {
			t.Fatalf("generated hostname label exceeds DNS limit: %q", host)
		}
		if strings.Contains(host, ".apps.") || strings.Contains(host, ".preview.") {
			t.Fatalf("generated hostname must stay one level below the base domain: %q", host)
		}
	}
}

func TestPreviewObjectNamesAreDeploymentSpecificAndCleanupIsolated(t *testing.T) {
	project := &store.Project{ID: "project-1", OrganizationID: strings.Repeat("organization-", 7), Slug: strings.Repeat("project-", 10)}
	service := &store.Service{ID: "service-1", ProjectID: "project-1", Slug: strings.Repeat("preview-service-", 7), Type: "web", ImageURL: "registry.local/web:1", Port: 8080, Replicas: 1}
	makePlan := func(deploymentID string) DeploymentPlan {
		return NewDeploymentPlan(SpecFromState(project, service, &store.Deployment{
			ID: deploymentID, ServiceID: service.ID, ProjectID: project.ID, DeploymentType: "preview", PullRequestNumber: 42, ImageURL: "registry.local/web:1",
		}, "example.test"))
	}
	oldPlan := makePlan("deployment-old")
	newPlan := makePlan("deployment-new")
	if oldPlan.Service.Host != newPlan.Service.Host {
		t.Fatalf("the PR route must remain stable across deployments: %q %q", oldPlan.Service.Host, newPlan.Service.Host)
	}

	newNames := map[string]string{}
	for _, kind := range []string{"Deployment", "Service", "NetworkPolicy", "Ingress"} {
		oldName := manifestName(t, oldPlan.Manifests, kind)
		newName := manifestName(t, newPlan.Manifests, kind)
		if oldName == newName {
			t.Fatalf("preview %s names must include deployment identity, both were %q", kind, oldName)
		}
		assertDNSName(t, oldName, 63)
		assertDNSName(t, newName, 63)
		newNames[kind] = newName
	}

	cleanup := CleanupManifests(oldPlan)
	if len(cleanup) != 4 {
		t.Fatalf("old preview cleanup must contain exactly its four namespaced objects: %#v", manifestKinds(cleanup))
	}
	for _, manifest := range cleanup {
		kind := fmt.Sprint(manifest["kind"])
		metadata := manifest["metadata"].(map[string]any)
		if metadata["name"] == newNames[kind] {
			t.Fatalf("old preview cleanup targets newer %s %q", kind, newNames[kind])
		}
		labels := metadata["labels"].(map[string]any)
		if labels["raibitserver.io/deployment-id"] != "deployment-old" {
			t.Fatalf("old preview cleanup lost exact deployment ownership: %#v", labels)
		}
	}

	for _, plan := range []DeploymentPlan{oldPlan, newPlan} {
		ingress := findManifest(t, plan.Manifests, "Ingress", manifestName(t, plan.Manifests, "Ingress"))
		rules := ingress["spec"].(map[string]any)["rules"].([]any)
		rule := rules[0].(map[string]any)
		backend := rule["http"].(map[string]any)["paths"].([]any)[0].(map[string]any)["backend"].(map[string]any)["service"].(map[string]any)
		if backend["name"] != plan.Service.Name || rule["host"] != plan.Service.Host {
			t.Fatalf("preview route must target its unique Service: plan=%#v rule=%#v", plan.Service, rule)
		}
	}
}

func TestBatchWorkloadsPreserveRestrictedPodSecurity(t *testing.T) {
	for _, serviceType := range []string{"cron", "job"} {
		plan := NewDeploymentPlan(workloadSpec(serviceType, "dep-1", nil, nil))
		payload, _ := json.Marshal(plan.Manifests)
		text := string(payload)
		for _, marker := range []string{`"automountServiceAccountToken":false`, `"readOnlyRootFilesystem":true`, `"runAsNonRoot":true`, `"allowPrivilegeEscalation":false`, `"drop":["ALL"]`, `"kind":"NetworkPolicy"`} {
			if !strings.Contains(text, marker) {
				t.Fatalf("%s workload missing restricted default %s: %s", serviceType, marker, text)
			}
		}
	}
}

func TestRuntimeTemporaryStorageIsBounded(t *testing.T) {
	plan := NewDeploymentPlan(workloadSpec("web", "dep-storage", nil, nil))
	deployment := findManifest(t, plan.Manifests, "Deployment", "service")
	podSpec := deployment["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
	container := podSpec["containers"].([]any)[0].(map[string]any)
	resources := container["resources"].(map[string]any)
	requests := resources["requests"].(map[string]any)
	limits := resources["limits"].(map[string]any)
	if requests["ephemeral-storage"] != "64Mi" {
		t.Fatalf("ephemeral-storage request = %#v, want 64Mi", requests["ephemeral-storage"])
	}
	if limits["ephemeral-storage"] != "256Mi" {
		t.Fatalf("ephemeral-storage limit = %#v, want 256Mi", limits["ephemeral-storage"])
	}
	volume := podSpec["volumes"].([]any)[0].(map[string]any)
	emptyDir := volume["emptyDir"].(map[string]any)
	if emptyDir["sizeLimit"] != "128Mi" {
		t.Fatalf("tmp emptyDir sizeLimit = %#v, want 128Mi", emptyDir["sizeLimit"])
	}
}

func TestNetworkPolicyUsesTrustedIngressGatewayNamespace(t *testing.T) {
	manifests := CompileServiceManifests(AppServiceSpec{
		Name:             "web",
		Namespace:        "org-project",
		Image:            "registry.local/web:1",
		ProjectSlug:      "project",
		OrganizationSlug: "org",
		DeploymentID:     "dep-1",
	})
	policy := findManifest(t, manifests, "NetworkPolicy", "web-default")
	ingress := policy["spec"].(map[string]any)["ingress"].([]any)
	foundGateway := false
	for _, rule := range ingress {
		from := rule.(map[string]any)["from"].([]any)
		for _, peer := range from {
			namespaceSelector := peer.(map[string]any)["namespaceSelector"].(map[string]any)
			matchLabels := namespaceSelector["matchLabels"].(map[string]any)
			if len(matchLabels) == 0 {
				t.Fatalf("network policy must not contain empty namespaceSelector")
			}
			if matchLabels["kubernetes.io/metadata.name"] == "org-project" {
				t.Fatalf("default ingress must not allow same-namespace lateral traffic")
			}
			if matchLabels["kubernetes.io/metadata.name"] == "ingress-nginx" {
				foundGateway = true
			}
		}
	}
	if !foundGateway {
		t.Fatalf("expected ingress gateway namespaceSelector kubernetes.io/metadata.name=ingress-nginx")
	}
	ports := ingress[0].(map[string]any)["ports"].([]any)
	if len(ports) != 1 || ports[0].(map[string]any)["port"] != 3000 {
		t.Fatalf("web ingress must be limited to the declared service port: %#v", ingress)
	}
}

func TestNetworkPolicyUsesConfiguredGatewayAndIgnoresDesiredStateOverride(t *testing.T) {
	plan := NewDeploymentPlan(
		workloadSpec("web", "dep-policy", map[string]any{"ingressGatewayNamespace": "attacker-controlled"}, nil),
		DeploymentOptions{IngressGatewayNamespace: "edge-gateway-system"},
	)
	if !plan.Safe {
		t.Fatalf("configured gateway plan should be safe: %s", plan.Error)
	}
	policy := findManifest(t, plan.Manifests, "NetworkPolicy", plan.Service.Name+"-default")
	ingress := policy["spec"].(map[string]any)["ingress"].([]any)
	peer := ingress[0].(map[string]any)["from"].([]any)[0].(map[string]any)["namespaceSelector"].(map[string]any)["matchLabels"].(map[string]any)
	if len(peer) != 1 || peer["kubernetes.io/metadata.name"] != "edge-gateway-system" {
		t.Fatalf("gateway selector must come only from trusted options: %#v", peer)
	}
}

func TestInvalidIngressGatewayNamespaceFailsClosed(t *testing.T) {
	plan := NewDeploymentPlan(workloadSpec("web", "dep-policy", nil, nil), DeploymentOptions{IngressGatewayNamespace: "INVALID/namespace"})
	if plan.Safe || plan.Error == "" || len(plan.Manifests) != 0 {
		t.Fatalf("invalid gateway configuration must reject compilation: %#v", plan)
	}
}

func TestNetworkPolicyIngressIsWorkloadTypeAware(t *testing.T) {
	tests := []struct {
		serviceType string
		peerLabel   string
		peerValue   string
		wantRules   int
	}{
		{serviceType: "web", peerLabel: "kubernetes.io/metadata.name", peerValue: "ingress-nginx", wantRules: 1},
		{serviceType: "private", peerLabel: "kubernetes.io/metadata.name", peerValue: "org-1--project", wantRules: 1},
		{serviceType: "worker", wantRules: 0},
		{serviceType: "cron", wantRules: 0},
		{serviceType: "job", wantRules: 0},
	}
	for _, tc := range tests {
		t.Run(tc.serviceType, func(t *testing.T) {
			plan := NewDeploymentPlan(workloadSpec(tc.serviceType, "dep-policy", nil, nil))
			policy := findManifest(t, plan.Manifests, "NetworkPolicy", plan.Service.Name+"-default")
			ingress := policy["spec"].(map[string]any)["ingress"].([]any)
			if len(ingress) != tc.wantRules {
				t.Fatalf("%s ingress rules=%#v, want %d", tc.serviceType, ingress, tc.wantRules)
			}
			if tc.wantRules == 0 {
				return
			}
			rule := ingress[0].(map[string]any)
			ports := rule["ports"].([]any)
			if len(ports) != 1 || ports[0].(map[string]any)["port"] != 8080 || ports[0].(map[string]any)["protocol"] != "TCP" {
				t.Fatalf("%s ingress must be TCP/8080 only: %#v", tc.serviceType, rule)
			}
			peer := rule["from"].([]any)[0].(map[string]any)["namespaceSelector"].(map[string]any)["matchLabels"].(map[string]any)
			if peer[tc.peerLabel] != tc.peerValue || len(peer) != 1 {
				t.Fatalf("%s ingress peer must be exact: %#v", tc.serviceType, peer)
			}
		})
	}
}

func TestNonServingWorkloadIngressRequiresExplicitDesiredSpec(t *testing.T) {
	plan := NewDeploymentPlan(workloadSpec("worker", "dep-policy", map[string]any{"allowTenantIngress": true}, nil))
	policy := findManifest(t, plan.Manifests, "NetworkPolicy", plan.Service.Name+"-default")
	ingress := policy["spec"].(map[string]any)["ingress"].([]any)
	if len(ingress) != 1 {
		t.Fatalf("explicit worker tenant ingress must compile exactly one rule: %#v", ingress)
	}
	rule := ingress[0].(map[string]any)
	peer := rule["from"].([]any)[0].(map[string]any)["namespaceSelector"].(map[string]any)["matchLabels"].(map[string]any)
	ports := rule["ports"].([]any)
	if peer["kubernetes.io/metadata.name"] != plan.Service.Namespace || len(ports) != 1 || ports[0].(map[string]any)["port"] != 8080 {
		t.Fatalf("explicit worker ingress must be same-tenant and port-scoped: %#v", rule)
	}
}

func TestKubernetesNamesAreBoundedAndCollisionResistant(t *testing.T) {
	sharedPrefix := strings.Repeat("same-long-prefix-", 8)
	makeSpec := func(projectID, serviceID, deploymentID, serviceType string) AppServiceSpec {
		return SpecFromState(
			&store.Project{ID: projectID, OrganizationID: "organization-" + sharedPrefix, Slug: sharedPrefix},
			&store.Service{ID: serviceID, ProjectID: projectID, Slug: sharedPrefix, Type: serviceType, ImageURL: "registry.local/service:1", Port: 8080, Replicas: 1},
			&store.Deployment{ID: deploymentID, ServiceID: serviceID, ProjectID: projectID, ImageURL: "registry.local/service:1"},
			"example.test",
		)
	}

	webA := NewDeploymentPlan(makeSpec("project-a", "service-a", "deployment-a", "web"))
	webB := NewDeploymentPlan(makeSpec("project-b", "service-b", "deployment-b", "web"))
	if webA.Service.Namespace == webB.Service.Namespace || webA.Service.Name == webB.Service.Name {
		t.Fatalf("long names with different stable IDs must not collide: %#v %#v", webA.Service, webB.Service)
	}
	assertDNSName(t, webA.Service.Namespace, 63)
	assertDNSName(t, webB.Service.Namespace, 63)
	assertDNSName(t, webA.Service.Name, 63)
	assertDNSName(t, webB.Service.Name, 63)

	cron := NewDeploymentPlan(makeSpec("project-c", "service-c", "deployment-c", "cron"))
	assertDNSName(t, cron.WorkloadName, 52)
	jobA := NewDeploymentPlan(makeSpec("project-c", "service-c", "deployment-a", "job"))
	jobB := NewDeploymentPlan(makeSpec("project-c", "service-c", "deployment-b", "job"))
	assertDNSName(t, jobA.WorkloadName, 63)
	assertDNSName(t, jobB.WorkloadName, 63)
	if jobA.WorkloadName == jobB.WorkloadName {
		t.Fatalf("job names must remain deployment-unique: %q", jobA.WorkloadName)
	}
}

func assertDNSName(t *testing.T, value string, limit int) {
	t.Helper()
	if len(value) == 0 || len(value) > limit {
		t.Fatalf("name %q length=%d exceeds limit %d", value, len(value), limit)
	}
	for index, char := range value {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '-' {
			t.Fatalf("name %q contains non-DNS character %q at %d", value, char, index)
		}
	}
	if value[0] == '-' || value[len(value)-1] == '-' {
		t.Fatalf("name %q must start and end alphanumeric", value)
	}
}

func TestPublicEgressIsServiceScopedAndOptIn(t *testing.T) {
	defaultManifests := CompileServiceManifests(AppServiceSpec{
		Name:             "api",
		Namespace:        "org-project",
		Image:            "registry.local/api:1",
		ProjectSlug:      "project",
		OrganizationSlug: "org",
		DeploymentID:     "dep-1",
	})
	if manifestExists(defaultManifests, "NetworkPolicy", "api-public-egress") {
		t.Fatalf("public egress policy must be opt-in")
	}

	publicManifests := CompileServiceManifests(AppServiceSpec{
		Name:             "api",
		Namespace:        "org-project",
		Image:            "registry.local/api:1",
		ProjectSlug:      "project",
		OrganizationSlug: "org",
		DeploymentID:     "dep-1",
		PublicEgress:     true,
	})
	policy := findManifest(t, publicManifests, "NetworkPolicy", "api-public-egress")
	spec := policy["spec"].(map[string]any)
	podSelector := spec["podSelector"].(map[string]any)["matchLabels"].(map[string]any)
	if podSelector["app.kubernetes.io/name"] != "api" {
		t.Fatalf("public egress must be scoped to service pod selector, got %#v", podSelector)
	}
	egress := spec["egress"].([]any)
	ipv4Block := egress[0].(map[string]any)["to"].([]any)[0].(map[string]any)["ipBlock"].(map[string]any)
	if ipv4Block["cidr"] != "0.0.0.0/0" {
		t.Fatalf("expected public IPv4 cidr, got %#v", ipv4Block["cidr"])
	}
	except := ipv4Block["except"].([]any)
	if !containsAny(except, "169.254.0.0/16") {
		t.Fatalf("public egress must preserve metadata/private-network exclusions, got %#v", except)
	}
}

func TestSpecFromStateReadsPublicEgressIntent(t *testing.T) {
	spec := SpecFromState(
		&store.Project{ID: "project-1", OrganizationID: "org-1", Name: "Project", Slug: "project"},
		&store.Service{ID: "svc-1", ProjectID: "project-1", Name: "api", Slug: "api", ImageURL: "registry.local/api:1", DesiredSpec: map[string]any{"egress": map[string]any{"publicInternet": true}}},
		&store.Deployment{ID: "dep-1", ServiceID: "svc-1", ProjectID: "project-1", ImageURL: "registry.local/api:1"},
		"raibitserver.local",
	)
	if !spec.PublicEgress {
		t.Fatalf("expected SpecFromState to carry service egress.publicInternet intent into AppServiceSpec")
	}
}

func TestSpecFromStatePinsImageByDigestWhenAvailable(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	spec := SpecFromState(
		&store.Project{ID: "project-1", OrganizationID: "org-1", Slug: "project"},
		&store.Service{ID: "svc-1", ProjectID: "project-1", Slug: "api", ImageURL: "registry.local/api:latest"},
		&store.Deployment{ID: "dep-1", ServiceID: "svc-1", ProjectID: "project-1", ImageURL: "registry.local/api:mutable", ImageDigest: digest},
		"example.test",
	)
	if spec.Image != "registry.local/api@"+digest {
		t.Fatalf("expected digest-pinned image, got %q", spec.Image)
	}
}

func TestResolveImageReferenceRequiresValidDigestForLiveDeployments(t *testing.T) {
	image := "registry.example.test/team/api:latest"
	validDigest := "sha256:" + strings.Repeat("a", 64)
	if got, err := ResolveImageReference(image, validDigest, false); err != nil || got != "registry.example.test/team/api@"+validDigest {
		t.Fatalf("expected live image to be digest pinned, got %q, %v", got, err)
	}
	for _, digest := range []string{"", "sha256:abc123", "sha512:" + strings.Repeat("a", 128)} {
		if got, err := ResolveImageReference(image, digest, false); err == nil || got != "" {
			t.Fatalf("expected live image digest %q to fail closed, got %q, %v", digest, got, err)
		}
	}
	if got, err := ResolveImageReference(image, "", true); err != nil || got != image {
		t.Fatalf("explicit local/dry-run mode should permit mutable image, got %q, %v", got, err)
	}
}

func TestResolveImageReferenceRejectsDigestConflict(t *testing.T) {
	digestA := "sha256:" + strings.Repeat("a", 64)
	digestB := "sha256:" + strings.Repeat("b", 64)
	if got, err := ResolveImageReference("registry.example.test/team/api@"+digestA, digestB, false); err == nil || got != "" || !strings.Contains(err.Error(), "image digest conflict") {
		t.Fatalf("expected conflicting digest failure, got %q, %v", got, err)
	}
}

func TestSpecFromStateUsesUserProjectAppsHostnames(t *testing.T) {
	production := SpecFromState(
		&store.Project{ID: "project-1", OrganizationID: "gdg-hongik", Name: "Festival", Slug: "festival-2026"},
		&store.Service{ID: "svc-1", ProjectID: "project-1", Name: "web", Slug: "web", ImageURL: "registry.local/web:1"},
		&store.Deployment{ID: "dep-1", ServiceID: "svc-1", ProjectID: "project-1", ImageURL: "registry.local/web:1"},
		"raibitserver.local",
	)
	if production.Host != "apps--gdg-hongik--festival-2026.raibitserver.local" {
		t.Fatalf("expected user-project apps host, got %q", production.Host)
	}

	preview := SpecFromState(
		&store.Project{ID: "project-1", OrganizationID: "gdg-hongik", Name: "Festival", Slug: "festival-2026"},
		&store.Service{ID: "svc-1", ProjectID: "project-1", Name: "web", Slug: "web", ImageURL: "registry.local/web:1"},
		&store.Deployment{ID: "dep_1", ServiceID: "svc-1", ProjectID: "project-1", ImageURL: "registry.local/web:1", DeploymentType: "preview", PullRequestNumber: 32},
		"raibitserver.local",
	)
	if preview.Host != "preview--pr-32--gdg-hongik--festival-2026.raibitserver.local" {
		t.Fatalf("expected preview user-project host, got %q", preview.Host)
	}
	if preview.Name != "pr-32-web-1fee3c968086" {
		t.Fatalf("preview workload identity must match the TypeScript plan, got %q", preview.Name)
	}
}

func TestSpecFromStateAssignsStableHostsToMultipleWebServices(t *testing.T) {
	project := &store.Project{ID: "project-1", OrganizationID: "gdg-hongik", Name: "Festival", Slug: "festival-2026"}
	api := &store.Service{ID: "svc-api", ProjectID: project.ID, Name: "api", Slug: "api", Type: "web", ImageURL: "registry.local/api:1"}
	web := &store.Service{ID: "svc-web", ProjectID: project.ID, Name: "web", Slug: "web", Type: "web", ImageURL: "registry.local/web:1"}
	production := &store.Deployment{ID: "dep-1", ProjectID: project.ID, ImageURL: "registry.local/app:1"}
	preview := &store.Deployment{ID: "dep-2", ProjectID: project.ID, ImageURL: "registry.local/app:1", DeploymentType: "preview", PullRequestNumber: 32}

	production.ServiceID = api.ID
	apiProduction := SpecFromState(project, api, production, "raibitserver.local")
	production.ServiceID = web.ID
	webProduction := SpecFromState(project, web, production, "raibitserver.local")
	if apiProduction.Host != "apps--gdg-hongik--festival-2026--api.raibitserver.local" || webProduction.Host != "apps--gdg-hongik--festival-2026.raibitserver.local" {
		t.Fatalf("expected stable service-specific production hosts, got %q and %q", apiProduction.Host, webProduction.Host)
	}

	frontend := &store.Service{ID: "svc-frontend", ProjectID: project.ID, Name: "frontend", Slug: "frontend", Type: "web", ImageURL: "registry.local/frontend:1"}
	production.ServiceID = frontend.ID
	frontendProduction := SpecFromState(project, frontend, production, "raibitserver.local")
	if frontendProduction.Host != "apps--gdg-hongik--festival-2026--frontend.raibitserver.local" {
		t.Fatalf("non-web-named services must never claim the base host, got %q", frontendProduction.Host)
	}
	preview.ServiceID = api.ID
	apiPreview := SpecFromState(project, api, preview, "raibitserver.local")
	preview.ServiceID = web.ID
	webPreview := SpecFromState(project, web, preview, "raibitserver.local")
	if apiPreview.Host != "preview--pr-32--gdg-hongik--festival-2026--api.raibitserver.local" || webPreview.Host != "preview--pr-32--gdg-hongik--festival-2026.raibitserver.local" {
		t.Fatalf("expected stable service-specific preview hosts, got %q and %q", apiPreview.Host, webPreview.Host)
	}
	if apiProduction.Host == webProduction.Host || apiPreview.Host == webPreview.Host {
		t.Fatalf("multi-service routes must not collide: %#v %#v %#v %#v", apiProduction, webProduction, apiPreview, webPreview)
	}
}

func TestSpecFromStateBoundsLongRouteLabelsLikeTypeScript(t *testing.T) {
	project := &store.Project{
		ID: "project-cuid", OrganizationID: "organization-cuid", OrganizationSlug: "club-" + strings.Repeat("a", 70),
		Name: "Project", Slug: "project-" + strings.Repeat("b", 70),
	}
	web := &store.Service{ID: "svc-web", ProjectID: project.ID, Name: "web", Slug: "web", Type: "web", ImageURL: "registry.local/web:1"}
	api := &store.Service{ID: "svc-api", ProjectID: project.ID, Name: "api", Slug: "api-" + strings.Repeat("c", 70), Type: "web", ImageURL: "registry.local/api:1"}
	production := &store.Deployment{ID: "dep-1", ProjectID: project.ID, ImageURL: "registry.local/app:1"}
	preview := &store.Deployment{ID: "dep-2", ProjectID: project.ID, ImageURL: "registry.local/app:1", DeploymentType: "preview", PullRequestNumber: 32}

	production.ServiceID = web.ID
	if got := SpecFromState(project, web, production, "raibitserver.local").Host; got != "apps--club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-f685a6d8b3db.raibitserver.local" {
		t.Fatalf("unexpected bounded web host %q", got)
	}
	production.ServiceID = api.ID
	if got := SpecFromState(project, api, production, "raibitserver.local").Host; got != "apps--club-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-f027e0adb928.raibitserver.local" {
		t.Fatalf("unexpected bounded api host %q", got)
	}
	preview.ServiceID = web.ID
	if got := SpecFromState(project, web, preview, "raibitserver.local").Host; got != "preview--pr-32--club-aaaaaaaaaaaaaaaaaaaaa-1aae2be83a21.raibitserver.local" {
		t.Fatalf("unexpected bounded web preview host %q", got)
	}
	preview.ServiceID = api.ID
	if got := SpecFromState(project, api, preview, "raibitserver.local").Host; got != "preview--pr-32--club-aaaaaaaaaaaaaaaaaaaaa-c53d1bfc23ce.raibitserver.local" {
		t.Fatalf("unexpected bounded api preview host %q", got)
	}
	if got := SpecFromState(project, web, production, "raibitserver.local").Namespace; got != "organization-cuid--project-bbbbbbbbbbbbbbbbbbbbbbb-0629a21786b1" {
		t.Fatalf("unexpected bounded tenant namespace %q", got)
	}
}

func TestSpecFromStateUsesOrganizationSlugForPublicHostAndIDForNamespace(t *testing.T) {
	project := &store.Project{
		ID: "project-cuid", OrganizationID: "organization-cuid", OrganizationSlug: "gdg-hongik",
		Name: "Festival", Slug: "festival-2026",
	}
	service := &store.Service{ID: "svc-web", ProjectID: project.ID, Name: "web", Slug: "web", Type: "web", ImageURL: "registry.local/web:1"}
	deployment := &store.Deployment{ID: "dep-1", ServiceID: service.ID, ProjectID: project.ID, ImageURL: "registry.local/web:1"}

	spec := SpecFromState(project, service, deployment, "raibitserver.local")
	if spec.Host != "apps--gdg-hongik--festival-2026.raibitserver.local" {
		t.Fatalf("public host must use the organization slug, got %q", spec.Host)
	}
	if spec.Namespace != "organization-cuid--festival-2026" {
		t.Fatalf("runtime namespace must preserve the immutable organization ID boundary, got %q", spec.Namespace)
	}
}

func TestSpecFromStatePreservesTenantProjectHostBoundaries(t *testing.T) {
	victim := SpecFromState(
		&store.Project{ID: "project-1", OrganizationID: "victim-team", Name: "API", Slug: "api"},
		&store.Service{ID: "svc-1", ProjectID: "project-1", Name: "web", Slug: "web", ImageURL: "registry.local/web:1"},
		&store.Deployment{ID: "dep-1", ServiceID: "svc-1", ProjectID: "project-1", ImageURL: "registry.local/web:1"},
		"example.test",
	)
	attacker := SpecFromState(
		&store.Project{ID: "project-2", OrganizationID: "victim", Name: "Team API", Slug: "team-api"},
		&store.Service{ID: "svc-2", ProjectID: "project-2", Name: "web", Slug: "web", ImageURL: "registry.local/web:1"},
		&store.Deployment{ID: "dep-2", ServiceID: "svc-2", ProjectID: "project-2", ImageURL: "registry.local/web:1"},
		"example.test",
	)
	if victim.Host != "apps--victim-team--api.example.test" || attacker.Host != "apps--victim--team-api.example.test" {
		t.Fatalf("expected boundary-safe hosts, got %q and %q", victim.Host, attacker.Host)
	}
	if victim.Host == attacker.Host || victim.Namespace == attacker.Namespace {
		t.Fatalf("tenant/project boundaries must not collide: %#v %#v", victim, attacker)
	}
}

func findManifest(t *testing.T, manifests []map[string]any, kind string, name string) map[string]any {
	t.Helper()
	for _, manifest := range manifests {
		if manifest["kind"] != kind {
			continue
		}
		metadata := manifest["metadata"].(map[string]any)
		if metadata["name"] == name {
			return manifest
		}
	}
	t.Fatalf("manifest %s/%s not found", kind, name)
	return nil
}

func manifestExists(manifests []map[string]any, kind string, name string) bool {
	for _, manifest := range manifests {
		if manifest["kind"] != kind {
			continue
		}
		metadata := manifest["metadata"].(map[string]any)
		if metadata["name"] == name {
			return true
		}
	}
	return false
}

func containsAny(values []any, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func TestSpecFromStateEmitsManagedResourceSecretKeyRefsWithoutPlaintext(t *testing.T) {
	service := &store.Service{
		ID: "service-1", ProjectID: "project-1", Name: "web", Slug: "web", Type: "web", Port: 3000,
		DesiredSpec: map[string]any{"secretEnv": []any{
			map[string]any{"name": "DATABASE_URL", "valueFrom": map[string]any{"secretKeyRef": map[string]any{"name": "database-connection", "key": "DATABASE_URL"}}},
		}},
	}
	spec := SpecFromState(
		&store.Project{ID: "project-1", OrganizationID: "org-1", Name: "demo", Slug: "demo"},
		service,
		&store.Deployment{ID: "deployment-1", ServiceID: "service-1", ProjectID: "project-1", ImageURL: "registry.example/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		"raibitserver.test",
	)
	plan := NewDeploymentPlan(spec)
	payload, err := json.Marshal(plan.Manifests)
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	if !strings.Contains(text, `"secretKeyRef":{"key":"DATABASE_URL","name":"database-connection"}`) {
		t.Fatalf("runtime manifest missing managed-resource secretKeyRef: %s", text)
	}
	if strings.Contains(text, "postgresql://") {
		t.Fatalf("runtime manifest contains plaintext provider credentials: %s", text)
	}
}

func workloadSpec(serviceType, deploymentID string, desiredSpec, desiredState map[string]any) AppServiceSpec {
	return SpecFromState(
		&store.Project{ID: "project-1", OrganizationID: "org-1", Name: "Project", Slug: "project"},
		&store.Service{ID: "service-1", ProjectID: "project-1", Name: "service", Slug: "service", Type: serviceType, ImageURL: "registry.local/service:1", Port: 8080, Replicas: 1, DesiredSpec: desiredSpec, DesiredState: desiredState},
		&store.Deployment{ID: deploymentID, ServiceID: "service-1", ProjectID: "project-1", ImageURL: "registry.local/service:1"},
		"example.test",
	)
}

func manifestKinds(manifests []map[string]any) []string {
	kinds := make([]string, 0, len(manifests))
	for _, manifest := range manifests {
		kinds = append(kinds, fmt.Sprint(manifest["kind"]))
	}
	sort.Strings(kinds)
	return kinds
}

func manifestName(t *testing.T, manifests []map[string]any, kind string) string {
	t.Helper()
	for _, manifest := range manifests {
		if manifest["kind"] != kind {
			continue
		}
		return fmt.Sprint(manifest["metadata"].(map[string]any)["name"])
	}
	t.Fatalf("manifest kind %s not found in %#v", kind, manifests)
	return ""
}

func reflectedString(value any, field string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	var row map[string]any
	if json.Unmarshal(encoded, &row) != nil {
		return ""
	}
	key := field[:1]
	if len(field) > 1 {
		key = strings.ToLower(key) + field[1:]
	}
	return fmt.Sprint(row[key])
}
