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

func TestLifecycleContractProvisionerClaims(t *testing.T) {
	// Given the fixture and production resource claim statuses.
	fixture := readLifecycleContract(t)
	machine := fixture.Machines["resource"]
	for _, state := range []string{"HEALTHY", "UNHEALTHY"} {
		if !fixture.Machines["resourceHealth"].States[state].Terminal {
			t.Fatalf("resource health observation missing: %s", state)
		}
	}
	for _, edge := range [][2]string{
		{StatusProvisioning, StatusReconciling},
		{StatusReady, StatusReconciling},
		{StatusFailed, StatusReconciling},
		{StatusReconciling, StatusReady},
		{StatusReconciling, StatusFailed},
		{StatusDeleteRequested, StatusDeleting},
		{StatusDeleting, StatusDeleted},
	} {
		requireLifecycleEdge(t, machine, edge)
	}
	for _, status := range []string{StatusProvisioning, StatusReconciling, StatusReady, StatusFailed, StatusDeleteRequested, StatusDeleting, StatusDeleted} {
		// When the real store boundary checks a claim.
		_, normalized, err := activeClaim(&Resource{Status: strings.ToLower(status), ClaimToken: "2026-01-01T00:00:00Z"})
		// Then only the two nonterminal execution states can own a claim.
		active := status == StatusReconciling || status == StatusDeleting
		if active != (err == nil) {
			t.Fatalf("claim state %s: error=%v", status, err)
		}
		if active && (normalized != status || machine.States[normalized].Terminal) {
			t.Fatalf("active state mismatch %s", status)
		}
	}
	for _, status := range []string{StatusReady, StatusFailed, StatusDeleted} {
		if !machine.States[status].Terminal {
			t.Fatalf("completed resource outcome missing: %s", status)
		}
	}
}
