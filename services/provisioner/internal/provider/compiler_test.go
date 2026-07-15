package provider

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/store"
)

const testDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestTenantNamespaceMatchesRuntimeForLongProjectSlugs(t *testing.T) {
	resource := &store.Resource{
		ID: "resource-1", ProjectID: "project-cuid", OrganizationID: "organization-cuid",
		ProjectSlug: "project-" + strings.Repeat("b", 70), Name: "primary", Engine: "postgresql",
	}
	_, namespace, _, _, err := ObjectNames(resource)
	if err != nil {
		t.Fatal(err)
	}
	if namespace != "organization-cuid--project-bbbbbbbbbbbbbbbbbbbbbbb-0629a21786b1" {
		t.Fatalf("provider namespace must match the orchestrator/compiler namespace, got %q", namespace)
	}
	if len(namespace) > 63 {
		t.Fatalf("provider namespace exceeds the Kubernetes DNS-label limit: %q", namespace)
	}
}

func TestCompileBuildsProviderSpecificPinnedWorkloadsWithoutLeakingCredentials(t *testing.T) {
	engines := []string{"postgresql", "mysql", "mariadb", "mongodb", "redis", "valkey", "object-storage", "qdrant", "nats"}
	dataMounts := map[string]string{"postgresql": "/var/lib/postgresql/data", "mysql": "/var/lib/mysql", "mariadb": "/var/lib/mysql", "mongodb": "/data/db", "redis": "/data", "valkey": "/data", "object-storage": "/data", "qdrant": "/qdrant/storage", "nats": "/data"}
	runtimeUsers := map[string]int{"postgresql": 70, "mysql": 999, "mariadb": 999, "mongodb": 999, "redis": 999, "valkey": 999, "object-storage": 10001, "qdrant": 10001, "nats": 10001}
	for _, engine := range engines {
		t.Run(engine, func(t *testing.T) {
			plan, err := Compile(&store.Resource{
				ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo",
				Name: "primary", Slug: "primary", Engine: engine, Plan: "shared-small",
			}, "registry.example/"+engine+"@"+testDigest)
			if err != nil {
				t.Fatal(err)
			}
			if plan.SecretName == "" || plan.Endpoint == "" || len(plan.ConnectionKeys) == 0 || len(plan.SecretData) == 0 {
				t.Fatalf("incomplete provider plan: %#v", plan)
			}
			if engine != "object-storage" && engine != "qdrant" && engine != "nats" && len(plan.ProbeCommand) == 0 {
				t.Fatalf("live-capable provider %s must define an authenticated readiness probe", engine)
			}
			if len(plan.ProbeCommand) > 0 && !strings.Contains(strings.Join(plan.ProbeCommand, " "), "127.0.0.1") {
				t.Fatalf("provider probe must work under default-deny egress without cluster DNS: %s", plan.ProbeCommand)
			}
			if plan.Namespace != "org-1--demo" {
				t.Fatalf("provider must share the orchestrator tenant namespace, got %q", plan.Namespace)
			}
			payload, err := json.Marshal(plan.PublicManifests)
			if err != nil {
				t.Fatal(err)
			}
			text := string(payload)
			for key, value := range plan.SecretData {
				upper := strings.ToUpper(key)
				if !strings.Contains(upper, "PASSWORD") && !strings.Contains(upper, "SECRET") && !strings.Contains(upper, "API_KEY") && !strings.Contains(upper, "URL") && key != "nats.conf" {
					continue
				}
				if value != "" && strings.Contains(text, value) {
					t.Fatalf("credential leaked into public manifests for %s", engine)
				}
			}
			for _, expected := range []string{`"kind":"Namespace"`, `"raibitserver.io/namespace-kind":"application"`, `"pod-security.kubernetes.io/enforce":"restricted"`, `"kind":"StatefulSet"`, `"kind":"Service"`, `"kind":"PersistentVolumeClaim"`, testDigest} {
				if !strings.Contains(text, expected) {
					t.Fatalf("provider plan for %s missing %s: %s", engine, expected, text)
				}
			}
			for _, expected := range []string{`"startupProbe"`, `"failureThreshold":120`, `"readinessProbe"`, `"tcpSocket"`, `"runAsUser":` + strconv.Itoa(runtimeUsers[engine]), `"ephemeral-storage":"256Mi"`, `"ephemeral-storage":"1Gi"`, dataMounts[engine]} {
				if !strings.Contains(text, expected) {
					t.Fatalf("provider plan for %s is missing hardened runtime field %s: %s", engine, expected, text)
				}
			}
			if strings.Contains(strings.ToLower(text), "latest") {
				t.Fatalf("provider plan uses mutable latest image: %s", text)
			}
			secretPayload, err := json.Marshal(plan.SecretManifest())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(secretPayload), `"immutable":true`) {
				t.Fatalf("provider credentials must be immutable after first creation: %s", secretPayload)
			}
		})
	}
}

func TestExistingProviderSecretIsExactAndCannotInjectContainerEnvironment(t *testing.T) {
	resource := &store.Resource{ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql"}
	first, err := Compile(resource, "registry.example/postgres@"+testDigest)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Compile(resource, "registry.example/postgres@"+testDigest)
	if err != nil {
		t.Fatal(err)
	}
	existing := make(map[string]string, len(first.SecretData))
	for key, value := range first.SecretData {
		existing[key] = value
	}
	if err := second.UseExistingSecret(existing); err != nil {
		t.Fatalf("a previously created secret for the same resource must be reusable: %v", err)
	}
	if second.SecretData["PGPASSWORD"] != first.SecretData["PGPASSWORD"] {
		t.Fatal("retry must retain the original provider credential")
	}

	existing["LD_PRELOAD"] = "/tenant/injected.so"
	if err := second.UseExistingSecret(existing); err == nil {
		t.Fatal("unexpected Secret keys must fail closed instead of reaching envFrom")
	}
	delete(existing, "LD_PRELOAD")
	existing["PGDATABASE"] = "another_database"
	if err := second.UseExistingSecret(existing); err == nil {
		t.Fatal("a Secret for a different desired provider contract must fail closed")
	}
}

func TestOwnedSecretManifestCarriesCrashRecoveryIdentity(t *testing.T) {
	resource := &store.Resource{ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql"}
	plan, err := Compile(resource, "registry.example/postgres@"+testDigest)
	if err != nil {
		t.Fatal(err)
	}
	generation := "dGhpcy1pcy1hLTMyaWJ5dGUtcmFuZG9tLW5vbmNlMDA"
	manifest, err := plan.OwnedSecretManifest(resource.ID, resource.ProjectID, generation)
	if err != nil {
		t.Fatal(err)
	}
	metadata := manifest["metadata"].(map[string]any)
	annotations := metadata["annotations"].(map[string]any)
	for key, expected := range map[string]string{
		"raibitserver.io/credential-owner":      "raibitserver-provisioner",
		"raibitserver.io/credential-generation": generation,
		"raibitserver.io/resource-id":           resource.ID,
		"raibitserver.io/project-id":            resource.ProjectID,
	} {
		if annotations[key] != expected {
			t.Fatalf("owned Secret annotation %s=%v, want %q", key, annotations[key], expected)
		}
	}
}

func TestProviderWorkloadUsesExplicitSecretRefsAndKubeletAuthenticatedReadiness(t *testing.T) {
	resource := &store.Resource{ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql"}
	plan, err := Compile(resource, "registry.example/postgres@"+testDigest)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(plan.PublicManifests)
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	if strings.Contains(text, `"envFrom"`) {
		t.Fatalf("provider Secret must never be injected wholesale: %s", text)
	}
	for _, expected := range []string{`"env"`, `"secretKeyRef"`, `"startupProbe"`, `"readinessProbe"`, `"exec"`, `"raibitserver.io/reconcile-token"`, `"raibitserver.io/verify-image-signatures":"required"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("provider workload is missing %s: %s", expected, text)
		}
	}
	for _, forbidden := range []string{`"name":"provider-credentials"`, `"mountPath":"/var/run/raibitserver/provider-credentials"`, `credential_dir/PGPASSWORD`} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("ineffective projected Secret comparison must not widen the workload contract (%s): %s", forbidden, text)
		}
	}
	for key := range plan.SecretData {
		if !strings.Contains(text, `"key":"`+key+`"`) || !strings.Contains(text, `"name":"`+key+`"`) {
			t.Fatalf("provider workload must reference allowed Secret key %s explicitly: %s", key, text)
		}
	}
	if !strings.Contains(text, `"name":"PGDATA","value":"/var/lib/postgresql/data/pgdata"`) {
		t.Fatalf("PostgreSQL must initialize below the PVC root so filesystem lost+found does not break initdb: %s", text)
	}
}

func TestMySQLFamilyRejectsReservedRootApplicationUser(t *testing.T) {
	for _, engine := range []string{"mysql", "mariadb"} {
		_, err := Compile(&store.Resource{
			ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: engine,
			DesiredSpec: map[string]any{"username": "root"},
		}, "registry.example/database@"+testDigest)
		if err == nil || !strings.Contains(strings.ToLower(err.Error()), "root") {
			t.Fatalf("%s must reject the official image's reserved root application user: %v", engine, err)
		}
	}
}

func TestCompileKeepsPersistedProviderNamespaceAfterProjectSlugChange(t *testing.T) {
	resource := &store.Resource{
		ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "renamed", Name: "db", Engine: "postgresql",
		DesiredState: map[string]any{"providerResult": map[string]any{"namespace": "org-1--original"}},
	}
	plan, err := Compile(resource, "registry.example/postgres@"+testDigest)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Namespace != "org-1--original" {
		t.Fatalf("persisted provider namespace must remain authoritative after a project slug change: %#v", plan)
	}
	if host := plan.SecretData["PGHOST"]; !strings.Contains(host, ".org-1--original.svc.cluster.local") {
		t.Fatalf("provider connection contract must retain the persisted namespace, got %q", host)
	}
}

func TestRedisFamilyProbeRequiresSuccessfulAuthenticationBeforePing(t *testing.T) {
	for _, engine := range []string{"redis", "valkey"} {
		plan, err := Compile(&store.Resource{ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "cache", Engine: engine}, "registry.example/cache@"+testDigest)
		if err != nil {
			t.Fatal(err)
		}
		probe := strings.Join(plan.ProbeCommand, " ")
		if !strings.Contains(probe, " AUTH ") || !strings.Contains(probe, `= "OK"`) || !strings.Contains(probe, "PING") {
			t.Fatalf("%s readiness must verify AUTH=OK before accepting PONG: %s", engine, probe)
		}
	}
}

func TestTenantAccessManifestBindsOnlyTheConfiguredProvisionerIdentity(t *testing.T) {
	plan, err := Compile(&store.Resource{ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql"}, "registry.example/postgres@"+testDigest)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := plan.TenantAccessManifest("release-provisioner", "control-plane", "release-provisioner-tenant")
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(manifest)
	text := string(payload)
	for _, expected := range []string{`"kind":"RoleBinding"`, `"namespace":"org-1--demo"`, `"kind":"ClusterRole"`, `"name":"release-provisioner-tenant"`, `"kind":"ServiceAccount"`, `"name":"release-provisioner"`, `"namespace":"control-plane"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("tenant access manifest is missing %s: %s", expected, text)
		}
	}
	if _, err := plan.TenantAccessManifest("", "control-plane", "release-provisioner-tenant"); err == nil {
		t.Fatal("live tenant access must fail closed without an exact provisioner ServiceAccount")
	}
}

func TestCompileUsesCryptographicallyRandomCredentials(t *testing.T) {
	resource := &store.Resource{ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql"}
	first, err := Compile(resource, "registry.example/postgres@"+testDigest)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Compile(resource, "registry.example/postgres@"+testDigest)
	if err != nil {
		t.Fatal(err)
	}
	if first.SecretData["PGPASSWORD"] == second.SecretData["PGPASSWORD"] || len(first.SecretData["PGPASSWORD"]) < 32 {
		t.Fatalf("provider credentials must be high-entropy and unique")
	}
}

func TestProviderObjectNamesAreStableAndUniqueByResourceIdentity(t *testing.T) {
	first := &store.Resource{ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "Orders DB", Slug: "shared", Engine: "postgresql"}
	second := &store.Resource{ID: "resource-2", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "Analytics DB", Slug: "shared", Engine: "postgresql"}

	firstName, firstNamespace, firstSecret, firstPVC, err := ObjectNames(first)
	if err != nil {
		t.Fatal(err)
	}
	secondName, secondNamespace, secondSecret, secondPVC, err := ObjectNames(second)
	if err != nil {
		t.Fatal(err)
	}
	if firstName == secondName || firstSecret == secondSecret || firstPVC == secondPVC {
		t.Fatalf("distinct resources must not share Kubernetes objects: first=%q/%q/%q second=%q/%q/%q", firstName, firstSecret, firstPVC, secondName, secondSecret, secondPVC)
	}
	if firstNamespace != secondNamespace {
		t.Fatalf("resources in one project must share a tenant namespace: %q != %q", firstNamespace, secondNamespace)
	}

	first.Name = "Renamed DB"
	first.Slug = "renamed"
	renamedName, renamedNamespace, renamedSecret, renamedPVC, err := ObjectNames(first)
	if err != nil {
		t.Fatal(err)
	}
	if renamedName != firstName || renamedNamespace != firstNamespace || renamedSecret != firstSecret || renamedPVC != firstPVC {
		t.Fatalf("mutable display names must not change provider object identity: before=%q/%q/%q/%q after=%q/%q/%q/%q", firstName, firstNamespace, firstSecret, firstPVC, renamedName, renamedNamespace, renamedSecret, renamedPVC)
	}
}

func TestDeletionUsesPersistedConnectionSecretNameForPreMigrationResources(t *testing.T) {
	resource := &store.Resource{ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "renamed-project", Name: "Renamed", Slug: "renamed", Engine: "postgresql", ConnectionSecretName: "legacy-db-connection", DesiredState: map[string]any{"providerResult": map[string]any{"namespace": "org-1--old-project"}}}
	name, namespace, secretName, pvcName, err := ObjectNames(resource)
	if err != nil {
		t.Fatal(err)
	}
	if name != "legacy-db" || namespace != "org-1--old-project" || secretName != "legacy-db-connection" || pvcName != "legacy-db-data" {
		t.Fatalf("deletion must target the persisted provider identity, got %q/%q/%q/%q", name, namespace, secretName, pvcName)
	}

	resource.ConnectionSecretName = "../../another-namespace/secret"
	name, _, secretName, _, err = ObjectNames(resource)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(name, "another-namespace") || strings.Contains(secretName, "another-namespace") {
		t.Fatalf("legacy control-plane references must never become kubectl object names: %q/%q", name, secretName)
	}
}

func TestProviderContractsUseRunnableConnectionDefaults(t *testing.T) {
	base := store.Resource{ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "primary"}

	mongo := base
	mongo.Engine = "mongodb"
	mongoPlan, err := Compile(&mongo, "registry.example/mongodb@"+testDigest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(mongoPlan.SecretData["MONGODB_URI"], "authSource=admin") {
		t.Fatalf("Mongo root connection must authenticate against admin: %s", mongoPlan.SecretData["MONGODB_URI"])
	}

	redis := base
	redis.Engine = "redis"
	redisPlan, err := Compile(&redis, "registry.example/redis@"+testDigest)
	if err != nil {
		t.Fatal(err)
	}
	redisPayload, _ := json.Marshal(redisPlan.PublicManifests)
	if !strings.Contains(string(redisPayload), `"args":["--requirepass","$(REDIS_PASSWORD)"]`) {
		t.Fatalf("Redis must receive its generated password without a shell wrapper: %s", redisPayload)
	}

	storage := base
	storage.Engine = "object-storage"
	storage.DesiredSpec = map[string]any{"databaseName": "team_assets", "storageMb": 256}
	storagePlan, err := Compile(&storage, "registry.example/minio@"+testDigest)
	if err != nil {
		t.Fatal(err)
	}
	if storagePlan.SecretData["S3_BUCKET"] != "team-assets" {
		t.Fatalf("object-storage bucket must be S3-compatible: %q", storagePlan.SecretData["S3_BUCKET"])
	}
	storagePayload, _ := json.Marshal(storagePlan.PublicManifests)
	if !strings.Contains(string(storagePayload), `"storage":"256Mi"`) {
		t.Fatalf("storageMb must be preserved in the provider PVC: %s", storagePayload)
	}
}

func TestCompileUsesEngineSpecificRequestedPrimitiveNames(t *testing.T) {
	base := store.Resource{ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "fallback"}
	for _, test := range []struct {
		engine string
		key    string
		value  string
		env    string
		want   string
	}{
		{engine: "object-storage", key: "bucket", value: "Team Assets", env: "S3_BUCKET", want: "team-assets"},
		{engine: "qdrant", key: "collection", value: "Product Embeddings", env: "VECTOR_DB_COLLECTION", want: "product_embeddings"},
		{engine: "nats", key: "topic", value: "Audit Events", env: "QUEUE_TOPIC", want: "audit_events"},
	} {
		t.Run(test.engine, func(t *testing.T) {
			resource := base
			resource.Engine = test.engine
			resource.DesiredSpec = map[string]any{test.key: test.value, "databaseName": "must_not_win"}
			plan, err := Compile(&resource, "registry.example/provider@"+testDigest)
			if err != nil {
				t.Fatal(err)
			}
			if plan.SecretData[test.env] != test.want {
				t.Fatalf("%s must honor desiredSpec.%s, got %q", test.engine, test.key, plan.SecretData[test.env])
			}
		})
	}
}

func TestCompileFailsClosedForUnpinnedMissingAndUnsupportedProviders(t *testing.T) {
	for _, tc := range []struct {
		name     string
		resource *store.Resource
		image    string
	}{
		{"missing-image", &store.Resource{Engine: "postgresql"}, ""},
		{"mutable-image", &store.Resource{Engine: "postgresql"}, "postgres:16"},
		{"sqlite", &store.Resource{Engine: "sqlite"}, "registry.example/sqlite@" + testDigest},
		{"unknown", &store.Resource{Engine: "future-db"}, "registry.example/future@" + testDigest},
		{"external", &store.Resource{Engine: "postgresql", Provider: "external"}, "registry.example/postgres@" + testDigest},
		{"unknown-provider", &store.Resource{Engine: "postgresql", Provider: "cloud-provider"}, "registry.example/postgres@" + testDigest},
		{"remote-region", &store.Resource{Engine: "postgresql", Region: "us-east-1"}, "registry.example/postgres@" + testDigest},
		{"unknown-plan", &store.Resource{Engine: "postgresql", Plan: "large-ha"}, "registry.example/postgres@" + testDigest},
		{"unmapped-version", &store.Resource{Engine: "postgresql", Version: "17"}, "registry.example/postgres@" + testDigest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Compile(tc.resource, tc.image); err == nil {
				t.Fatal("expected fail-closed provider compile error")
			}
		})
	}
}

func TestCompileAcceptsOnlyDocumentedLocalProviderIdentities(t *testing.T) {
	for _, providerName := range []string{"", "local", "raibitserver", "managed-catalog", "shared-provider", "dedicated-local", "raibitserver-local-postgresql"} {
		t.Run(firstNonEmpty(providerName, "empty"), func(t *testing.T) {
			resource := &store.Resource{ID: "resource-1", ProjectID: "project-1", OrganizationID: "org-1", ProjectSlug: "demo", Name: "db", Engine: "postgresql", Provider: providerName, Region: "LOCAL"}
			if _, err := Compile(resource, "registry.example/postgres@"+testDigest); err != nil {
				t.Fatalf("documented local provider identity %q must remain supported: %v", providerName, err)
			}
		})
	}
}

func TestObjectNamesKeepsLegacyProviderRowsDeletable(t *testing.T) {
	resource := &store.Resource{
		ID:                   "resource-1",
		ProjectID:            "project-1",
		OrganizationID:       "org-1",
		ProjectSlug:          "renamed",
		Engine:               "postgresql",
		Provider:             "legacy-cloud-provider",
		ConnectionSecretName: "persisted-provider-connection",
		DesiredState: map[string]any{
			"providerResult": map[string]any{"namespace": "org-1--original"},
		},
	}
	name, namespace, secretName, pvcName, err := ObjectNames(resource)
	if err != nil {
		t.Fatalf("legacy provider routing must not prevent cleanup: %v", err)
	}
	if name != "persisted-provider" || namespace != "org-1--original" || secretName != "persisted-provider-connection" || pvcName != "persisted-provider-data" {
		t.Fatalf("cleanup must retain persisted object identity: %q %q %q %q", name, namespace, secretName, pvcName)
	}
}
