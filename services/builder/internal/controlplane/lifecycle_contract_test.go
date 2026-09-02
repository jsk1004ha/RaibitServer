package controlplane_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"github.com/raibitserver/builder/internal/controlplane"
	"github.com/raibitserver/builder/internal/worker"
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

func TestLifecycleContractBuilderPublication(t *testing.T) {
	// Given the shared contract and an isolated real FileStore build.
	fixture := readLifecycleContract(t)
	for _, edge := range [][2]string{
		{"queued", worker.DeploymentStatusBuilding},
		{worker.DeploymentStatusBuilding, worker.DeploymentStatusImageReady},
		{worker.DeploymentStatusBuilding, worker.DeploymentStatusBuildFailed},
	} {
		requireLifecycleEdge(t, fixture.Machines["deployment"], edge)
	}
	for _, edge := range [][2]string{
		{controlplane.WorkflowQueued, controlplane.WorkflowRunning},
		{controlplane.WorkflowRunning, controlplane.WorkflowSucceeded},
		{controlplane.WorkflowRunning, controlplane.WorkflowFailed},
		{controlplane.WorkflowRunning, controlplane.WorkflowQueued},
	} {
		requireLifecycleEdge(t, fixture.Machines["workflow"], edge)
	}
	if !fixture.Machines["deployment"].States[worker.DeploymentStatusBuildFailed].Terminal {
		t.Fatal("BUILD_FAILED must complete the build operation")
	}
	statePath := filepath.Join(t.TempDir(), "state.json")
	seed := []byte(`{"projects":[{"id":"p","status":"ACTIVE"}],"services":[{"id":"s","projectId":"p","status":"CREATED"}],"deployments":[{"id":"d","serviceId":"s","projectId":"p","status":"QUEUED"}],"workflowJobs":[{"id":"j","type":"build-and-deploy","status":"queued","targetType":"deployment","targetId":"d","payload":{},"attempts":0,"maxAttempts":3,"runAfter":"2020-01-01T00:00:00Z"}]}`)
	if err := os.WriteFile(statePath, seed, 0600); err != nil {
		t.Fatal(err)
	}
	store := controlplane.NewFileStore(statePath)
	ctx := context.Background()
	job, err := store.ClaimNextWorkflowJob(ctx, controlplane.ClaimOptions{WorkerID: "lifecycle"})
	if err != nil || job == nil {
		t.Fatalf("claim: job=%v error=%v", job, err)
	}
	if err := store.StartBuild(ctx, controlplane.BuildStartInput{Lease: job.Lease(), DeploymentID: "d", ServiceID: "s", ProjectID: "p"}); err != nil {
		t.Fatal(err)
	}
	// When publication crosses the real store transaction boundary.
	err = store.PublishImageReady(ctx, controlplane.ImagePublicationInput{Lease: job.Lease(), DeploymentID: "d", ServiceID: "s", ProjectID: "p", ImageURL: "registry.test/app@sha256:ready", ImageDigest: "sha256:ready"})
	if err != nil {
		t.Fatal(err)
	}
	// Then the persisted output belongs to the fixture's successful build edge.
	deployment, err := store.GetDeployment(ctx, "d")
	if err != nil {
		t.Fatal(err)
	}
	if deployment.Status != worker.DeploymentStatusImageReady {
		t.Fatalf("publication status=%s", deployment.Status)
	}
	requireLifecycleEdge(t, fixture.Machines["deployment"], [2]string{worker.DeploymentStatusBuilding, deployment.Status})
}
