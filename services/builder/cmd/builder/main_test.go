package main

import (
	"strings"
	"testing"
)

func TestSingleJobPodModeRunsExactlyOnce(t *testing.T) {
	t.Setenv("RAIBITSERVER_RUN_ONCE", "1")
	t.Setenv("RAIBITSERVER_BUILDER_ISOLATION", "single-job-pod")
	if !runOnceEnabled() {
		t.Fatal("single-job pod must exit after one claim instead of reusing build state across tenants")
	}
}

func TestSharedModeDoesNotPretendToBeSingleJob(t *testing.T) {
	t.Setenv("RAIBITSERVER_RUN_ONCE", "0")
	t.Setenv("RAIBITSERVER_BUILDER_ISOLATION", "shared")
	if runOnceEnabled() {
		t.Fatal("shared mode must not be reported as a single-job pod")
	}
}

func TestProductionExecutorRejectsDatabaseCredentials(t *testing.T) {
	env := map[string]string{
		"RAIBITSERVER_PRODUCTION":               "1",
		"RAIBITSERVER_BUILDER_ROLE":             "executor",
		"RAIBITSERVER_CONTROL_PLANE_REMOTE_URL": "https://builder-dispatcher:8443",
		"DATABASE_URL":                          "postgresql://control-plane.invalid/db",
	}
	if err := validateRoleEnvironment(env); err == nil || !strings.Contains(err.Error(), "must not receive database credentials") {
		t.Fatalf("production executor must fail closed when a database credential is present, got %v", err)
	}
}

func TestExecutorRejectsGitHubAppPrivateKey(t *testing.T) {
	env := map[string]string{
		"RAIBITSERVER_BUILDER_ROLE":                "executor",
		"RAIBITSERVER_CONTROL_PLANE_REMOTE_URL":    "https://builder-dispatcher:8443",
		"RAIBITSERVER_GITHUB_APP_PRIVATE_KEY_FILE": "/run/secrets/github-app.pem",
	}
	if err := validateRoleEnvironment(env); err == nil || !strings.Contains(err.Error(), "GitHub App private key") {
		t.Fatalf("executor must fail closed when a GitHub App private key is present, got %v", err)
	}
}

func TestProductionRequiresExplicitSeparatedBuilderRole(t *testing.T) {
	env := map[string]string{
		"RAIBITSERVER_PRODUCTION": "1",
		"DATABASE_URL":            "postgresql://control-plane.invalid/db",
	}
	if err := validateRoleEnvironment(env); err == nil || !strings.Contains(err.Error(), "dispatcher or executor") {
		t.Fatalf("production must not fall back to a combined DB-and-BuildKit process, got %v", err)
	}
}

func TestDispatcherRejectsBuildExecutionEnvironment(t *testing.T) {
	env := map[string]string{
		"RAIBITSERVER_PRODUCTION":   "1",
		"RAIBITSERVER_BUILDER_ROLE": "dispatcher",
		"RAIBITSERVER_EXECUTE":      "1",
	}
	if err := validateRoleEnvironment(env); err == nil || !strings.Contains(err.Error(), "must not execute tenant build commands") {
		t.Fatalf("trusted dispatcher must not share the tenant command execution path, got %v", err)
	}
}
