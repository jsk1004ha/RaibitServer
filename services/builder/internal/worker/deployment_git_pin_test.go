package worker_test

import (
	"context"
	"strings"
	"testing"

	"github.com/raibitserver/builder/internal/controlplane"
	"github.com/raibitserver/builder/internal/worker"
)

func TestDeploymentSnapshotResolvesCommitOnlyForInitialGitBuild(t *testing.T) {
	full := strings.Repeat("a", 40)
	for _, row := range []struct {
		name, trigger, sha, hash, kind string
		rejected                       bool
	}{
		{"initial", "initial", "", "", "git", false},
		{"retry", "retry", "", "", "git", true},
		{"redeploy", "redeploy", " ", "", "git", true},
		{"abbreviated", "retry", "abc123", "", "git", true},
		{"branch", "retry", "main", "", "git", true},
		{"tag", "retry", "refs/tags/v1", "", "git", true},
		{"zero40", "retry", strings.Repeat("0", 40), "", "git", true},
		{"zero64", "retry", strings.Repeat("0", 64), "", "git", true},
		{"nonhex", "retry", strings.Repeat("g", 40), "", "git", true},
		{"normalized40", "retry", " " + strings.ToUpper(full) + " ", "", "git", false},
		{"valid64", "retry", strings.Repeat("b", 64), "", "git", false},
		{"hash_fallback", "retry", " ", full, "git", false},
		{"conflict", "retry", full, strings.Repeat("b", 40), "git", true},
		{"invalid_primary", "retry", "HEAD", full, "git", true},
		{"invalid_secondary", "retry", full, "HEAD", "git", true},
		{"matching_pins", "retry", strings.ToUpper(full), " " + full + " ", "git", false},
		{"local_precedence", "retry", "", "", "local", false},
		{"image_precedence", "retry", "", "", "image", false},
		{"mode_precedence", "retry", "", "", "prebuilt_image", false},
		{"mode_alias", "retry", "", "", "prebuilt", false},
		{"implicit_image", "retry", "", "", "implicit", false},
	} {
		t.Run(row.name, func(t *testing.T) {
			// Given stored pins and the captured source, with hostile editable job pins.
			workspace, path := writeLocalDockerfileBuildState(t, nil)
			state := readState(t, path)
			deployment := firstByID(t, state, "deployments", "dep_1")
			deployment["triggerType"], deployment["snapshotVersion"] = row.trigger, 1
			deployment["commitSha"], deployment["commitHash"] = row.sha, row.hash
			spec := map[string]any{"sourceType": "github", "repoUrl": "https://github.com/acme/web.git", "buildMode": "dockerfile"}
			switch row.kind {
			case "local":
				spec["localPath"] = firstByID(t, state, "services", "svc_1")["localPath"]
			case "image":
				spec["sourceType"] = "image"
			case "prebuilt_image", "prebuilt":
				spec["buildMode"] = row.kind
			case "implicit":
				delete(spec, "repoUrl")
			}
			deployment["desiredSpecSnapshot"] = spec
			deployment["imageUrl"] = "registry.example.test/image@sha256:" + strings.Repeat("c", 64)
			firstByID(t, state, "projects", "prj_1")["organizationId"] = "org_1"
			firstByID(t, state, "workflowJobs", "job_1")["payload"].(map[string]any)["commitSha"] = strings.Repeat("d", 40)
			writeStateAtPath(t, path, state)
			runner := &recordingRunner{}
			store := &authorizingStore{Store: controlplane.NewFileStore(path)}
			builder := worker.New(store, runner, worker.Config{WorkspaceDir: workspace, Registry: "registry.example.test", DryRun: true})
			// When resolving and executing the build.
			_, err := builder.RunOnce(context.Background())
			// Then only the initial deployment may pin branch HEAD once.
			if row.rejected {
				if err == nil || len(runner.commands) != 0 {
					t.Fatalf("lineage re-resolved HEAD: err=%v commands=%d", err, len(runner.commands))
				}
				return
			}
			persisted := firstByID(t, readState(t, path), "deployments", "dep_1")
			if err != nil || persisted["commitSha"] == nil || persisted["status"] != "IMAGE_READY" {
				t.Fatalf("initial source was not pinned: %v", err)
			}
			if row.kind == "git" && row.trigger != "initial" {
				pin := strings.TrimSpace(row.sha)
				if pin == "" {
					pin = strings.TrimSpace(row.hash)
				}
				if len(runner.commands) < 2 || strings.Join(runner.commands[1].Args, " ") != "checkout "+strings.ToLower(pin) {
					t.Fatal("worker did not checkout normalized durable pin")
				}
			}
		})
	}
}
