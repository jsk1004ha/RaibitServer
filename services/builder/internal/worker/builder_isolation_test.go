package worker_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/builder/internal/controlplane"
	"github.com/raibitserver/builder/internal/worker"
)

func TestBuilderDerivesCacheIdentityAndRegistryCacheFromAuthoritativeState(t *testing.T) {
	for _, builderCommand := range []string{"buildctl", "docker-buildx"} {
		t.Run(builderCommand, func(t *testing.T) {
			workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
			state := readState(t, stateFile)
			firstByID(t, state, "projects", "prj_1")["organizationId"] = "org_1"
			firstByID(t, state, "workflowJobs", "job_1")["payload"].(map[string]any)["buildCache"] = "registry"
			writeStateAtPath(t, stateFile, state)
			runner := &recordingRunner{}
			builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{
				WorkspaceDir: workspaceDir,
				Registry:     "registry.example.test/team",
				DryRun:       true,
				Push:         true,
				Builder:      builderCommand,
			})

			if _, err := builder.RunOnce(context.Background()); err != nil {
				t.Fatalf("RunOnce failed: %v", err)
			}
			if len(runner.commands) != 1 {
				t.Fatalf("expected one build command, got %#v", runner.commands)
			}
			command := strings.Join(runner.commands[0].Args, " ")
			if !strings.Contains(command, "BUILDKIT_CACHE_MOUNT_NS=raibit-") {
				t.Fatalf("missing server-derived BuildKit cache namespace: %s", command)
			}
			if !strings.Contains(command, ":buildcache") {
				t.Fatalf("missing derived registry cache reference: %s", command)
			}
			if strings.Contains(command, "demo/api") {
				t.Fatalf("cache reference used mutable project/service slugs: %s", command)
			}
		})
	}
}

func TestProductionBuilderRejectsSharedLiveRuntimeBeforeExecutingTenantCode(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	runner := &recordingRunner{}
	config := liveSupplyChainConfig(workspaceDir, "registry.example.test/team")
	config.Production = true
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, config)

	_, err := builder.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "single-job-pod") {
		t.Fatalf("expected production shared-worker isolation rejection, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("tenant code executed before isolation validation: %#v", runner.commands)
	}
}

func TestProductionBuilderUsesOneShortLivedCredentialForExactOutputRepository(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	state := readState(t, stateFile)
	firstByID(t, state, "projects", "prj_1")["organizationId"] = "org_1"
	writeStateAtPath(t, stateFile, state)
	tokenFile := filepath.Join(t.TempDir(), "broker-token")
	if err := os.WriteFile(tokenFile, []byte("test-broker-token"), 0o600); err != nil {
		t.Fatal(err)
	}

	var issuedRepository string
	broker := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer test-broker-token" {
			t.Errorf("broker authorization was not read from the token file")
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		var payload struct {
			OrganizationID string   `json:"organizationId"`
			ProjectID      string   `json:"projectId"`
			ServiceID      string   `json:"serviceId"`
			JobID          string   `json:"jobId"`
			Repository     string   `json:"repository"`
			Actions        []string `json:"actions"`
			MinTTLSeconds  int64    `json:"minTtlSeconds"`
			MaxTTLSeconds  int64    `json:"maxTtlSeconds"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Errorf("decode broker request: %v", err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		issuedRepository = payload.Repository
		if payload.OrganizationID != "org_1" || payload.ProjectID != "prj_1" || payload.ServiceID != "svc_1" || payload.JobID != "job_1" || strings.Join(payload.Actions, ",") != "pull,push" || payload.MinTTLSeconds != 840 || payload.MaxTTLSeconds != 900 {
			t.Errorf("broker request was not bound to the exact build identity: %#v", payload)
		}
		_ = json.NewEncoder(response).Encode(map[string]any{
			"repository": payload.Repository,
			"username":   "job-user",
			"password":   "job-password",
			"expiresAt":  time.Now().UTC().Add(14*time.Minute + 30*time.Second).Format(time.RFC3339Nano),
		})
	}))
	defer broker.Close()

	var dockerConfigPath string
	runner := &recordingRunner{metadataDigest: "sha256:" + strings.Repeat("c", 64), afterCommand: func(command worker.Command) {
		if command.Name != "buildctl" {
			return
		}
		dockerConfigPath = command.Env["DOCKER_CONFIG"]
		configBytes, err := os.ReadFile(filepath.Join(dockerConfigPath, "config.json"))
		if err != nil {
			t.Fatalf("read per-build Docker config: %v", err)
		}
		if !strings.Contains(string(configBytes), "am9iLXVzZXI6am9iLXBhc3N3b3Jk") {
			t.Fatalf("per-build Docker config did not contain issued credential: %s", configBytes)
		}
	}}
	config := liveSupplyChainConfig(workspaceDir, "registry.example.test/team")
	config.Production = true
	config.IsolationMode = "single-job-pod"
	config.RunOnce = true
	config.RegistryCredentialBrokerURL = broker.URL
	config.RegistryCredentialBrokerTokenFile = tokenFile
	config.RegistryCredentialBrokerHTTPClient = broker.Client()
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, config)

	result, err := builder.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("production build with exact-repository credential failed: %v", err)
	}
	if issuedRepository == "" || !strings.HasPrefix(result.Image, issuedRepository+":") {
		t.Fatalf("broker credential was not bound to authoritative output repository: issued=%q image=%q", issuedRepository, result.Image)
	}
	for _, command := range runner.commands {
		if command.Name == "buildctl" || command.Name == "trivy" || command.Name == "cosign" {
			if command.Env["DOCKER_CONFIG"] != dockerConfigPath || !command.CleanRegistryEnv {
				t.Fatalf("command did not use only the per-build registry credential: %#v", command)
			}
		}
	}
	if _, err := os.Stat(dockerConfigPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("per-build registry credential was retained after job: %v", err)
	}
}

func TestProductionBuilderRejectsCredentialThatCannotOutliveTheJob(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	state := readState(t, stateFile)
	firstByID(t, state, "projects", "prj_1")["organizationId"] = "org_1"
	writeStateAtPath(t, stateFile, state)
	tokenFile := filepath.Join(t.TempDir(), "broker-token")
	if err := os.WriteFile(tokenFile, []byte("test-broker-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	broker := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var payload struct {
			Repository string `json:"repository"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Errorf("decode broker request: %v", err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(response).Encode(map[string]any{
			"repository": payload.Repository,
			"username":   "job-user",
			"password":   "job-password",
			"expiresAt":  time.Now().UTC().Add(10 * time.Minute).Format(time.RFC3339Nano),
		})
	}))
	defer broker.Close()
	runner := &recordingRunner{}
	config := liveSupplyChainConfig(workspaceDir, "registry.example.test/team")
	config.Production = true
	config.IsolationMode = "single-job-pod"
	config.RunOnce = true
	config.RegistryCredentialBrokerURL = broker.URL
	config.RegistryCredentialBrokerTokenFile = tokenFile
	config.RegistryCredentialBrokerHTTPClient = broker.Client()
	config.RegistryCredentialMinTTL = 14 * time.Minute
	config.RegistryCredentialMaxTTL = 15 * time.Minute
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, config)

	_, err := builder.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "lifetime") {
		t.Fatalf("expected too-short credential rejection, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("build ran with a credential that expires before the job deadline: %#v", runner.commands)
	}
}

func TestProductionBuilderRejectsCredentialWindowShorterThanCommandTimeout(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	runner := &recordingRunner{}
	config := liveSupplyChainConfig(workspaceDir, "registry.example.test/team")
	config.Production = true
	config.IsolationMode = "single-job-pod"
	config.RunOnce = true
	config.RegistryCredentialBrokerURL = "https://credential-broker.example.test/v1/credentials"
	config.RegistryCredentialBrokerTokenFile = "/var/run/secrets/raibitserver/registry-broker/token"
	config.Timeout = 10 * time.Minute
	config.RegistryCredentialMinTTL = 10 * time.Minute
	config.RegistryCredentialMaxTTL = 15 * time.Minute
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, config)

	_, err := builder.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "outlive the build command timeout") {
		t.Fatalf("expected unsafe timeout window rejection, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("tenant code ran with an unsafe credential timeout window: %#v", runner.commands)
	}
}

func TestConfigFromEnvDefaultsToBoundedBuildAndCredentialWindow(t *testing.T) {
	t.Setenv("RAIBITSERVER_BUILD_TIMEOUT_SECONDS", "")
	t.Setenv("RAIBITSERVER_REGISTRY_CREDENTIAL_MIN_TTL_SECONDS", "")
	t.Setenv("RAIBITSERVER_REGISTRY_CREDENTIAL_MAX_TTL_SECONDS", "")

	config := worker.ConfigFromEnv()
	if config.Timeout != 10*time.Minute || config.RegistryCredentialMinTTL != 14*time.Minute || config.RegistryCredentialMaxTTL != 15*time.Minute {
		t.Fatalf("unexpected production timing defaults: timeout=%s minTTL=%s maxTTL=%s", config.Timeout, config.RegistryCredentialMinTTL, config.RegistryCredentialMaxTTL)
	}
}

func TestProductionBuilderRejectsBrokerCredentialForAnotherRepository(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	state := readState(t, stateFile)
	firstByID(t, state, "projects", "prj_1")["organizationId"] = "org_1"
	writeStateAtPath(t, stateFile, state)
	tokenFile := filepath.Join(t.TempDir(), "broker-token")
	if err := os.WriteFile(tokenFile, []byte("test-broker-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	broker := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]any{
			"repository": "registry.example.test/team/victim/private",
			"username":   "job-user",
			"password":   "job-password",
			"expiresAt":  time.Now().UTC().Add(5 * time.Minute).Format(time.RFC3339Nano),
		})
	}))
	defer broker.Close()
	runner := &recordingRunner{}
	config := liveSupplyChainConfig(workspaceDir, "registry.example.test/team")
	config.Production = true
	config.IsolationMode = "single-job-pod"
	config.RunOnce = true
	config.RegistryCredentialBrokerURL = broker.URL
	config.RegistryCredentialBrokerTokenFile = tokenFile
	config.RegistryCredentialBrokerHTTPClient = broker.Client()
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, config)

	_, err := builder.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "exact output repository") {
		t.Fatalf("expected cross-repository broker credential rejection, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("build ran with a credential issued for another repository: %#v", runner.commands)
	}
}

func TestBuilderCacheNamespaceSeparatesOrganizationsAndJobs(t *testing.T) {
	first := runIsolatedDryBuild(t, "org-a", "prj-shared", "svc-shared", "job-a", "Same", "same")
	second := runIsolatedDryBuild(t, "org-b", "prj-shared", "svc-shared", "job-a", "Same", "same")
	third := runIsolatedDryBuild(t, "org-a", "prj-shared", "svc-shared", "job-b", "Same", "same")

	firstNamespace := buildArgValue(first, "BUILDKIT_CACHE_MOUNT_NS")
	secondNamespace := buildArgValue(second, "BUILDKIT_CACHE_MOUNT_NS")
	thirdNamespace := buildArgValue(third, "BUILDKIT_CACHE_MOUNT_NS")
	if firstNamespace == "" || secondNamespace == "" || thirdNamespace == "" {
		t.Fatalf("cache namespace was not injected: %q %q %q", firstNamespace, secondNamespace, thirdNamespace)
	}
	if firstNamespace == secondNamespace {
		t.Fatalf("different organizations shared cache namespace %q", firstNamespace)
	}
	if firstNamespace == thirdNamespace {
		t.Fatalf("different jobs shared cache namespace %q", firstNamespace)
	}
}

func TestBuilderRejectsTenantCacheIdentityOverrides(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		payload map[string]any
	}{
		{name: "cacheRef", payload: map[string]any{"cacheRef": "registry.example.test/team/victim:cache"}},
		{name: "buildCacheRef", payload: map[string]any{"buildCacheRef": "registry.example.test/team/victim:cache"}},
		{name: "reserved-build-arg", payload: map[string]any{"buildArgs": map[string]any{"BUILDKIT_CACHE_MOUNT_NS": "victim"}}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
			state := readState(t, stateFile)
			payload := firstByID(t, state, "workflowJobs", "job_1")["payload"].(map[string]any)
			for key, value := range testCase.payload {
				payload[key] = value
			}
			writeStateAtPath(t, stateFile, state)
			runner := &recordingRunner{}
			builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.example.test/team", DryRun: true, Builder: "buildctl"})

			if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(strings.ToLower(err.Error()), "cache") {
				t.Fatalf("expected cache override rejection, got %v", err)
			}
			if len(runner.commands) != 0 {
				t.Fatalf("build ran after cache override rejection: %#v", runner.commands)
			}
		})
	}
}

func TestBuilderRejectsSourceImageDestinationOverrideWithinRegistryPrefix(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	state := readState(t, stateFile)
	firstByID(t, state, "projects", "prj_1")["organizationId"] = "org_1"
	firstByID(t, state, "workflowJobs", "job_1")["payload"].(map[string]any)["image"] = "registry.example.test/team/victim/private:latest"
	writeStateAtPath(t, stateFile, state)
	runner := &recordingRunner{}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.example.test/team", DryRun: true, Builder: "buildctl"})

	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "image destination override") {
		t.Fatalf("expected in-prefix image override rejection, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("build ran with attacker-selected image destination: %#v", runner.commands)
	}
}

func TestBuilderImageRepositoryUsesImmutableTenantIDsNotSlugsOrStoredOutputs(t *testing.T) {
	first := runIsolatedDryBuild(t, "org-a", "project-a", "service-a", "job-a", "same", "same")
	second := runIsolatedDryBuild(t, "org-b", "project-b", "service-b", "job-b", "same", "same")
	if first.Image == second.Image {
		t.Fatalf("cross-organization same-slug builds collided at %q", first.Image)
	}
	for _, result := range []*worker.Result{first, second} {
		if strings.Contains(result.Image, "/same/same:") || !strings.HasPrefix(result.Image, "registry.example.test/team/org-") {
			t.Fatalf("image repository was not derived from immutable identity segments: %q", result.Image)
		}
		if strings.Contains(result.Image, "victim/private") {
			t.Fatalf("stored image output overrode derived repository: %q", result.Image)
		}
	}
}

func TestBuilderPrebuiltImageFailsClosedWithoutAuthoritativeAuthorization(t *testing.T) {
	workspaceDir := t.TempDir()
	digest := "sha256:" + strings.Repeat("a", 64)
	stateFile := writePrebuiltBuildState(t, digest)
	runner := &recordingRunner{}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, liveSupplyChainConfig(workspaceDir, "registry.example.test/team"))

	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "authoritative control-plane authorization") {
		t.Fatalf("expected unauthorized prebuilt image to fail closed, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("unauthorized prebuilt image reached scan/sign commands: %#v", runner.commands)
	}
}

func TestBuilderAuthorizedPrebuiltImageIsNotSignedAsPlatformOutput(t *testing.T) {
	workspaceDir := t.TempDir()
	digest := "sha256:" + strings.Repeat("b", 64)
	stateFile := writePrebuiltBuildState(t, digest)
	store := &authorizingStore{Store: controlplane.NewFileStore(stateFile)}
	runner := &recordingRunner{}
	builder := worker.New(store, runner, liveSupplyChainConfig(workspaceDir, "registry.example.test/team"))

	result, err := builder.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("authorized prebuilt import failed: %v", err)
	}
	if store.calls != 1 || result.ImageDigest != digest {
		t.Fatalf("authorization was not applied to the exact digest: calls=%d result=%#v", store.calls, result)
	}
	if got := strings.Join(runner.commandNames(), ","); got != "trivy" {
		t.Fatalf("prebuilt image must be scanned but never platform-signed, got %s", got)
	}
}

func TestBuilderCleansRandomizedWorkspaceAndMetadataAfterSuccessAndFailure(t *testing.T) {
	for _, failCommand := range []string{"", "trivy"} {
		name := "success"
		if failCommand != "" {
			name = "failure"
		}
		t.Run(name, func(t *testing.T) {
			workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
			state := readState(t, stateFile)
			firstByID(t, state, "projects", "prj_1")["organizationId"] = "org_1"
			writeStateAtPath(t, stateFile, state)
			runner := &recordingRunner{metadataDigest: "sha256:" + strings.Repeat("c", 64), failCommand: failCommand}
			builder := worker.New(controlplane.NewFileStore(stateFile), runner, liveSupplyChainConfig(workspaceDir, "registry.example.test/team"))

			_, err := builder.RunOnce(context.Background())
			if failCommand == "" && err != nil {
				t.Fatalf("RunOnce failed: %v", err)
			}
			if failCommand != "" && err == nil {
				t.Fatal("expected simulated failure")
			}
			metadataFile := ""
			for _, command := range runner.commands {
				if command.Name == "buildctl" {
					metadataFile = commandArgValue(command.Args, "--metadata-file")
				}
			}
			if metadataFile == "" {
				t.Fatalf("build command omitted metadata file: %#v", runner.commands)
			}
			if _, statErr := os.Stat(metadataFile); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("metadata artifact was retained at %q: %v", metadataFile, statErr)
			}
			if strings.Contains(metadataFile, "job_1") {
				t.Fatalf("metadata path exposed predictable raw job ID: %q", metadataFile)
			}
			assertNoJobArtifactDirectories(t, workspaceDir)
		})
	}
}

func runIsolatedDryBuild(t *testing.T, organizationID, projectID, serviceID, jobID, projectSlug, serviceSlug string) *worker.Result {
	t.Helper()
	workspaceDir := t.TempDir()
	sourceDir := filepath.Join(workspaceDir, "source")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "Dockerfile"), []byte("FROM scratch\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stateFile := writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": projectID, "organizationId": organizationID, "name": projectSlug, "slug": projectSlug}},
		"services": []any{map[string]any{
			"id": serviceID, "projectId": projectID, "name": serviceSlug, "slug": serviceSlug, "sourceType": "local", "buildMode": "dockerfile", "localPath": sourceDir,
			"imageUrl": "registry.example.test/team/victim/private:latest", "registry": "registry.example.test/team/victim",
		}},
		"deployments": []any{map[string]any{
			"id": "deployment-" + jobID, "serviceId": serviceID, "projectId": projectID, "status": "queued", "commitSha": "abcdef123456", "imageUrl": "registry.example.test/team/victim/private:latest",
		}},
		"workflowJobs": []any{map[string]any{
			"id": jobID, "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "deployment-" + jobID,
			"payload":  map[string]any{"deploymentId": "deployment-" + jobID, "serviceId": serviceID, "projectId": projectID, "buildCache": "registry"},
			"attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z",
		}},
	})
	runner := &recordingRunner{}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.example.test/team", DryRun: true, Push: true, Builder: "buildctl"})
	result, err := builder.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce failed: %v", err)
	}
	if len(runner.commands) != 1 {
		t.Fatalf("expected one build command, got %#v", runner.commands)
	}
	result.Metadata["recordedCommand"] = runner.commands[0]
	return result
}

func buildArgValue(result *worker.Result, name string) string {
	command, _ := result.Metadata["recordedCommand"].(worker.Command)
	needle := name + "="
	for _, arg := range command.Args {
		if strings.HasPrefix(arg, "build-arg:"+needle) {
			return strings.TrimPrefix(arg, "build-arg:"+needle)
		}
		if strings.HasPrefix(arg, needle) {
			return strings.TrimPrefix(arg, needle)
		}
	}
	return ""
}

func writePrebuiltBuildState(t *testing.T, digest string) string {
	t.Helper()
	image := "registry.example.test/team/imported/image@" + digest
	return writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo"}},
		"services": []any{map[string]any{
			"id": "svc_1", "projectId": "prj_1", "name": "import", "slug": "import", "sourceType": "image", "buildMode": "prebuilt-image", "imageUrl": image,
		}},
		"deployments": []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "imageUrl": image, "imageDigest": digest}},
		"workflowJobs": []any{map[string]any{
			"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1",
			"payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1"}, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z",
		}},
	})
}

type authorizingStore struct {
	controlplane.Store
	calls int
}

func (s *authorizingStore) AuthorizePrebuiltImage(_ context.Context, organizationID, projectID, serviceID, image string) error {
	s.calls++
	if organizationID != "org_1" || projectID != "prj_1" || serviceID != "svc_1" || !strings.Contains(image, "@sha256:") {
		return errors.New("prebuilt authorization request did not bind exact tenant and digest")
	}
	return nil
}

func assertNoJobArtifactDirectories(t *testing.T, workspaceDir string) {
	t.Helper()
	entries, err := os.ReadDir(workspaceDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "job-") || entry.Name() == "job_1" {
			t.Fatalf("job artifact directory was retained: %s", filepath.Join(workspaceDir, entry.Name()))
		}
	}
	metadataDir := filepath.Join(workspaceDir, "metadata")
	metadataEntries, err := os.ReadDir(metadataDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if len(metadataEntries) != 0 {
		t.Fatalf("metadata artifacts were retained: %#v", metadataEntries)
	}
}
