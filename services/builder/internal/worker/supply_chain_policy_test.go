package worker_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/builder/internal/controlplane"
	"github.com/raibitserver/builder/internal/worker"
)

// This fixture executes local processes, not BuildKit, a scanner, or cryptography.
const policyCommandFixture = `#!/bin/sh
set -eu
tool="$1"; shift
case "$tool" in
buildctl)
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --metadata-file ]; then
      shift
      printf '{"containerimage.digest":"%s"}' "$FIXTURE_DIGEST" > "$1"
    fi
    shift
  done ;;
trivy)
  case " $* " in *' --ignore-unfixed '*) exit 21;; esac
  case " $* " in *HIGH*CRITICAL*) :;; *) exit 22;; esac ;;
cosign)
  operation="$1"; shift
  if [ "$operation" = verify ]; then
    key=''; image=''
    while [ "$#" -gt 0 ]; do
      case "$1" in --key) shift; key="$1";; *@sha256:*) image="$1";; esac
      shift
    done
    [ -f "$key" ] || exit 23
    case "$image" in *"@$FIXTURE_DIGEST") :;; *) exit 24;; esac
    [ "$(cat "$key")" = fixture-approved-public-key ] || exit 25
    [ "$FIXTURE_CASE" != verify-failure ] || { echo 'misleading PASS token=fixture-sensitive'; exit 26; }
    [ "$FIXTURE_CASE" != digest-mismatch ] || exit 27
  fi ;;
*) exit 28 ;;
esac
`

type policyProcessRunner struct {
	fixture  string
	commands []worker.Command
	options  []worker.CommandOptions
	after    func(worker.Command)
}

func (r *policyProcessRunner) Run(ctx context.Context, command worker.Command, options worker.CommandOptions) (worker.CommandResult, error) {
	r.commands = append(r.commands, command)
	r.options = append(r.options, options)
	fixtureCommand := command
	fixtureCommand.Args = append([]string{command.Name}, command.Args...)
	fixtureCommand.Name = r.fixture
	fixtureCommand.Redacted = command.Name + " [local policy fixture]"
	result, err := (worker.OSRunner{}).Run(ctx, fixtureCommand, options)
	if r.after != nil {
		r.after(command)
	}
	return result, err
}

func TestSupplyChainPolicyPublication(t *testing.T) {
	for _, scenario := range []string{"success", "verify-failure", "digest-mismatch", "missing-key", "wrong-key", "severity-bypass", "cancel-after-verify", "lease-after-verify", "delete-after-verify"} {
		t.Run(scenario, func(t *testing.T) {
			// Given: a local process fixture plus the real file-backed worker store.
			workspace, stateFile := writeLocalDockerfileBuildState(t, nil)
			digest := "sha256:" + strings.Repeat("a", 64)
			fixture := filepath.Join(t.TempDir(), "policy-command")
			if err := os.WriteFile(fixture, []byte(policyCommandFixture), 0o700); err != nil {
				t.Fatal(err)
			}
			key := filepath.Join(t.TempDir(), "cosign.pub")
			keyContent := "fixture-approved-public-key"
			if scenario == "wrong-key" {
				keyContent = "fixture-untrusted-public-key"
			}
			if err := os.WriteFile(key, []byte(keyContent), 0o600); err != nil {
				t.Fatal(err)
			}
			if scenario == "missing-key" {
				key = ""
			}
			t.Setenv("RAIBITSERVER_VERIFICATION_KEY", key)
			t.Setenv("FIXTURE_DIGEST", digest)
			t.Setenv("FIXTURE_CASE", scenario)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runner := &policyProcessRunner{fixture: fixture}
			runner.after = func(command worker.Command) {
				if command.Name != "cosign" || command.Args[0] != "verify" {
					return
				}
				switch scenario {
				case "cancel-after-verify":
					cancel()
				case "lease-after-verify", "delete-after-verify":
					state := readState(t, stateFile)
					if scenario == "lease-after-verify" {
						firstByID(t, state, "workflowJobs", "job_1")["lockedBy"] = "replacement-worker"
					} else {
						firstByID(t, state, "projects", "prj_1")["status"] = "DELETING"
					}
					writeStateAtPath(t, stateFile, state)
				}
			}
			config := liveSupplyChainConfig(workspace, "registry.example.test")
			config.VerificationKeyPath = key
			if scenario == "severity-bypass" {
				config.ScanSeverity = "CRITICAL"
			}
			builder := worker.New(controlplane.NewFileStore(stateFile), runner, config)
			// When.
			result, err := builder.RunOnce(ctx)
			// Then: publication is atomic and only follows the verification success.
			state := readState(t, stateFile)
			deployment := firstByID(t, state, "deployments", "dep_1")
			job := firstByID(t, state, "workflowJobs", "job_1")
			if scenario == "success" {
				if err != nil || deployment["status"] != "IMAGE_READY" || job["status"] != "succeeded" {
					t.Fatalf("publication failed: %v %s", err, marshalString(t, state))
				}
				if result.ImageDigest != digest || !strings.Contains(marshalString(t, result.Metadata), `"verification"`) || !strings.Contains(marshalString(t, result.Metadata), `"verified"`) {
					t.Fatalf("missing verified result: %#v", result)
				}
				if len(runner.commands) != 4 || runner.commands[3].Args[0] != "verify" || commandArgValue(runner.commands[3].Args, "--key") != key {
					t.Fatalf("missing independent key verification: %#v", runner.commands)
				}
				for _, command := range runner.commands[1:] {
					if command.Args[len(command.Args)-1] != runner.commands[1].Args[len(runner.commands[1].Args)-1] || !strings.HasSuffix(command.Args[len(command.Args)-1], "@"+digest) {
						t.Fatalf("scan/sign/verify digest identity differs: %#v", command)
					}
				}
				if !strings.Contains(strings.Join(runner.commands[1].Args, " "), "--ignore-unfixed=false") {
					t.Fatal("ambient unfixed exclusion was not overridden")
				}
				if !strings.Contains(marshalString(t, state["deploymentEvents"]), "build.image_verified") {
					t.Fatal("missing verification event")
				}
			} else {
				wantCommands := 4
				if scenario == "missing-key" || scenario == "severity-bypass" {
					wantCommands = 0
				}
				if len(runner.commands) != wantCommands {
					t.Fatalf("failure did not reach its boundary: commands=%d want=%d err=%v", len(runner.commands), wantCommands, err)
				}
				if err == nil || deployment["status"] == "IMAGE_READY" || job["status"] == "succeeded" || strings.Contains(marshalString(t, state["deploymentEvents"]), "build.image_ready") {
					t.Fatalf("unsafe publication: %v %s", err, marshalString(t, state))
				}
				if scenario == "verify-failure" && (!strings.Contains(marshalString(t, state["deploymentEvents"]), "build.image_verify_failed") || strings.Contains(marshalString(t, state), "fixture-sensitive")) {
					t.Fatal("verification failure event missing or sensitive output leaked")
				}
			}
			assertNoJobArtifactDirectories(t, workspace)
			t.Logf("scenario=%s status=%v job=%v commands=%d error=%v result=%s", scenario, deployment["status"], job["status"], len(runner.commands), err, marshalString(t, result))
		})
	}
}

func TestSupplyChainPolicyStageBounds(t *testing.T) {
	for _, timeout := range []time.Duration{30 * time.Minute, 2 * time.Minute} {
		t.Run(timeout.String(), func(t *testing.T) {
			// Given.
			workspace, stateFile := writeLocalDockerfileBuildState(t, nil)
			runner := &recordingRunner{metadataDigest: "sha256:" + strings.Repeat("b", 64)}
			config := liveSupplyChainConfig(workspace, "registry.example.test")
			config.Timeout = timeout
			// When.
			_, err := worker.New(controlplane.NewFileStore(stateFile), runner, config).RunOnce(context.Background())
			// Then.
			if err != nil {
				t.Fatal(err)
			}
			for i, options := range runner.options {
				want := min(timeout, 10*time.Minute)
				if options.Timeout != want {
					t.Errorf("%s timeout=%v want=%v", runner.commands[i].Name, options.Timeout, want)
				}
			}
		})
	}
}

func TestSupplyChainPolicyParentCancellation(t *testing.T) {
	// Given: an already-cancelled real command context.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// When.
	_, err := (worker.OSRunner{}).Run(ctx, worker.Command{Name: "/bin/true"}, worker.CommandOptions{Timeout: 10 * time.Minute})
	// Then.
	if err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("parent cancellation ignored: %v", err)
	}
}

func TestSupplyChainPolicyCloneBounds(t *testing.T) {
	// Given: dry-run source commands are recorded without any GitHub access.
	stateFile := writeBoundGitBuildState(t, false, nil)
	runner := &recordingRunner{}
	config := liveSupplyChainConfig(t.TempDir(), "registry.example.test")
	config.DryRun, config.Timeout = true, 30*time.Minute
	// When.
	_, err := worker.New(controlplane.NewFileStore(stateFile), runner, config).RunOnce(context.Background())
	// Then.
	if err != nil {
		t.Fatal(err)
	}
	gitCommands := 0
	for i, command := range runner.commands {
		if command.Name == "git" {
			gitCommands++
			if runner.options[i].Timeout != 15*time.Minute {
				t.Fatalf("source timeout: %v", runner.options[i].Timeout)
			}
		}
	}
	if gitCommands == 0 {
		t.Fatal("source fixture did not exercise clone")
	}
}
