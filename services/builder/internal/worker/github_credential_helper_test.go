package worker

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/builder/internal/controlplane"
)

func TestGitHubCredentialHappyPrivateClone(t *testing.T) {
	// Given a real private smart-HTTP Git repository, TLS proxy and actual helper binary.
	store := &helperFixtureStore{credential: controlplane.GitHubRepositoryCredential{Token: "ghs_private_wire_fixture", RepositoryID: "101", InstallationID: "202", UseDeadline: time.Now().Add(5 * time.Minute), UpstreamExpiresAt: time.Now().Add(time.Hour)}}
	proxy, ca, executable := helperGitFixture(t, store)
	workspace := t.TempDir()
	state := &buildContext{Service: &controlplane.Service{ID: "service", GitHubRepository: "acme/private", GitHubRepositoryID: "101", GitHubInstallationID: "202"}, MetadataDir: workspace}
	destination := filepath.Join(workspace, "source")
	command := Command{Name: "git", Args: []string{"-c", "http.proxy=" + proxy, "-c", "http.sslCAInfo=" + ca, "clone", "--depth", "1", "--branch", "main", "https://github.com/acme/private.git", destination}, Env: isolatedGitEnvironment(workspace), CleanGitEnv: true}
	builder := New(store, OSRunner{}, Config{GitCredentialHelperExecutable: executable, Timeout: 30 * time.Second})
	// When cloning through the production ephemeral socket helper.
	result, err := builder.cloneWithGitHubCredential(context.Background(), state, command)
	if err != nil {
		t.Fatalf("real private clone failed: %v", err)
	}
	// Then the private commit exists and credentials are disposed before the consumer returns.
	sentinel, err := os.ReadFile(filepath.Join(destination, "sentinel.txt"))
	if err != nil || string(sentinel) != "private-clone-sentinel\n" {
		t.Fatal("private sentinel missing")
	}
	if !store.released.Load() {
		t.Fatal("clone returned before release acknowledgement")
	}
	encoded := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + store.credential.Token))
	for _, value := range append(command.Args, result.Command, result.Stdout, result.Stderr) {
		if strings.Contains(value, store.credential.Token) || strings.Contains(value, encoded) {
			t.Fatal("secret in command/result")
		}
	}
	for _, value := range command.Env {
		if strings.Contains(value, store.credential.Token) || strings.Contains(value, encoded) {
			t.Fatal("secret in child environment")
		}
	}
	err = filepath.Walk(destination, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if bytes.Contains(data, []byte(store.credential.Token)) || bytes.Contains(data, []byte(encoded)) {
			return errors.New("secret in image context")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	helperCommand := command.Env["GIT_CONFIG_VALUE_1"]
	parts := strings.Fields(helperCommand)
	if len(parts) != 3 {
		t.Fatal("helper command shape invalid")
	}
	if _, err := os.Stat(strings.Trim(parts[2], "'")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("helper socket retained")
	}
	t.Log("real_git=PASS private_sentinel=PASS helper_socket_removed=PASS release_ack=PASS argv_env_context_token_matches=0")
}

func TestGitHubCredentialFailureMatrixHelper(t *testing.T) {
	for _, row := range []struct {
		name, input string
		cancel      bool
	}{
		{"foreign-path", "protocol=https\nhost=github.com\npath=acme/other.git\n\n", false},
		{"foreign-host", "protocol=https\nhost=evil.test\npath=acme/private.git\n\n", false},
		{"plaintext", "protocol=http\nhost=github.com\npath=acme/private.git\n\n", false},
		{"cancel", "protocol=https\nhost=github.com\npath=acme/private.git\n\n", true},
	} {
		t.Run(row.name, func(t *testing.T) {
			// Given an exact-path helper bound to a cancellable clone.
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			dir, err := os.MkdirTemp("", "rb-gh-test-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(dir)
			socket := filepath.Join(dir, "socket")
			credential := &controlplane.GitHubRepositoryCredential{Token: "ghs_helper_fixture", UseDeadline: time.Now().Add(time.Minute)}
			helper, err := newGitHubCredentialHelper(ctx, socket, gitHubHelperScope{Credential: credential, Repository: "acme/private", Authorize: func(context.Context) error { return nil }})
			if err != nil {
				t.Fatal(err)
			}
			defer helper.Close()
			if row.cancel {
				cancel()
				if err := helper.Close(); err != nil {
					t.Fatal(err)
				}
			}
			// When a foreign or cancelled request attempts to retrieve a credential.
			var output bytes.Buffer
			err = RunGitCredentialHelper(ctx, []string{socket, "get"}, strings.NewReader(row.input), &output)
			// Then no credential bytes cross the helper boundary.
			if err == nil || output.Len() != 0 {
				t.Fatal("helper returned forbidden credential")
			}
		})
	}
}

func TestGitHubCredentialFailureMatrixPrivateClone(t *testing.T) {
	store := &helperFixtureStore{credential: controlplane.GitHubRepositoryCredential{Token: "ghs_failure_wire_fixture", RepositoryID: "101", InstallationID: "202", UseDeadline: time.Now().Add(5 * time.Minute), UpstreamExpiresAt: time.Now().Add(time.Hour)}}
	proxy, ca, executable := helperGitFixture(t, store)
	for _, cause := range []string{"clone-failure", "cancel", "lease-loss", "revocation-failure"} {
		t.Run(cause, func(t *testing.T) {
			store.released.Store(false)
			store.denied.Store(cause == "lease-loss")
			store.failRelease = cause == "revocation-failure"
			workspace := t.TempDir()
			state := &buildContext{Service: &controlplane.Service{ID: "service", GitHubRepository: "acme/private", GitHubRepositoryID: "101", GitHubInstallationID: "202"}, WorkspaceDir: workspace, MetadataDir: filepath.Join(workspace, "metadata")}
			branch := "main"
			if cause == "clone-failure" {
				branch = "missing-branch"
			}
			command := Command{Name: "git", Args: []string{"-c", "http.proxy=" + proxy, "-c", "http.sslCAInfo=" + ca, "clone", "--depth", "1", "--branch", branch, "https://github.com/acme/private.git", filepath.Join(workspace, "source")}, Env: isolatedGitEnvironment(workspace), CleanGitEnv: true}
			builder := New(store, OSRunner{}, Config{GitCredentialHelperExecutable: executable, Timeout: 10 * time.Second})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if cause == "cancel" {
				cancel()
			}
			result, err := builder.cloneWithGitHubCredential(ctx, state, command)
			if err == nil || !store.released.Load() {
				t.Fatal("failed clone continued without disposal")
			}
			if strings.Contains(err.Error(), store.credential.Token) || strings.Contains(result.Stdout+result.Stderr, store.credential.Token) {
				t.Fatal("failure exposed token")
			}
			if helper := command.Env["GIT_CONFIG_VALUE_1"]; helper != "" {
				parts := strings.Fields(helper)
				if _, err := os.Stat(strings.Trim(parts[len(parts)-1], "'")); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("failed clone retained helper")
				}
			}
			if err := builder.cleanupJobArtifacts(state); err != nil {
				t.Fatal("worktree cleanup failed")
			}
			if _, err := os.Stat(workspace); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("worktree retained")
			}
			t.Log("real_git_failure=PASS release_attempted=PASS helper_workspace_disposal=PASS secret_matches=0")
		})
	}
}

func TestGitHubCredentialFailureMatrixCleanupError(t *testing.T) {
	parent := t.TempDir()
	workspace := filepath.Join(parent, "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "entry"), []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(parent, 0o700)
	if err := (&Builder{}).cleanupJobArtifacts(&buildContext{WorkspaceDir: workspace}); err == nil {
		t.Fatal("cleanup failure was hidden")
	}
}
