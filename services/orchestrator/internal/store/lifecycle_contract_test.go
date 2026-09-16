package store

import (
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"
)

type lifecycleState struct {
	Terminal bool     `json:"terminal"`
	Next     []string `json:"next"`
}
type lifecycleMachine struct {
	Initial string                    `json:"initial"`
	States  map[string]lifecycleState `json:"states"`
	Aliases map[string]string         `json:"aliases"`
}
type lifecycleFixture struct {
	Version  int                         `json:"version"`
	Machines map[string]lifecycleMachine `json:"machines"`
}

func readLifecycleContract(t *testing.T) lifecycleFixture {
	t.Helper()
	fixturePath := os.Getenv("RAIBITSERVER_LIFECYCLE_FIXTURE")
	if fixturePath == "" {
		fixturePath = filepath.Join("..", "..", "..", "..", "test-fixtures", "contracts", "lifecycle-v1.json")
	}
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture lifecycleFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Version != 1 {
		t.Fatalf("unsupported lifecycle version %d", fixture.Version)
	}
	var edges []string
	for _, name := range []string{"deployment", "workflow", "resource", "backup", "restore", "domain", "tls", "health", "resourceHealth"} {
		machine, exists := fixture.Machines[name]
		if !exists || len(machine.States) == 0 {
			t.Fatalf("missing lifecycle %s", name)
		}
		if _, exists := machine.States[machine.Initial]; !exists {
			t.Fatalf("%s: unknown initial state %s", name, machine.Initial)
		}
		for from, state := range machine.States {
			seen := make(map[string]bool)
			for _, to := range state.Next {
				if _, exists := machine.States[to]; !exists {
					t.Fatalf("%s: unknown transition %s -> %s", name, from, to)
				}
				if seen[to] {
					t.Fatalf("%s: duplicate transition %s -> %s", name, from, to)
				}
				seen[to] = true
				edges = append(edges, name+":"+from+"->"+to)
			}
		}
		for alias, to := range machine.Aliases {
			if _, exists := machine.States[to]; !exists {
				t.Fatalf("%s: unknown alias %s -> %s", name, alias, to)
			}
		}
	}
	sort.Strings(edges)
	t.Logf("transition-sha256=%x", sha256.Sum256([]byte(strings.Join(edges, "\n")+"\n")))
	return fixture
}

func requireLifecycleEdge(t *testing.T, machine lifecycleMachine, edge [2]string) {
	t.Helper()
	state, exists := machine.States[edge[0]]
	if !exists || !slices.Contains(state.Next, edge[1]) {
		t.Fatalf("required consumer transition missing: %s -> %s", edge[0], edge[1])
	}
}

func TestLifecycleContractOrchestratorActions(t *testing.T) {
	// Given the shared fixture and production claim dispatch states.
	fixture := readLifecycleContract(t)
	deployment := fixture.Machines["deployment"]
	for _, edge := range [][2]string{
		{DeletionStatusDeleteRequested, DeletionStatusDeleting},
		{DeletionStatusDeleting, DeletionStatusDeleted},
	} {
		requireLifecycleEdge(t, fixture.Machines["resource"], edge)
	}
	for _, row := range []struct{ status, action string }{
		{DeploymentStatusImageReady, DeploymentActionApply},
		{DeploymentStatusRollbackRequested, DeploymentActionRollback},
		{DeploymentStatusCleanupRequested, DeploymentActionCleanup},
	} {
		t.Run(row.status, func(t *testing.T) {
			// When the store decides whether to claim a real runtime state.
			action, claimable := deploymentActionForClaim(record{"status": row.status}, time.Unix(1, 0), time.Minute)
			// Then both the dispatch and its claimed status are contract-conformant.
			if !claimable || action != row.action {
				t.Fatalf("action=%s claimable=%v", action, claimable)
			}
			requireLifecycleEdge(t, deployment, [2]string{row.status, DeploymentStatusDeploying})
		})
	}
	for _, status := range []string{DeploymentStatusReady, DeploymentStatusFailed, "BUILD_FAILED", "CANCELLED", DeploymentStatusCleanedUp} {
		if !terminalDeploymentForDeletion(status) || !deployment.States[status].Terminal {
			t.Fatalf("terminal deployment missing from contract or store: %s", status)
		}
	}
	for _, edge := range [][2]string{
		{DeploymentStatusDeploying, DeploymentStatusReady},
		{DeploymentStatusDeploying, DeploymentStatusFailed},
		{DeploymentStatusDeploying, DeploymentStatusCleanedUp},
		{DeploymentStatusReady, DeploymentStatusCleanupRequested},
	} {
		requireLifecycleEdge(t, deployment, edge)
	}
	if deployment.States[DeploymentStatusCleanupRequested].Terminal {
		t.Fatal("pending cleanup cannot be terminal")
	}
}
