package worker_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/builder/internal/controlplane"
	"github.com/raibitserver/builder/internal/worker"
)

func TestBuilderClaimsJobBuildsAndPersistsImageReadyState(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "sourceType": "github", "buildMode": "dockerfile", "repoUrl": "https://github.com/acme/web.git", "branch": "main", "dockerfilePath": "Dockerfile", "registry": "registry.local"}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "branch": "main", "commitSha": "abc123"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "buildArgs": map[string]any{"PUBLIC_VERSION": "2026.07"}}, "attempts": 0, "maxAttempts": 2, "runAfter": "2026-01-01T00:00:00Z"}},
	})

	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkerID: "builder-test", WorkspaceDir: t.TempDir(), Registry: "registry.local", DryRun: true, Push: true})
	result, err := builder.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce failed: %v", err)
	}
	if !result.Processed || result.JobID != "job_1" {
		t.Fatalf("unexpected result: %#v", result)
	}
	if result.ImageDigest == "" || !strings.HasPrefix(result.ImageDigest, "sha256:") {
		t.Fatalf("expected deterministic image digest, got %q", result.ImageDigest)
	}

	state := readState(t, stateFile)
	deployment := firstByID(t, state, "deployments", "dep_1")
	if deployment["status"] != "IMAGE_READY" {
		t.Fatalf("deployment not image-ready: %#v", deployment)
	}
	if deployment["imageDigest"] != result.ImageDigest {
		t.Fatalf("image digest not persisted: %#v", deployment)
	}
	job := firstByID(t, state, "workflowJobs", "job_1")
	if job["status"] != "succeeded" || job["lockedBy"] != nil {
		t.Fatalf("job not completed and unlocked: %#v", job)
	}
	logs := mustArray(state["buildLogs"])
	joined := marshalString(t, logs)
	if !strings.Contains(joined, "git clone") || !strings.Contains(joined, "docker buildx build") || !strings.Contains(joined, "--push") {
		t.Fatalf("expected clone/build/push log lines, got %s", joined)
	}
	if !strings.Contains(joined, "--build-arg PUBLIC_VERSION=2026.07") {
		t.Fatalf("safe build arg was not preserved: %s", joined)
	}
	events := marshalString(t, state["deploymentEvents"])
	if !strings.Contains(events, "build.image_ready") {
		t.Fatalf("expected image-ready event, got %s", events)
	}
}

func TestBuilderRejectsSecretLookingBuildArgs(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, map[string]any{"API_TOKEN": "do-not-pass-on-cli"})
	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.example.test", DryRun: true, Push: true})

	_, err := builder.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "secret-looking build arg") {
		t.Fatalf("expected secret-looking build arg rejection, got %v", err)
	}
	state := readState(t, stateFile)
	if deployment := firstByID(t, state, "deployments", "dep_1"); deployment["status"] != "BUILD_FAILED" {
		t.Fatalf("secret build arg must fail deployment closed: %#v", deployment)
	}
	if strings.Contains(marshalString(t, state), "do-not-pass-on-cli") {
		t.Fatalf("secret build arg leaked into persisted state: %s", marshalString(t, state))
	}
}

func TestBuilderLiveBuildRequiresRegistryDigestMetadata(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	state := readState(t, stateFile)
	firstByID(t, state, "deployments", "dep_1")["imageDigest"] = "sha256:" + strings.Repeat("c", 64)
	bytes, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stateFile, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, liveSupplyChainConfig(workspaceDir, "registry.example.test"))

	_, err = builder.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "registry digest") {
		t.Fatalf("expected missing registry digest to fail closed, got %v", err)
	}
	if len(runner.commands) != 1 || runner.commands[0].Name != "buildctl" {
		t.Fatalf("expected one buildctl build, got %#v", runner.commands)
	}
	command := strings.Join(runner.commands[0].Args, " ")
	if !strings.Contains(command, "--metadata-file") || !strings.Contains(command, "push=true") {
		t.Fatalf("buildctl must push and write digest metadata: %s", command)
	}
	for flag, expected := range map[string]string{
		"--addr":          "tcp://127.0.0.1:1234",
		"--tlsdir":        "/var/run/secrets/raibitserver/buildkit",
		"--tlsservername": "raibit-buildkit",
	} {
		if actual := commandArgValue(runner.commands[0].Args, flag); actual != expected {
			t.Fatalf("buildctl %s mismatch: got %q want %q in %s", flag, actual, expected, command)
		}
	}
	if deployment := firstByID(t, readState(t, stateFile), "deployments", "dep_1"); deployment["status"] == "IMAGE_READY" {
		t.Fatalf("deployment became image-ready without registry digest: %#v", deployment)
	}
}

func TestBuilderScansAndSignsDigestBeforeImageReady(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, map[string]any{"PUBLIC_VERSION": "2026.07"})
	digest := "sha256:" + strings.Repeat("a", 64)
	runner := &recordingRunner{metadataDigest: digest}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{
		WorkspaceDir:          workspaceDir,
		Registry:              "registry.example.test",
		DryRun:                false,
		Push:                  true,
		Builder:               "buildctl",
		BuildkitAddress:       "tcp://127.0.0.1:1234",
		BuildkitTLSDirectory:  "/var/run/secrets/raibitserver/buildkit",
		BuildkitTLSServerName: "raibit-buildkit",
		Scan:                  true,
		Scanner:               "trivy",
		Sign:                  true,
		Signer:                "cosign",
		SigningKeyPath:        "/var/run/secrets/raibitserver/signing/cosign.key",
		VerificationKeyPath:   "/var/run/secrets/raibitserver/verification/cosign.pub",
	})

	result, err := builder.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce failed: %v", err)
	}
	if result.ImageDigest != digest {
		t.Fatalf("expected registry digest %q, got %q", digest, result.ImageDigest)
	}
	if got := runner.commandNames(); strings.Join(got, ",") != "buildctl,trivy,cosign,cosign" {
		t.Fatalf("expected build, scan, sign ordering, got %#v", got)
	}
	signArgs := strings.Join(runner.commands[2].Args, " ")
	for _, required := range []string{
		"--new-bundle-format=false",
		"--use-signing-config=false",
		"--registry-referrers-mode=legacy",
	} {
		if !strings.Contains(signArgs, required) {
			t.Fatalf("cosign signing command missing %q: %s", required, signArgs)
		}
	}
	state := readState(t, stateFile)
	if deployment := firstByID(t, state, "deployments", "dep_1"); deployment["status"] != "IMAGE_READY" {
		t.Fatalf("deployment not image-ready after supply-chain checks: %#v", deployment)
	}
	events := marshalString(t, state["deploymentEvents"])
	if !strings.Contains(events, "build.image_scanned") || !strings.Contains(events, "build.image_signed") || !strings.Contains(events, digest) {
		t.Fatalf("missing scan/sign evidence: %s", events)
	}
}

func TestBuilderAtomicBuildStartRejectsTombstoneAfterInitialParentCheck(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	state := readState(t, stateFile)
	firstByID(t, state, "workflowJobs", "job_1")["maxAttempts"] = 3
	writeStateAtPath(t, stateFile, state)
	fileStore := controlplane.NewFileStore(stateFile)
	store := &tombstoneBeforeStartStore{Store: fileStore, fileStore: fileStore}
	runner := &recordingRunner{}
	builder := worker.New(store, runner, liveSupplyChainConfig(workspaceDir, "registry.example.test/team"))

	result, err := builder.RunOnce(context.Background())
	if !errors.Is(err, controlplane.ErrBuildTargetDeleting) {
		t.Fatalf("expected atomic build-start deletion rejection, got result=%#v err=%v", result, err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("build command ran after parent tombstone: %#v", runner.commands)
	}
	state = readState(t, stateFile)
	deployment := firstByID(t, state, "deployments", "dep_1")
	if deployment["status"] != "queued" || deployment["buildStartedAt"] != nil {
		t.Fatalf("atomic build start wrote BUILDING after tombstone: %#v", deployment)
	}
	assertDeletionCancelledWithoutPublication(t, stateFile)
}

func TestBuilderDoesNotOverwriteDeploymentAfterBuildStartLeaseLoss(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	baseStore := controlplane.NewFileStore(stateFile)
	store := &leaseLostBeforeStartStore{Store: baseStore}
	runner := &recordingRunner{}
	builder := worker.New(store, runner, liveSupplyChainConfig(workspaceDir, "registry.example.test/team"))

	result, err := builder.RunOnce(context.Background())
	if !errors.Is(err, controlplane.ErrWorkflowLeaseLost) {
		t.Fatalf("expected build-start lease loss, got result=%#v err=%v", result, err)
	}
	if store.failureWriteAttempted {
		t.Fatal("lease loss attempted to overwrite the deployment or workflow with BUILD_FAILED")
	}
	if len(runner.commands) != 0 {
		t.Fatalf("build command ran after the workflow lease was lost: %#v", runner.commands)
	}
	deployment := firstByID(t, readState(t, stateFile), "deployments", "dep_1")
	if deployment["status"] != "queued" || deployment["buildStartedAt"] != nil {
		t.Fatalf("lease loss mutated deployment state: %#v", deployment)
	}
}

func TestBuilderStopsBeforeScanWhenServiceIsTombstonedMidBuild(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	state := readState(t, stateFile)
	firstByID(t, state, "workflowJobs", "job_1")["maxAttempts"] = 3
	writeStateAtPath(t, stateFile, state)
	store := controlplane.NewFileStore(stateFile)
	runner := &recordingRunner{
		metadataDigest: "sha256:" + strings.Repeat("e", 64),
		afterCommand: func(command worker.Command) {
			if command.Name == "buildctl" {
				if _, err := store.UpdateService(context.Background(), "svc_1", map[string]any{"status": "DELETE_REQUESTED"}); err != nil {
					t.Fatalf("tombstone service: %v", err)
				}
			}
		},
	}
	builder := worker.New(store, runner, liveSupplyChainConfig(workspaceDir, "registry.example.test/team"))

	result, err := builder.RunOnce(context.Background())
	if !errors.Is(err, controlplane.ErrBuildTargetDeleting) {
		t.Fatalf("expected deletion cancellation, got result=%#v err=%v", result, err)
	}
	if got := strings.Join(runner.commandNames(), ","); got != "buildctl" {
		t.Fatalf("scan/sign ran after tombstone appeared: %s", got)
	}
	assertDeletionCancelledWithoutPublication(t, stateFile)
}

func TestBuilderFinalPublicationFenceRejectsTombstoneAfterSigning(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	state := readState(t, stateFile)
	firstByID(t, state, "workflowJobs", "job_1")["maxAttempts"] = 3
	writeStateAtPath(t, stateFile, state)
	store := controlplane.NewFileStore(stateFile)
	runner := &recordingRunner{
		metadataDigest: "sha256:" + strings.Repeat("f", 64),
		afterCommand: func(command worker.Command) {
			if command.Name == "cosign" {
				state := readState(t, stateFile)
				firstByID(t, state, "projects", "prj_1")["status"] = "DELETING"
				writeStateAtPath(t, stateFile, state)
			}
		},
	}
	builder := worker.New(store, runner, liveSupplyChainConfig(workspaceDir, "registry.example.test/team"))

	result, err := builder.RunOnce(context.Background())
	if !errors.Is(err, controlplane.ErrBuildTargetDeleting) {
		t.Fatalf("expected deletion cancellation, got result=%#v err=%v", result, err)
	}
	if got := strings.Join(runner.commandNames(), ","); got != "buildctl,trivy,cosign" {
		t.Fatalf("unexpected supply-chain command order: %s", got)
	}
	assertDeletionCancelledWithoutPublication(t, stateFile)
}

func TestBuilderScanFailurePreventsSigningAndImageReady(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	runner := &recordingRunner{metadataDigest: "sha256:" + strings.Repeat("b", 64), failCommand: "trivy"}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{
		WorkspaceDir:        workspaceDir,
		Registry:            "registry.example.test",
		DryRun:              false,
		Push:                true,
		Builder:             "buildctl",
		Scan:                true,
		Scanner:             "trivy",
		Sign:                true,
		Signer:              "cosign",
		SigningKeyPath:      "/var/run/secrets/raibitserver/signing/cosign.key",
		VerificationKeyPath: "/var/run/secrets/raibitserver/verification/cosign.pub",
	})

	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "simulated trivy failure") {
		t.Fatalf("expected scanner failure, got %v", err)
	}
	if got := strings.Join(runner.commandNames(), ","); got != "buildctl,trivy" {
		t.Fatalf("signing must not run after scan failure, got %s", got)
	}
	if deployment := firstByID(t, readState(t, stateFile), "deployments", "dep_1"); deployment["status"] == "IMAGE_READY" {
		t.Fatalf("scan failure must prevent image-ready: %#v", deployment)
	}
}

func TestBuilderLateFailureCannotOverwriteExhaustedLeaseReaperEvidence(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	store := controlplane.NewFileStore(stateFile)
	reaped := false
	runner := &recordingRunner{
		metadataDigest: "sha256:" + strings.Repeat("b", 64),
		failCommand:    "trivy",
		afterCommand: func(command worker.Command) {
			if command.Name != "buildctl" {
				return
			}
			claimed, err := store.ClaimNextWorkflowJob(context.Background(), controlplane.ClaimOptions{
				WorkerID: "replacement-worker", LeaseSeconds: 1, Now: time.Now().UTC().Add(2 * time.Second),
			})
			if err != nil {
				t.Fatalf("reap expired final attempt: %v", err)
			}
			if claimed != nil {
				t.Fatalf("final attempt was reclaimed instead of reaped: %#v", claimed)
			}
			reaped = true
		},
	}
	config := liveSupplyChainConfig(workspaceDir, "registry.example.test/team")
	config.LeaseSeconds = 1
	builder := worker.New(store, runner, config)

	if _, err := builder.RunOnce(context.Background()); err == nil {
		t.Fatal("expected the late worker to lose its terminalized lease")
	}
	if !reaped {
		t.Fatal("test did not exercise exhausted lease recovery")
	}
	state := readState(t, stateFile)
	job := firstByID(t, state, "workflowJobs", "job_1")
	deployment := firstByID(t, state, "deployments", "dep_1")
	payload := job["payload"].(map[string]any)
	const fixedMessage = "build worker lease expired after the final allowed attempt"
	if job["status"] != "failed" || payload["lastError"] != fixedMessage {
		t.Fatalf("exhausted job failure was overwritten by late worker: %#v", job)
	}
	if deployment["status"] != "BUILD_FAILED" || deployment["errorCode"] != "BUILD_FAILED" || deployment["errorMessage"] != fixedMessage ||
		deployment["buildFinishedAt"] != payload["failedAt"] || deployment["imageDigest"] != nil {
		t.Fatalf("late worker overwrote reaper deployment evidence: %#v", deployment)
	}
}

func TestBuilderLiveBuildRejectsDisabledScanOrSign(t *testing.T) {
	for _, testCase := range []struct {
		name string
		scan bool
		sign bool
		want string
	}{
		{name: "scan-disabled", scan: false, sign: true, want: "vulnerability scanning"},
		{name: "sign-disabled", scan: true, sign: false, want: "image signing"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
			runner := &recordingRunner{}
			builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{
				WorkspaceDir:        workspaceDir,
				Registry:            "registry.example.test/team",
				DryRun:              false,
				Push:                true,
				Builder:             "buildctl",
				Scan:                testCase.scan,
				Sign:                testCase.sign,
				SigningKeyPath:      "/var/run/secrets/raibitserver/signing/cosign.key",
				VerificationKeyPath: "/var/run/secrets/raibitserver/verification/cosign.pub",
			})
			if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("expected disabled %s policy to fail closed, got %v", testCase.name, err)
			}
			state := readState(t, stateFile)
			if deployment := firstByID(t, state, "deployments", "dep_1"); deployment["status"] != "BUILD_FAILED" {
				t.Fatalf("policy failure must mark deployment failed: %#v", deployment)
			}
			if !strings.Contains(marshalString(t, state["deploymentEvents"]), "build.supply_chain_policy_failed") {
				t.Fatalf("missing non-secret policy failure evidence: %s", marshalString(t, state["deploymentEvents"]))
			}
			if len(runner.commands) != 0 {
				t.Fatalf("build command ran before policy validation: %#v", runner.commands)
			}
		})
	}
}

func TestBuilderSignFailurePreventsImageReady(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	runner := &recordingRunner{metadataDigest: "sha256:" + strings.Repeat("d", 64), failCommand: "cosign"}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{
		WorkspaceDir:        workspaceDir,
		Registry:            "registry.example.test/team",
		DryRun:              false,
		Push:                true,
		Builder:             "buildctl",
		Scan:                true,
		Sign:                true,
		SigningKeyPath:      "/var/run/secrets/raibitserver/signing/cosign.key",
		VerificationKeyPath: "/var/run/secrets/raibitserver/verification/cosign.pub",
	})
	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "simulated cosign failure") {
		t.Fatalf("expected signing failure, got %v", err)
	}
	if got := strings.Join(runner.commandNames(), ","); got != "buildctl,trivy,cosign" {
		t.Fatalf("unexpected command order: %s", got)
	}
	state := readState(t, stateFile)
	if deployment := firstByID(t, state, "deployments", "dep_1"); deployment["status"] == "IMAGE_READY" {
		t.Fatalf("signing failure must prevent image-ready: %#v", deployment)
	}
	if !strings.Contains(marshalString(t, state["deploymentEvents"]), "build.image_sign_failed") {
		t.Fatalf("missing signing failure evidence: %s", marshalString(t, state["deploymentEvents"]))
	}
}

func TestBuilderRejectsSourceRegistryDestinationOverride(t *testing.T) {
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
	state := readState(t, stateFile)
	firstByID(t, state, "workflowJobs", "job_1")["payload"].(map[string]any)["image"] = "registry.example.test/other/api:latest"
	writeStateAtPath(t, stateFile, state)
	runner := &recordingRunner{}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, liveSupplyChainConfig(workspaceDir, "registry.example.test/team"))
	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "image destination override") {
		t.Fatalf("expected source image destination override rejection, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("build ran with unauthorized destination: %#v", runner.commands)
	}
}

func TestBuilderRejectsPrivateRegistryOverride(t *testing.T) {
	for _, registry := range []string{"localhost:5000/team", "10.1.2.3/team", "registry.internal.local/team"} {
		t.Run(registry, func(t *testing.T) {
			workspaceDir, stateFile := writeLocalDockerfileBuildState(t, nil)
			builder := worker.New(controlplane.NewFileStore(stateFile), &recordingRunner{}, liveSupplyChainConfig(workspaceDir, registry))
			if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "private") {
				t.Fatalf("expected private registry rejection for %q, got %v", registry, err)
			}
		})
	}
}

func TestBuilderRejectsCredentialedGitURLVariants(t *testing.T) {
	for _, testCase := range []struct {
		url    string
		secret string
	}{
		{url: "http://user:http-secret@github.com/acme/web.git", secret: "http-secret"},
		{url: "https://github.com/acme/web.git?access_token=query-secret", secret: "query-secret"},
		{url: "https://github.com/acme/web.git?client_secret=oauth-secret", secret: "oauth-secret"},
		{url: "ssh://user:ssh-secret@github.com/acme/web.git", secret: "ssh-secret"},
		{url: "git+ssh://github.com/acme/web.git?access_token=scheme-query-secret", secret: "scheme-query-secret"},
	} {
		t.Run(testCase.secret, func(t *testing.T) {
			stateFile := writeGitBuildState(t, testCase.url)
			builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.example.test/team", DryRun: true})
			if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "credentialed git URLs") {
				t.Fatalf("expected credentialed URL rejection, got %v", err)
			} else if strings.Contains(err.Error(), testCase.secret) {
				t.Fatalf("credential leaked into returned error: %v", err)
			}
			if serialized := marshalString(t, readState(t, stateFile)); strings.Contains(serialized, testCase.secret) {
				t.Fatalf("credential leaked into persisted evidence: %s", serialized)
			}
		})
	}
}

func TestBuilderRejectsWorkflowRepositoryOverride(t *testing.T) {
	stateFile := writeBoundGitBuildState(t, false, map[string]any{
		"repoUrl":    "https://github.com/victim/private.git",
		"repository": "victim/private",
	})
	runner := &recordingRunner{}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.example.test/team", DryRun: true})

	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "workflow repository payload does not match") {
		t.Fatalf("expected workflow repository override rejection, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("builder ran a command for a mismatched repository payload: %#v", runner.commands)
	}
	state := readState(t, stateFile)
	evidence := marshalString(t, map[string]any{"buildLogs": state["buildLogs"], "deploymentEvents": state["deploymentEvents"]})
	if strings.Contains(evidence, "victim/private.git") {
		t.Fatalf("attacker repository URL was persisted into builder evidence: %s", evidence)
	}
}

func TestBuilderRejectsPrivateBoundRepositoryWithoutPerBuildCredentialBroker(t *testing.T) {
	stateFile := writeBoundGitBuildState(t, true, nil)
	runner := &recordingRunner{}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.example.test/team", DryRun: true})

	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "per-build credential broker") {
		t.Fatalf("expected private repository credential broker gate, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("private source clone ran without an exact-repository credential: %#v", runner.commands)
	}
}

func TestBuilderUsesAuthoritativePublicRepositoryBinding(t *testing.T) {
	stateFile := writeBoundGitBuildState(t, false, map[string]any{
		"repoUrl":    "https://github.com/acme/web.git",
		"repository": "acme/web",
	})
	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.example.test/team", DryRun: true})

	if _, err := builder.RunOnce(context.Background()); err != nil {
		t.Fatalf("verified public repository build failed: %v", err)
	}
	serialized := marshalString(t, readState(t, stateFile))
	if !strings.Contains(serialized, "git clone --depth 1 --branch main https://github.com/acme/web.git") {
		t.Fatalf("authoritative repository URL was not used: %s", serialized)
	}
}

func TestBuilderPinsCheckedOutRevisionForProductionManualDeployment(t *testing.T) {
	stateFile := writeBoundGitBuildState(t, false, nil)
	state := readState(t, stateFile)
	deployment := firstByID(t, state, "deployments", "dep_1")
	delete(deployment, "commitSha")
	delete(deployment, "commitHash")
	writeStateAtPath(t, stateFile, state)

	revision := strings.Repeat("A", 40)
	runner := &recordingRunner{revision: revision}
	config := worker.Config{
		WorkspaceDir: t.TempDir(),
		Registry:     "registry.example.test/team",
		DryRun:       true,
		Production:   true,
	}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, config)

	result, err := builder.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("production manual deployment without an initial commit failed: %v", err)
	}
	normalizedRevision := strings.ToLower(revision)
	if !strings.HasSuffix(result.Image, ":"+normalizedRevision) {
		t.Fatalf("build image was not tagged with the checked-out revision: %s", result.Image)
	}
	persisted := firstByID(t, readState(t, stateFile), "deployments", "dep_1")
	if persisted["commitSha"] != normalizedRevision || persisted["commitHash"] != normalizedRevision {
		t.Fatalf("checked-out revision was not pinned to the deployment: %#v", persisted)
	}
	foundRevisionLookup := false
	for _, command := range runner.commands {
		if command.Name == "git" && len(command.Args) == 2 && command.Args[0] == "rev-parse" && command.Args[1] == "HEAD" {
			foundRevisionLookup = true
			break
		}
	}
	if !foundRevisionLookup {
		t.Fatalf("builder did not resolve the cloned repository HEAD: %#v", runner.commands)
	}
}

func TestBuilderProductionAnonymousGitRequiresExplicitPolicy(t *testing.T) {
	stateFile := writeGitBuildState(t, "https://github.com/acme/public.git")
	runner := &recordingRunner{}
	config := liveSupplyChainConfig(t.TempDir(), "registry.example.test/team")
	config.Production = true
	config.IsolationMode = "single-job-pod"
	config.RunOnce = true
	config.RegistryCredentialBrokerURL = "https://credential-broker.example.test/credentials"
	config.RegistryCredentialBrokerTokenFile = "/var/run/secrets/raibitserver/registry-broker/token"
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, config)

	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "anonymous Git source policy") {
		t.Fatalf("expected anonymous Git policy gate, got %v", err)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("anonymous production clone ran without explicit policy: %#v", runner.commands)
	}
}

func TestBuilderRejectsConflictingEmbeddedAndRecordedDigest(t *testing.T) {
	digestA := "sha256:" + strings.Repeat("a", 64)
	digestB := "sha256:" + strings.Repeat("b", 64)
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "api", "slug": "api", "sourceType": "image", "imageUrl": "registry.example.test/team/api@" + digestA}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "imageUrl": "registry.example.test/team/api@" + digestA, "imageDigest": digestB}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1"}, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})
	runner := &recordingRunner{}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, liveSupplyChainConfig(t.TempDir(), "registry.example.test/team"))
	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "image digest conflict") {
		t.Fatalf("expected conflicting digest rejection, got %v", err)
	}
	if got := strings.Join(runner.commandNames(), ","); got != "" {
		t.Fatalf("scan/sign must not run for conflicting digest: %s", got)
	}
}

func TestBuilderGeneratesDockerfileForLocalSourceFallback(t *testing.T) {
	frontendDigest := "sha256:" + strings.Repeat("a", 64)
	nodeDigest := "sha256:" + strings.Repeat("b", 64)
	t.Setenv("RAIBITSERVER_GENERATED_DOCKERFILE_FRONTEND", "docker.io/docker/dockerfile:1.7@"+frontendDigest)
	t.Setenv("RAIBITSERVER_GENERATED_NODE_IMAGE", "docker.io/library/node:24-alpine@"+nodeDigest)
	workspaceDir := t.TempDir()
	sourceDir := filepath.Join(workspaceDir, "source")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "package.json"), []byte(`{"scripts":{"start":"node server.js"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "api", "slug": "api", "sourceType": "local", "buildMode": "auto", "localPath": sourceDir, "buildCommand": "npm run build", "startCommand": "node server.js"}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "commitSha": "local"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1"}, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})

	var generated []byte
	runner := &recordingRunner{afterCommand: func(command worker.Command) {
		if command.Name == "docker" {
			var err error
			generated, err = os.ReadFile(filepath.Join(sourceDir, "Dockerfile"))
			if err != nil {
				t.Fatalf("read generated Dockerfile during build: %v", err)
			}
		}
	}}
	builder := worker.New(controlplane.NewFileStore(stateFile), runner, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.local", DryRun: true})
	result, err := builder.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce failed: %v", err)
	}
	if result.Image == "" {
		t.Fatal("expected generated image reference")
	}
	if !strings.Contains(string(generated), "npm run build") || !strings.Contains(string(generated), "node server.js") {
		t.Fatalf("generated Dockerfile does not include service commands: %s", string(generated))
	}
	if !strings.HasPrefix(string(generated), "# syntax=docker.io/docker/dockerfile:1.7@"+frontendDigest+"\nFROM docker.io/library/node:24-alpine@"+nodeDigest+"\n") {
		t.Fatalf("generated Dockerfile does not use the configured immutable frontend and base image: %s", string(generated))
	}
	if strings.Contains(string(generated), "# syntax=docker/dockerfile:1.7\n") || strings.Contains(string(generated), "FROM node:24-alpine\n") {
		t.Fatalf("generated Dockerfile retained mutable build inputs: %s", string(generated))
	}
	if _, err := os.Stat(filepath.Join(sourceDir, "Dockerfile")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("generated Dockerfile artifact was retained after build: %v", err)
	}
	logs := marshalString(t, readState(t, stateFile)["buildLogs"])
	if !strings.Contains(logs, "generated Dockerfile") {
		t.Fatalf("expected generated Dockerfile log, got %s", logs)
	}
}

func TestBuilderRejectsEscapingBuildPaths(t *testing.T) {
	workspaceDir := t.TempDir()
	sourceDir := filepath.Join(workspaceDir, "source")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "Dockerfile"), []byte("FROM scratch\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "api", "slug": "api", "sourceType": "local", "buildMode": "dockerfile", "localPath": sourceDir}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "commitSha": "local"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "buildContext": "../../.."}, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})

	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.local", DryRun: true})
	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "buildContext escapes source directory") {
		t.Fatalf("expected build context escape failure, got %v", err)
	}

	state := readState(t, stateFile)
	deployment := firstByID(t, state, "deployments", "dep_1")
	if deployment["status"] != "BUILD_FAILED" {
		t.Fatalf("deployment not failed: %#v", deployment)
	}
}

func TestBuilderRejectsDirectoryDockerfilePath(t *testing.T) {
	workspaceDir := t.TempDir()
	sourceDir := filepath.Join(workspaceDir, "source")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "api", "slug": "api", "sourceType": "local", "buildMode": "auto", "localPath": sourceDir}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "commitSha": "local"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "dockerfilePath": "."}, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})

	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.local", DryRun: true})
	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "dockerfilePath must point to a file") {
		t.Fatalf("expected directory Dockerfile path rejection, got %v", err)
	}
}

func TestBuilderRejectsSymlinkedBuildContext(t *testing.T) {
	workspaceDir := t.TempDir()
	sourceDir := filepath.Join(workspaceDir, "source")
	outsideDir := t.TempDir()
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outsideDir, "signing.key"), []byte("platform-private-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	createDirectoryLink(t, outsideDir, filepath.Join(sourceDir, "context"))
	if _, err := os.Stat(filepath.Join(sourceDir, "context", "signing.key")); err != nil {
		t.Fatalf("directory link did not resolve to its target: %v", err)
	}
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "api", "slug": "api", "sourceType": "local", "buildMode": "dockerfile", "localPath": sourceDir}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "commitSha": "local"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "buildContext": "context"}, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})

	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.local", DryRun: true})
	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "buildContext must not contain symbolic links") {
		t.Fatalf("expected symlinked build context rejection, got %v", err)
	}
}

func TestBuilderRejectsSymlinkedDockerfilePath(t *testing.T) {
	workspaceDir := t.TempDir()
	sourceDir := filepath.Join(workspaceDir, "source")
	outsideDir := t.TempDir()
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outsideDir, "Dockerfile"), []byte("FROM scratch\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	createDirectoryLink(t, outsideDir, filepath.Join(sourceDir, "dockerfile"))
	if _, err := os.Stat(filepath.Join(sourceDir, "dockerfile", "Dockerfile")); err != nil {
		t.Fatalf("directory link did not resolve to its target: %v", err)
	}
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "api", "slug": "api", "sourceType": "local", "buildMode": "dockerfile", "localPath": sourceDir}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "commitSha": "local"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "dockerfilePath": "dockerfile/Dockerfile"}, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})

	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.local", DryRun: true})
	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "dockerfilePath must not contain symbolic links") {
		t.Fatalf("expected symlinked Dockerfile rejection, got %v", err)
	}
}

func TestBuilderRejectsAbsoluteDockerfilePath(t *testing.T) {
	workspaceDir := t.TempDir()
	sourceDir := filepath.Join(workspaceDir, "source")
	absoluteDockerfile := filepath.Join(filepath.Dir(workspaceDir), "outside", "Dockerfile")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "Dockerfile"), []byte("FROM scratch\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "api", "slug": "api", "sourceType": "local", "buildMode": "dockerfile", "localPath": sourceDir}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "commitSha": "local"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "dockerfilePath": absoluteDockerfile}, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})

	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.local", DryRun: true})
	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "dockerfilePath must be relative") {
		t.Fatalf("expected absolute dockerfile failure, got %v", err)
	}
}

func TestBuilderRejectsLocalPathOutsideWorkspace(t *testing.T) {
	workspaceDir := t.TempDir()
	sourceDir := t.TempDir()
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "api", "slug": "api", "sourceType": "local", "buildMode": "dockerfile", "localPath": sourceDir}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "commitSha": "local"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1"}, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})

	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.local", DryRun: true})
	if _, err := builder.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "escapes allowed base directory") {
		t.Fatalf("expected local path escape error, got %v", err)
	}
}

func TestBuilderFailureMarksDeploymentAndWorkflowWithoutLeakingCredentials(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "sourceType": "github", "buildMode": "dockerfile", "repoUrl": "https://ghp_secret-token@github.com/acme/web.git"}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1"}, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})
	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.local", DryRun: true})
	if _, err := builder.RunOnce(context.Background()); err == nil {
		t.Fatal("expected credentialed URL failure")
	}
	state := readState(t, stateFile)
	deployment := firstByID(t, state, "deployments", "dep_1")
	if deployment["status"] != "BUILD_FAILED" {
		t.Fatalf("deployment not failed: %#v", deployment)
	}
	job := firstByID(t, state, "workflowJobs", "job_1")
	if job["status"] != "failed" {
		t.Fatalf("job not failed: %#v", job)
	}
	serialized := marshalString(t, state)
	if strings.Contains(serialized, "ghp_secret-token") {
		t.Fatalf("state leaked credential token: %s", serialized)
	}
}

func TestBuilderArtifactPreparationFailureMarksDeploymentAndWorkflow(t *testing.T) {
	_, stateFile := writeLocalDockerfileBuildState(t, nil)
	blockedWorkspace := filepath.Join(t.TempDir(), "workspace-is-a-file")
	if err := os.WriteFile(blockedWorkspace, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{
		WorkspaceDir: blockedWorkspace,
		Registry:     "registry.example.test",
		DryRun:       true,
	})

	if _, err := builder.RunOnce(context.Background()); err == nil {
		t.Fatal("expected artifact workspace preparation failure")
	}
	state := readState(t, stateFile)
	deployment := firstByID(t, state, "deployments", "dep_1")
	job := firstByID(t, state, "workflowJobs", "job_1")
	if deployment["status"] != "BUILD_FAILED" || job["status"] != "failed" {
		t.Fatalf("artifact setup failure must be durable on both records: deployment=%#v job=%#v", deployment, job)
	}
}

func TestBuilderRejectsInconsistentPayloadAndTargetDeploymentIDs(t *testing.T) {
	stateFile := writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services": []any{map[string]any{
			"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "sourceType": "github",
			"buildMode": "dockerfile", "repoUrl": "https://github.com/acme/web.git", "branch": "main", "dockerfilePath": "Dockerfile", "registry": "registry.local",
		}},
		"deployments": []any{
			map[string]any{"id": "dep_target", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued"},
			map[string]any{"id": "dep_payload", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued"},
		},
		"workflowJobs": []any{map[string]any{
			"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": " deployment ", "targetId": " dep_target ",
			"payload":  map[string]any{"deploymentId": " dep_payload ", "serviceId": "svc_1", "projectId": "prj_1"},
			"attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z",
		}},
	})
	builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.Config{WorkerID: "builder-test", WorkspaceDir: t.TempDir(), Registry: "registry.local", DryRun: true})

	_, err := builder.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "inconsistent deployment targets") {
		t.Fatalf("mismatched deployment identities must fail closed, got %v", err)
	}
	state := readState(t, stateFile)
	for _, deploymentID := range []string{"dep_target", "dep_payload"} {
		deployment := firstByID(t, state, "deployments", deploymentID)
		if deployment["status"] != "queued" {
			t.Fatalf("mismatched job mutated deployment %s: %#v", deploymentID, deployment)
		}
	}
}

func TestBuilderReportsOriginalAndDurableFailureRecordingErrors(t *testing.T) {
	const originalMarker = "secret-looking build arg"
	workspaceDir, stateFile := writeLocalDockerfileBuildState(t, map[string]any{"API_TOKEN": "do-not-persist"})
	deploymentErr := errors.New("persist deployment failure evidence")
	workflowErr := errors.New("persist workflow failure evidence")
	baseStore := controlplane.NewFileStore(stateFile)
	store := &failurePersistenceStore{Store: baseStore, deploymentErr: deploymentErr, workflowErr: workflowErr}
	builder := worker.New(store, worker.OSRunner{}, worker.Config{WorkspaceDir: workspaceDir, Registry: "registry.example.test", DryRun: true})

	_, err := builder.RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), originalMarker) {
		t.Fatalf("original build failure was masked: %v", err)
	}
	if !errors.Is(err, deploymentErr) || !errors.Is(err, workflowErr) {
		t.Fatalf("durable failure recording errors were masked: %v", err)
	}
}

func writeState(t *testing.T, state map[string]any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.json")
	bytes, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func createDirectoryLink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err == nil {
		return
	} else if runtime.GOOS != "windows" {
		t.Fatalf("create directory symlink: %v", err)
	}
	if err := os.Remove(link); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("remove failed symbolic link: %v", err)
	}
	command := `& { param($link, $target) New-Item -ItemType Junction -Path $link -Target $target | Out-Null }`
	output, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command, link, target).CombinedOutput()
	if err != nil {
		t.Fatalf("create directory junction: %v: %s", err, strings.TrimSpace(string(output)))
	}
}

func readState(t *testing.T, path string) map[string]any {
	t.Helper()
	bytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(bytes, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func firstByID(t *testing.T, state map[string]any, key, id string) map[string]any {
	t.Helper()
	for _, item := range mustArray(state[key]) {
		row, ok := item.(map[string]any)
		if ok && row["id"] == id {
			return row
		}
	}
	t.Fatalf("%s %s not found in %#v", key, id, state[key])
	return nil
}

func mustArray(value any) []any {
	rows, _ := value.([]any)
	return rows
}

func marshalString(t *testing.T, value any) string {
	t.Helper()
	bytes, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(bytes)
}

type recordingRunner struct {
	commands       []worker.Command
	options        []worker.CommandOptions
	metadataDigest string
	revision       string
	failCommand    string
	afterCommand   func(worker.Command)
}

func TestBuilderClonesPrivateRepositoryWithTransientSensitiveHelper(t *testing.T) {
	stateFile := writeBoundGitBuildState(t, true, nil)
	credential := "ghs_private-clone-secret"
	store := &githubCredentialFileStore{
		FileStore: controlplane.NewFileStore(stateFile),
		credential: &controlplane.GitHubRepositoryCredential{
			Token: credential, InstallationID: "installation-a", RepositoryID: "101", UpstreamExpiresAt: time.Now().UTC().Add(time.Hour), UseDeadline: time.Now().Add(5 * time.Minute),
		},
	}
	runner := &recordingRunner{}
	builder := worker.New(store, runner, worker.Config{WorkspaceDir: t.TempDir(), Registry: "registry.example.test/team", DryRun: true})

	if _, err := builder.RunOnce(context.Background()); err != nil {
		t.Fatalf("private repository build with exact credential failed: %v", err)
	}
	if len(runner.commands) == 0 || len(runner.options) == 0 {
		t.Fatal("private clone command did not run")
	}
	clone := runner.commands[0]
	if clone.Name != "git" || len(clone.Args) == 0 || clone.Args[0] != "clone" {
		t.Fatalf("first command was not private clone: %#v", clone)
	}
	if !runner.options[0].Sensitive {
		t.Fatal("private clone output was not marked sensitive")
	}
	if strings.Contains(strings.Join(clone.Args, " "), credential) || strings.Contains(clone.Redacted, credential) {
		t.Fatalf("credential leaked into clone argv or printable command: %#v", clone)
	}
	if clone.Env["GIT_CONFIG_COUNT"] != "5" || !strings.Contains(clone.Env["GIT_CONFIG_VALUE_1"], "github-credential-helper") {
		t.Fatal("clone did not receive a transient credential helper")
	}
	for _, value := range clone.Env {
		if strings.Contains(value, credential) {
			t.Fatal("credential entered clone environment")
		}
	}
	for _, command := range runner.commands[1:] {
		if command.Env["GIT_CONFIG_VALUE_0"] != "" {
			t.Fatalf("private credential escaped the clone subprocess: %#v", command)
		}
	}
	serialized := marshalString(t, readState(t, stateFile))
	if strings.Contains(serialized, credential) {
		t.Fatal("private clone credential leaked into persisted state")
	}
}

type githubCredentialFileStore struct {
	*controlplane.FileStore
	credential *controlplane.GitHubRepositoryCredential
}

func (s *githubCredentialFileStore) ReleaseGitHubRepositoryCredential(context.Context, bool) error {
	return nil
}

func (s *githubCredentialFileStore) CheckGitHubRepositoryCredential(context.Context) error {
	return nil
}

func (s *githubCredentialFileStore) IssueGitHubRepositoryCredential(_ context.Context, request controlplane.GitHubRepositoryCredentialRequest) (*controlplane.GitHubRepositoryCredential, error) {
	if request.ServiceID != "svc_1" || request.InstallationID != "installation-a" || request.RepositoryID != "101" {
		return nil, errors.New("unexpected GitHub credential scope")
	}
	return s.credential, nil
}

type tombstoneBeforeStartStore struct {
	controlplane.Store
	fileStore  *controlplane.FileStore
	tombstoned bool
}

type failurePersistenceStore struct {
	controlplane.Store
	deploymentErr error
	workflowErr   error
}

type leaseLostBeforeStartStore struct {
	controlplane.Store
	failureWriteAttempted bool
}

func (s *leaseLostBeforeStartStore) StartBuild(context.Context, controlplane.BuildStartInput) error {
	return controlplane.ErrWorkflowLeaseLost
}

func (s *leaseLostBeforeStartStore) UpdateDeploymentForLease(context.Context, controlplane.WorkflowLease, string, map[string]any) (*controlplane.Deployment, error) {
	s.failureWriteAttempted = true
	return nil, errors.New("unexpected deployment failure write after lease loss")
}

func (s *leaseLostBeforeStartStore) FailWorkflowJob(context.Context, controlplane.WorkflowLease, error) error {
	s.failureWriteAttempted = true
	return errors.New("unexpected workflow failure write after lease loss")
}

func (s *failurePersistenceStore) UpdateDeploymentForLease(context.Context, controlplane.WorkflowLease, string, map[string]any) (*controlplane.Deployment, error) {
	return nil, s.deploymentErr
}

func (s *failurePersistenceStore) FailWorkflowJob(context.Context, controlplane.WorkflowLease, error) error {
	return s.workflowErr
}

func (s *tombstoneBeforeStartStore) StartBuild(ctx context.Context, input controlplane.BuildStartInput) error {
	if !s.tombstoned {
		s.tombstoned = true
		if _, err := s.fileStore.UpdateService(ctx, input.ServiceID, map[string]any{"status": "DELETE_REQUESTED"}); err != nil {
			return err
		}
	}
	return s.Store.StartBuild(ctx, input)
}

func (r *recordingRunner) Run(_ context.Context, command worker.Command, options worker.CommandOptions) (worker.CommandResult, error) {
	r.commands = append(r.commands, command)
	r.options = append(r.options, options)
	result := worker.CommandResult{Command: command.Name + " " + strings.Join(command.Args, " "), ExitCode: 0, DryRun: options.DryRun}
	if command.Name == r.failCommand {
		result.ExitCode = 1
		return result, errors.New("simulated " + command.Name + " failure")
	}
	if command.Name == "git" && len(command.Args) == 2 && command.Args[0] == "rev-parse" && command.Args[1] == "HEAD" {
		result.Stdout = r.revision + "\n"
	}
	if r.metadataDigest != "" && (command.Name == "buildctl" || command.Name == "docker") {
		if metadataFile := commandArgValue(command.Args, "--metadata-file"); metadataFile != "" {
			bytes, err := json.Marshal(map[string]any{"containerimage.digest": r.metadataDigest})
			if err != nil {
				return result, err
			}
			if err := os.WriteFile(metadataFile, bytes, 0o600); err != nil {
				return result, err
			}
		}
	}
	if r.afterCommand != nil {
		r.afterCommand(command)
	}
	return result, nil
}

func assertDeletionCancelledWithoutPublication(t *testing.T, stateFile string) {
	t.Helper()
	state := readState(t, stateFile)
	deployment := firstByID(t, state, "deployments", "dep_1")
	if deployment["status"] == "IMAGE_READY" || deployment["imageDigest"] != nil || deployment["imageUrl"] != nil {
		t.Fatalf("deleting target received image publication: %#v", deployment)
	}
	service := firstByID(t, state, "services", "svc_1")
	if service["status"] == "image-ready" || service["image"] != nil || service["imageUrl"] != nil {
		t.Fatalf("deleting target service received image publication: %#v", service)
	}
	job := firstByID(t, state, "workflowJobs", "job_1")
	if job["status"] != "failed" || job["lockedBy"] != nil {
		t.Fatalf("deletion-cancelled job was retried or left locked: %#v", job)
	}
	serialized := marshalString(t, state)
	if !strings.Contains(serialized, "delet") || !strings.Contains(serialized, "DEPLOYMENT_CANCELLED") {
		t.Fatalf("missing non-retry deletion cancellation evidence: %s", serialized)
	}
}

func (r *recordingRunner) commandNames() []string {
	out := make([]string, len(r.commands))
	for index, command := range r.commands {
		out[index] = command.Name
	}
	return out
}

func commandArgValue(args []string, name string) string {
	for index, arg := range args {
		if arg == name && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}

func liveSupplyChainConfig(workspaceDir, registry string) worker.Config {
	return worker.Config{
		WorkspaceDir:          workspaceDir,
		Registry:              registry,
		DryRun:                false,
		Push:                  true,
		Builder:               "buildctl",
		BuildkitAddress:       "tcp://127.0.0.1:1234",
		BuildkitTLSDirectory:  "/var/run/secrets/raibitserver/buildkit",
		BuildkitTLSServerName: "raibit-buildkit",
		Scan:                  true,
		Sign:                  true,
		SigningKeyPath:        "/var/run/secrets/raibitserver/signing/cosign.key",
		VerificationKeyPath:   "/var/run/secrets/raibitserver/verification/cosign.pub",
	}
}

func writeStateAtPath(t *testing.T, path string, state map[string]any) {
	t.Helper()
	bytes, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeGitBuildState(t *testing.T, repoURL string) string {
	t.Helper()
	return writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "sourceType": "github", "buildMode": "dockerfile", "repoUrl": repoURL}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "repoUrl": repoURL}, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})
}

func writeBoundGitBuildState(t *testing.T, private bool, payload map[string]any) string {
	t.Helper()
	jobPayload := map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1"}
	for key, value := range payload {
		jobPayload[key] = value
	}
	binding := map[string]any{
		"integrationId":  "integration-a",
		"installationId": "installation-a",
		"repositoryId":   "101",
		"repository":     "acme/web",
		"repoUrl":        "https://github.com/acme/web.git",
		"visibility":     map[bool]string{true: "private", false: "public"}[private],
	}
	return writeState(t, map[string]any{
		"projects": []any{map[string]any{"id": "prj_1", "organizationId": "org_1", "name": "Demo", "slug": "demo"}},
		"services": []any{map[string]any{
			"id": "svc_1", "projectId": "prj_1", "name": "web", "slug": "web", "sourceType": "github", "buildMode": "dockerfile",
			"repoUrl": "https://github.com/acme/web.git", "githubRepositoryId": "101", "branch": "main", "dockerfilePath": "Dockerfile",
			"desiredState": map[string]any{"github": binding, "githubIntegrationId": "integration-a", "githubInstallationId": "installation-a", "githubRepositoryId": "101", "githubRepository": "acme/web", "githubRepositoryVisibility": map[bool]string{true: "private", false: "public"}[private]},
		}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "branch": "main", "commitSha": "abc123"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": jobPayload, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})
}

func writeLocalDockerfileBuildState(t *testing.T, buildArgs map[string]any) (string, string) {
	t.Helper()
	workspaceDir := t.TempDir()
	sourceDir := filepath.Join(workspaceDir, "source")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "Dockerfile"), []byte("FROM scratch\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"deploymentId": "dep_1", "serviceId": "svc_1", "projectId": "prj_1"}
	if buildArgs != nil {
		payload["buildArgs"] = buildArgs
	}
	stateFile := writeState(t, map[string]any{
		"projects":     []any{map[string]any{"id": "prj_1", "name": "Demo", "slug": "demo"}},
		"services":     []any{map[string]any{"id": "svc_1", "projectId": "prj_1", "name": "api", "slug": "api", "sourceType": "local", "buildMode": "dockerfile", "localPath": sourceDir}},
		"deployments":  []any{map[string]any{"id": "dep_1", "serviceId": "svc_1", "projectId": "prj_1", "status": "queued", "commitSha": "abc123"}},
		"workflowJobs": []any{map[string]any{"id": "job_1", "type": "build-and-deploy", "status": "queued", "targetType": "deployment", "targetId": "dep_1", "payload": payload, "attempts": 0, "maxAttempts": 1, "runAfter": "2026-01-01T00:00:00Z"}},
	})
	return workspaceDir, stateFile
}
