package worker_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/raibitserver/builder/internal/controlplane"
	"github.com/raibitserver/builder/internal/worker"
)

func TestDeploymentSnapshotBuildUsesStoredInputs(t *testing.T) {
	// Given different durable, live-service, and editable-job inputs.
	path := writeGitBuildState(t, "https://github.com/acme/changed.git")
	state := readState(t, path)
	deployment := firstByID(t, state, "deployments", "dep_1")
	deployment["snapshotVersion"] = 1
	deployment["sourceDeploymentId"] = "dep_source"
	deployment["triggerType"] = "retry"
	deployment["branch"] = "release"
	deployment["commitSha"] = strings.Repeat("a", 40)
	deployment["desiredSpecSnapshot"] = map[string]any{
		"repoUrl": "https://github.com/acme/frozen.git", "sourceType": "github",
		"buildMode": "dockerfile", "buildContext": "frozen-context", "dockerfilePath": "frozen.Dockerfile",
		"buildArgs": map[string]any{"PUBLIC_VERSION": "frozen", "PUBLIC_COUNT": 42, "PUBLIC_ENABLED": true}, "branch": "snapshot-not-binding",
		"id": "foreign-service", "projectId": "foreign-project", "status": "DELETE_REQUESTED",
	}
	payload := firstByID(t, state, "workflowJobs", "job_1")["payload"].(map[string]any)
	for key, value := range map[string]any{
		"buildMode": "prebuilt-image", "buildContext": "job-context", "dockerfilePath": "job.Dockerfile",
		"buildArgs": map[string]any{"PUBLIC_VERSION": "job"}, "repoUrl": "https://github.com/acme/job.git",
		"branch": "job-branch", "commitSha": strings.Repeat("b", 40), "localPath": "/job-source",
		"source": map[string]any{"localPath": "/job-source"}, "snapshotVersion": 99,
		"desiredSpecSnapshot": map[string]any{"buildMode": "prebuilt-image"}, "imageUrl": "registry.example/job:latest",
	} {
		payload[key] = value
	}
	writeStateAtPath(t, path, state)
	builder := worker.New(controlplane.NewFileStore(path), worker.OSRunner{}, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.example.test", DryRun: true})
	// When the real worker claims and processes the persisted job.
	result, err := builder.RunOnce(context.Background())
	// Then only the snapshot config and Deployment source binding reach commands/publication.
	if err != nil {
		t.Fatal(err)
	}
	logs := marshalString(t, readState(t, path)["buildLogs"])
	for _, expected := range []string{"--branch release", "https://github.com/acme/frozen.git", "checkout " + strings.Repeat("a", 40), "frozen.Dockerfile", "frozen-context", "PUBLIC_VERSION=frozen", "PUBLIC_COUNT=42", "PUBLIC_ENABLED=true"} {
		if !strings.Contains(logs, expected) {
			t.Fatalf("missing immutable command input %q: %s", expected, logs)
		}
	}
	if result.Metadata["mode"] != "dockerfile" || firstByID(t, readState(t, path), "deployments", "dep_1")["status"] != "IMAGE_READY" {
		t.Fatal("snapshot did not complete Dockerfile publication")
	}
}

func TestDeploymentSnapshotRejectsInvalidLineageBeforeExecution(t *testing.T) {
	for _, row := range []struct {
		name   string
		fields map[string]any
	}{
		{"retry_without_snapshot", map[string]any{"triggerType": "retry"}},
		{"redeploy_without_snapshot", map[string]any{"triggerType": "redeploy"}},
		{"source_lineage_without_snapshot", map[string]any{"sourceDeploymentId": "dep_old"}},
		{"retry_lineage_without_snapshot", map[string]any{"retryOfDeploymentId": "dep_old"}},
		{"unknown_version", map[string]any{"snapshotVersion": 2, "desiredSpecSnapshot": map[string]any{"buildMode": "dockerfile"}}},
		{"unversioned_snapshot", map[string]any{"desiredSpecSnapshot": map[string]any{"buildMode": "dockerfile"}}},
		{"null_snapshot", map[string]any{"snapshotVersion": 1}},
		{"malformed_snapshot", map[string]any{"snapshotVersion": 1, "desiredSpecSnapshot": "not-an-object"}},
	} {
		t.Run(row.name, func(t *testing.T) {
			// Given an invalid durable snapshot contract.
			path := writeGitBuildState(t, "https://github.com/acme/web.git")
			state := readState(t, path)
			for key, value := range row.fields {
				firstByID(t, state, "deployments", "dep_1")[key] = value
			}
			writeStateAtPath(t, path, state)
			runner := &recordingRunner{}
			builder := worker.New(controlplane.NewFileStore(path), runner, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.example.test", DryRun: true})
			// When claimed by the real worker.
			_, err := builder.RunOnce(context.Background())
			// Then no source/build command or publication is allowed.
			if err == nil || len(runner.commands) != 0 {
				t.Fatalf("invalid snapshot executed: err=%v commands=%d", err, len(runner.commands))
			}
			if firstByID(t, readState(t, path), "deployments", "dep_1")["status"] == "IMAGE_READY" {
				t.Fatal("invalid snapshot published")
			}
		})
	}
}

func TestDeploymentSnapshotPreservesLiveDeletionFence(t *testing.T) {
	for _, target := range []string{"services", "projects"} {
		t.Run(target, func(t *testing.T) {
			// Given a live tombstone that the snapshot attempts to clear.
			path := writeGitBuildState(t, "https://github.com/acme/web.git")
			state := readState(t, path)
			id := map[string]string{"services": "svc_1", "projects": "prj_1"}[target]
			deployment := firstByID(t, state, "deployments", "dep_1")
			deployment["snapshotVersion"] = 1
			deployment["desiredSpecSnapshot"] = map[string]any{"sourceType": "github", "repoUrl": "https://github.com/acme/web.git", "buildMode": "dockerfile", "status": "active"}
			writeStateAtPath(t, path, state)
			runner := &recordingRunner{}
			store := snapshotClaimHookStore{Store: controlplane.NewFileStore(path), afterClaim: func() {
				live := readState(t, path)
				firstByID(t, live, target, id)["status"] = "DELETE_REQUESTED"
				writeStateAtPath(t, path, live)
			}}
			builder := worker.New(store, runner, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.example.test", DryRun: true})
			// When a snapshot build is claimed.
			_, err := builder.RunOnce(context.Background())
			// Then deletion cancels before commands.
			if !errors.Is(err, controlplane.ErrBuildTargetDeleting) || len(runner.commands) != 0 {
				t.Fatalf("live deletion fence lost: %v", err)
			}
		})
	}
}

type snapshotClaimHookStore struct {
	controlplane.Store
	afterClaim func()
}

func (s snapshotClaimHookStore) ClaimNextWorkflowJob(ctx context.Context, options controlplane.ClaimOptions) (*controlplane.WorkflowJob, error) {
	job, err := s.Store.ClaimNextWorkflowJob(ctx, options)
	if err == nil && job != nil {
		s.afterClaim()
	}
	return job, err
}

func TestDeploymentSnapshotCannotRestoreRevokedGitHubBinding(t *testing.T) {
	// Given a removed live binding and an old snapshot containing it.
	path := writeGitBuildState(t, "https://github.com/acme/web.git")
	state := readState(t, path)
	deployment := firstByID(t, state, "deployments", "dep_1")
	deployment["snapshotVersion"] = 1
	deployment["desiredSpecSnapshot"] = map[string]any{
		"sourceType": "github", "repoUrl": "https://github.com/acme/web.git", "buildMode": "dockerfile",
		"githubIntegrationId": "revoked", "githubInstallationId": "202", "githubRepositoryId": "101",
		"githubRepository": "acme/web", "githubRepositoryVisibility": "private",
	}
	writeStateAtPath(t, path, state)
	runner := &recordingRunner{}
	builder := worker.New(controlplane.NewFileStore(path), runner, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.example.test", DryRun: true})
	// When a retry consumes the durable snapshot.
	_, err := builder.RunOnce(context.Background())
	// Then stale authority cannot become an anonymous clone or restore credentials.
	if err == nil || len(runner.commands) != 0 {
		t.Fatalf("snapshot restored revoked binding: err=%v commands=%d", err, len(runner.commands))
	}
}

func TestDeploymentSnapshotBindsPrebuiltImageAndLiveAuthorization(t *testing.T) {
	for _, authorized := range []bool{true, false} {
		t.Run(map[bool]string{true: "authorized", false: "revoked"}[authorized], func(t *testing.T) {
			// Given different durable image, snapshot image, live image and job image.
			digest := "sha256:" + strings.Repeat("a", 64)
			path := writePrebuiltBuildState(t, digest)
			state := readState(t, path)
			deployment := firstByID(t, state, "deployments", "dep_1")
			bound := deployment["imageUrl"]
			deployment["snapshotVersion"] = 1
			deployment["desiredSpecSnapshot"] = map[string]any{"sourceType": "image", "buildMode": "prebuilt-image", "imageUrl": "registry.example.test/snapshot:mutable"}
			firstByID(t, state, "services", "svc_1")["imageUrl"] = "registry.example.test/live:mutable"
			firstByID(t, state, "workflowJobs", "job_1")["payload"].(map[string]any)["imageUrl"] = "registry.example.test/job:mutable"
			writeStateAtPath(t, path, state)
			var store controlplane.Store = controlplane.NewFileStore(path)
			if authorized {
				store = &authorizingStore{Store: store}
			}
			builder := worker.New(store, worker.OSRunner{}, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.example.test", DryRun: true})
			// When the real worker resolves prebuilt image authorization.
			result, err := builder.RunOnce(context.Background())
			// Then only the Deployment-bound digest is published, after live authorization.
			if !authorized {
				if err == nil || firstByID(t, readState(t, path), "deployments", "dep_1")["status"] == "IMAGE_READY" {
					t.Fatal("revoked image published")
				}
				return
			}
			if err != nil || result.Image != bound || result.ImageDigest != digest {
				t.Fatalf("bound image lost: result=%+v err=%v", result, err)
			}
		})
	}
}

func TestDeploymentSnapshotKeepsUserDockerfilePrecedence(t *testing.T) {
	// Given an auto snapshot with an existing user Dockerfile and changed live defaults.
	workspace, path := writeLocalDockerfileBuildState(t, nil)
	state := readState(t, path)
	service := firstByID(t, state, "services", "svc_1")
	deployment := firstByID(t, state, "deployments", "dep_1")
	deployment["snapshotVersion"] = 1
	deployment["desiredSpecSnapshot"] = map[string]any{"sourceType": "local", "localPath": service["localPath"], "buildMode": "auto"}
	service["buildMode"], service["dockerfilePath"] = "generated", "changed.Dockerfile"
	firstByID(t, state, "workflowJobs", "job_1")["payload"].(map[string]any)["buildMode"] = "generated"
	writeStateAtPath(t, path, state)
	builder := worker.New(controlplane.NewFileStore(path), worker.OSRunner{}, worker.Config{WorkspaceDir: workspace, Registry: "registry.example.test", DryRun: true})
	// When the worker selects a build plan.
	result, err := builder.RunOnce(context.Background())
	// Then the user Dockerfile still takes precedence over generated strategies.
	if err != nil || result.Metadata["mode"] != "dockerfile" {
		t.Fatalf("Dockerfile precedence lost: result=%+v err=%v", result, err)
	}
}

func TestDeploymentSnapshotResolvesCommitOnlyForInitialGitBuild(t *testing.T) {
	for _, trigger := range []string{"initial", "retry", "redeploy"} {
		t.Run(trigger, func(t *testing.T) {
			// Given a Git deployment without any durable commit binding.
			path := writeGitBuildState(t, "https://github.com/acme/web.git")
			state := readState(t, path)
			deployment := firstByID(t, state, "deployments", "dep_1")
			deployment["triggerType"], deployment["snapshotVersion"] = trigger, 1
			deployment["desiredSpecSnapshot"] = map[string]any{"sourceType": "github", "repoUrl": "https://github.com/acme/web.git", "buildMode": "dockerfile"}
			writeStateAtPath(t, path, state)
			runner := &recordingRunner{}
			builder := worker.New(controlplane.NewFileStore(path), runner, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.example.test", DryRun: true})
			// When resolving and executing the build.
			_, err := builder.RunOnce(context.Background())
			// Then only the initial deployment may pin branch HEAD once.
			if trigger != "initial" {
				if err == nil || len(runner.commands) != 0 {
					t.Fatalf("lineage re-resolved HEAD: err=%v commands=%d", err, len(runner.commands))
				}
				return
			}
			persisted := firstByID(t, readState(t, path), "deployments", "dep_1")
			if err != nil || persisted["commitSha"] == nil || persisted["status"] != "IMAGE_READY" {
				t.Fatalf("initial source was not pinned: %v", err)
			}
		})
	}
}
