package worker_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/raibitserver/builder/internal/controlplane"
	"github.com/raibitserver/builder/internal/worker"
)

const templateCatalogDigest = "sha256:fa54ee625c526450d7df2fc752059b7166de52f8c32b7b07b4b0f7212b6ddd1a"
const templateFastAPIDigest = "sha256:18a5bff72874736f820ead48cf869c3464a91e72e616528bdacda673c5a7e3d5"

func TestBuilderDispatchesVersionedTemplateSnapshotToPackagedSource(t *testing.T) {
	root, stateFile := writeTemplateBuildState(t, templateCatalogDigest)
	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{
		WorkspaceDir: t.TempDir(), Registry: "registry.example.test", DryRun: true, Production: true,
		TemplateCatalogPath: filepath.Join(root, "test-fixtures", "contracts", "starter-catalog-v1.json"),
		TemplateBundlePath:  filepath.Join(root, "test-fixtures", "contracts", "starter-catalog-v1.bundle.json"),
	})
	result, err := builder.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Steps) == 0 || result.Steps[0].Type != "source-template" || result.Steps[0].Detail != "fastapi/v1" {
		t.Fatalf("template source was not dispatched: %#v", result.Steps)
	}
	if !strings.HasSuffix(result.Image, ":template-"+strings.TrimPrefix(templateFastAPIDigest, "sha256:")) {
		t.Fatalf("production template image did not use its immutable source digest: %s", result.Image)
	}
	logs := marshalString(t, readState(t, stateFile)["buildLogs"])
	if strings.Contains(logs, "git clone") || !strings.Contains(logs, "materialized checksummed packaged template fastapi/v1") {
		t.Fatalf("unexpected source execution logs: %s", logs)
	}
	if firstByID(t, readState(t, stateFile), "deployments", "dep_template")["status"] != "IMAGE_READY" {
		t.Fatal("packaged template build did not publish image-ready")
	}
}

func TestBuilderRejectsTemplateDigestMismatchBeforeBuildExecution(t *testing.T) {
	root, stateFile := writeTemplateBuildState(t, "sha256:"+strings.Repeat("0", 64))
	runner := &recordingRunner{}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{
		WorkspaceDir: t.TempDir(), Registry: "registry.example.test", DryRun: true,
		TemplateCatalogPath: filepath.Join(root, "test-fixtures", "contracts", "starter-catalog-v1.json"),
		TemplateBundlePath:  filepath.Join(root, "test-fixtures", "contracts", "starter-catalog-v1.bundle.json"),
	})
	_, err := builder.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "catalog digest mismatch") {
		t.Fatalf("expected exact digest rejection, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("digest mismatch reached build execution: %#v", runner.commands)
	}
	if firstByID(t, readState(t, stateFile), "deployments", "dep_template")["status"] == "IMAGE_READY" {
		t.Fatal("digest mismatch falsely published image-ready")
	}
}

func TestBuilderTemplateUsesLiveDockerfilePipelineAndFrozenSource(t *testing.T) {
	root, stateFile := writeTemplateBuildState(t, templateCatalogDigest)
	state := readState(t, stateFile)
	deployment := firstByID(t, state, "deployments", "dep_template")
	deployment["imageUrl"], deployment["imageDigest"] = "registry.example.test/previous@sha256:"+strings.Repeat("b", 64), "sha256:"+strings.Repeat("b", 64)
	service := firstByID(t, state, "services", "svc_template")
	service["sourceType"], service["repoUrl"], service["localPath"] = "github", "https://github.com/acme/changed.git", "/untrusted"
	payload := firstByID(t, state, "workflowJobs", "job_template")["payload"].(map[string]any)
	payload["localPath"], payload["dockerfilePath"], payload["sourceDigest"] = "/untrusted", "../Dockerfile", "sha256:forged"
	writeStateAtPath(t, stateFile, state)
	digest := "sha256:" + strings.Repeat("a", 64)
	runner := &recordingRunner{metadataDigest: digest, afterCommand: func(command worker.Command) {
		if command.Name != "buildctl" {
			return
		}
		var contextDir string
		for _, arg := range command.Args {
			if strings.HasPrefix(arg, "context=") {
				contextDir = strings.TrimPrefix(arg, "context=")
			}
		}
		contents, err := os.ReadFile(filepath.Join(contextDir, "Dockerfile"))
		if err != nil || !strings.Contains(string(contents), "HEALTHCHECK") {
			t.Fatalf("live build did not receive packaged Dockerfile: %v", err)
		}
	}}
	config := liveSupplyChainConfig(t.TempDir(), "registry.example.test")
	config.TemplateCatalogPath = filepath.Join(root, "test-fixtures", "contracts", "starter-catalog-v1.json")
	config.TemplateBundlePath = filepath.Join(root, "test-fixtures", "contracts", "starter-catalog-v1.bundle.json")
	result, err := worker.New(controlplane.NewFileStore(stateFile), runner, config).RunOnce(context.Background())
	if err != nil || result.ImageDigest != digest {
		t.Fatalf("template live build failed: result=%+v err=%v", result, err)
	}
	if got := strings.Join(runner.commandNames(), ","); got != "buildctl,trivy,cosign,cosign" {
		t.Fatalf("template bypassed Dockerfile supply-chain pipeline: %s", got)
	}
}

func TestBuilderRejectsTemplateSourceOverrides(t *testing.T) {
	for _, field := range []string{"localPath", "repoUrl", "repositoryUrl", "dockerfilePath", "buildContext", "rootDirectory", "buildMode", "sourceUrl"} {
		t.Run(field, func(t *testing.T) {
			root, stateFile := writeTemplateBuildState(t, templateCatalogDigest)
			state := readState(t, stateFile)
			snapshot := firstByID(t, state, "deployments", "dep_template")["desiredSpecSnapshot"].(map[string]any)
			if field == "sourceUrl" {
				snapshot["source"].(map[string]any)["url"] = "https://example.test/archive.zip"
			} else {
				snapshot[field] = "override"
			}
			writeStateAtPath(t, stateFile, state)
			runner := &recordingRunner{}
			builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{
				WorkspaceDir: t.TempDir(), Registry: "registry.example.test", DryRun: true,
				TemplateCatalogPath: filepath.Join(root, "test-fixtures", "contracts", "starter-catalog-v1.json"),
				TemplateBundlePath:  filepath.Join(root, "test-fixtures", "contracts", "starter-catalog-v1.bundle.json"),
			})
			if _, err := builder.RunOnce(context.Background()); err == nil || len(runner.commands) != 0 {
				t.Fatalf("template source override reached build execution: error=%v commands=%+v", err, runner.commands)
			}
		})
	}
}

func writeTemplateBuildState(t *testing.T, digest string) (string, string) {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := map[string]any{
		"sourceType": "template", "buildMode": "dockerfile", "dockerfilePath": "Dockerfile",
		"source": map[string]any{"type": "template", "catalogId": "fastapi", "catalogVersion": "v1", "catalogDigest": digest, "sourceDigest": templateFastAPIDigest},
	}
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_template", "organizationId": "org_template", "name": "Template", "slug": "template"}},
		"services":     []any{map[string]any{"id": "svc_template", "projectId": "prj_template", "name": "api", "slug": "api", "sourceType": "template", "buildMode": "dockerfile", "status": "CREATED"}},
		"deployments":  []any{map[string]any{"id": "dep_template", "serviceId": "svc_template", "projectId": "prj_template", "status": "QUEUED", "snapshotVersion": 1, "desiredSpecSnapshot": snapshot}},
		"workflowJobs": []any{map[string]any{"id": "job_template", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_template", "payload": map[string]any{"deploymentId": "dep_template", "serviceId": "svc_template", "projectId": "prj_template", "templateResourceIds": []any{}}, "attempts": 0, "maxAttempts": 2, "runAfter": "2026-01-01T00:00:00Z"}},
	})
	return root, stateFile
}
