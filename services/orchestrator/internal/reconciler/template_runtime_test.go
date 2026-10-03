package reconciler

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/orchestrator/internal/command"
	"github.com/raibitserver/orchestrator/internal/store"
)

func TestTemplateRuntimeFreshNamespaceReuseAndPrivatePayload(t *testing.T) {
	request, source, runner := templateFixture(t)
	original := string(request.Deployment.DesiredSpecSnapshot)
	projection, err := ProjectTemplateRuntime(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(runner.commands, "\n")
	if len(runner.effects) != 4 || runner.effects[0] != "create Namespace" || runner.effects[1] != "apply List" || runner.effects[2] != "create RoleBinding" || runner.effects[3] != "create Secret" {
		t.Fatalf("fresh namespace ordering: %v", runner.effects)
	}
	if !runner.privateFiles || strings.Contains(joined, "fixture-plaintext") || strings.Contains(string(projection.Deployment.DesiredSpecSnapshot), "fixture-plaintext") {
		t.Fatal("secret disclosed or file not private")
	}
	if string(request.Deployment.DesiredSpecSnapshot) != original || !strings.Contains(string(projection.Deployment.DesiredSpecSnapshot), `"secretKeyRef"`) {
		t.Fatal("snapshot changed or references missing")
	}
	if files, _ := os.ReadDir(request.OutputDir); len(files) != 0 {
		t.Fatal("private manifest retained")
	}
	before := runner.secretCreates
	if _, err := ProjectTemplateRuntime(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if runner.secretCreates != before {
		t.Fatal("same attempt was not reused")
	}
	for _, secret := range runner.secrets {
		secret["data"].(map[string]any)["TOKEN"] = "d3Jvbmc="
	}
	if _, err := ProjectTemplateRuntime(context.Background(), request); !errors.Is(err, ErrTemplateSecretOwnership) {
		t.Fatalf("changed content accepted: %v", err)
	}
	if source.calls < 4 {
		t.Fatal("effects lack source rechecks")
	}
}

func TestTemplateRuntimeFailsBeforeEffects(t *testing.T) {
	for _, test := range []string{"malformed", "foreign scope", "stale lease", "foreign namespace", "namespace creation fails"} {
		t.Run(test, func(t *testing.T) {
			request, source, runner := templateFixture(t)
			switch test {
			case "malformed":
				request.Deployment.DesiredSpecSnapshot = json.RawMessage(`{"sourceType" : "template",`)
			case "foreign scope":
				source.inputs.EnvironmentID = "foreign"
			case "stale lease":
				source.loseAfter = 1
			case "foreign namespace":
				runner.namespace = map[string]any{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": "org--demo", "uid": "ns-uid", "labels": map[string]any{"raibitserver.io/project-id": "foreign"}}}
			case "namespace creation fails":
				runner.failNamespace = true
			}
			if _, err := ProjectTemplateRuntime(context.Background(), request); err == nil {
				t.Fatal("unsafe projection accepted")
			}
			if runner.secretCreates != 0 || (test != "namespace creation fails" && len(runner.effects) != 0) {
				t.Fatalf("unsafe effects: %v", runner.effects)
			}
		})
	}
}

func TestTemplateSecretCollectionKeepsActualReferencesAndActiveAttempts(t *testing.T) {
	request, source, runner := templateFixture(t)
	first, err := ProjectTemplateRuntime(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	request.Deployment.ReconcileAttempts++
	runner.secrets[first.SecretName]["metadata"].(map[string]any)["labels"].(map[string]any)["raibitserver.io/deployment-id"] = "another-deployment"
	source.collectible = false
	second, err := ProjectTemplateRuntime(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if first.SecretName == second.SecretName || len(runner.secrets) != 2 {
		t.Fatal("attempts share identity or active secret collected")
	}
	source.collectible = true
	for _, ref := range []any{
		map[string]any{"template": map[string]any{"spec": map[string]any{"containers": []any{map[string]any{"env": []any{templateSecretEnv("TOKEN", first.SecretName, "TOKEN")}}}}}},
		map[string]any{"initContainers": []any{map[string]any{"envFrom": []any{map[string]any{"secretRef": map[string]any{"name": first.SecretName}}}}}},
		map[string]any{"volumes": []any{map[string]any{"secret": map[string]any{"secretName": first.SecretName}}}},
		map[string]any{"volumes": []any{map[string]any{"projected": map[string]any{"sources": []any{map[string]any{"secret": map[string]any{"name": first.SecretName}}}}}}},
		map[string]any{"imagePullSecrets": []any{map[string]any{"name": first.SecretName}}},
	} {
		runner.workloads = []any{map[string]any{"kind": "ReplicaSet", "spec": ref}}
		if err := second.CollectUnused(context.Background()); err != nil {
			t.Fatal(err)
		}
		if runner.secrets[first.SecretName] == nil {
			t.Fatal("live reference removed")
		}
	}
	runner.workloads = []any{}
	if err := second.CollectUnused(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.secrets[first.SecretName] != nil || runner.secrets[second.SecretName] == nil || !runner.sawDeletePreconditions {
		t.Fatal("unused secret not collected safely")
	}
	// Service deletion uses its own fence after foreground workload deletion.
	request.Deployment = nil
	fences := 0
	if err := collectTemplateSecrets(context.Background(), request, "org--demo", "project-a", "env-a", "service-a", "", func(context.Context) error { fences++; return nil }); err != nil {
		t.Fatal(err)
	}
	if len(runner.secrets) != 0 || fences < 2 {
		t.Fatal("service deletion retained secret or lacked fence")
	}
}

func TestTemplateRuntimeCancelsWithoutDeletingReferencedSecret(t *testing.T) {
	request, source, runner := templateFixture(t)
	projection, err := ProjectTemplateRuntime(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	source.loseAfter = source.calls
	if err := projection.CheckAuthority(context.Background()); !errors.Is(err, store.ErrDeploymentLeaseLost) {
		t.Fatal(err)
	}
	if err := projection.Cleanup(); err != nil || len(runner.secrets) != 1 {
		t.Fatal("cancellation deleted runtime dependency")
	}
}

func TestTemplateRuntimeWithoutSecretsOmitsEmptySecretEnv(t *testing.T) {
	request, source, _ := templateFixture(t)
	source.inputs.SealedSecrets = nil
	projection, err := ProjectTemplateRuntime(context.Background(), request)
	if err != nil || strings.Contains(string(projection.Deployment.DesiredSpecSnapshot), `"secretEnv"`) {
		t.Fatalf("empty references invalidate runtime: %v", err)
	}
}

func TestTemplateRuntimeRetryCollectsOnlyUnusedOlderAttempts(t *testing.T) {
	request, source, runner := templateFixture(t)
	source.collectible = false // Same deployment's new lease supersedes old attempts.
	for attempt := 1; attempt <= 4; attempt++ {
		request.Deployment.ReconcileAttempts = attempt
		if _, err := ProjectTemplateRuntime(context.Background(), request); err != nil {
			t.Fatal(err)
		}
		if len(runner.secrets) != 1 {
			t.Fatalf("retry leaked attempt secrets: %d", len(runner.secrets))
		}
	}
	runner.binding["roleRef"].(map[string]any)["name"] = "cluster-admin"
	before := runner.secretCreates
	if _, err := ProjectTemplateRuntime(context.Background(), request); !errors.Is(err, ErrTemplateSecretOwnership) {
		t.Fatalf("foreign binding accepted: %v", err)
	}
	if runner.secretCreates != before {
		t.Fatal("foreign binding reached secret creation")
	}
}

func TestUntemplatedServiceDeletionDoesNotNeedSecretGrant(t *testing.T) {
	request, _, runner := templateFixture(t)
	request.Deployment = nil
	if err := collectTemplateSecrets(context.Background(), request, "org--demo", "project-a", "env-a", "service-a", "", func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 1 || !strings.Contains(runner.commands[0], "get rolebinding/") {
		t.Fatal("untemplated service attempted Secret access")
	}
}

func TestTemplateApplyChecksLeaseAgainAfterProjection(t *testing.T) {
	request, source, runner := templateFixture(t)
	t.Setenv("RAIBITSERVER_TEMPLATE_SECRET_CLUSTER_ROLE", request.SecretClusterRole)
	t.Setenv("RAIBITSERVER_ORCHESTRATOR_SERVICE_ACCOUNT", request.OrchestratorServiceAccount)
	t.Setenv("POD_NAMESPACE", request.ControlPlaneNamespace)
	request.Deployment.ImageURL = "registry.test/demo@sha256:" + strings.Repeat("a", 64)
	runner.onSecretCreate = func() { source.loseAfter = source.calls }
	state := &templateReconcileStore{FileStore: store.NewFileStore(writeState(t, map[string]any{})), templateSource: source}
	r := NewServiceReconcilerWithStore(Config{OutputDir: request.OutputDir, BaseDomain: request.BaseDomain}, state, runner)
	_, err := r.applyAndWatch(context.Background(), request.Project, request.Service, request.Deployment, false)
	if !errors.Is(err, store.ErrDeploymentLeaseLost) {
		t.Fatalf("lost authority not surfaced: %v", err)
	}
	applies := 0
	for _, effect := range runner.effects {
		if effect == "apply List" {
			applies++
		}
	}
	if applies != 1 || len(runner.secrets) != 1 {
		t.Fatal("stale lease applied workload or removed restart dependency")
	}
}

func TestProjectDeletionCleansOwnedDevelopmentNamespace(t *testing.T) {
	project := &store.Project{ID: "project-a", OrganizationID: "org", Slug: "demo"}
	namespace := func(name, uid string) string {
		return `{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"` + name + `","uid":"` + uid + `","labels":{"app.kubernetes.io/managed-by":"raibitserver","raibitserver.io/managed":"true","raibitserver.io/namespace-kind":"application","raibitserver.io/project-id":"project-a"}}}`
	}
	runner := &fakeRunner{stdoutFor: func(cmd string) string {
		if strings.Contains(cmd, "get namespaces ") {
			return `{"items":[` + namespace("rb-dev-owned", "dev-uid") + `]}`
		}
		if strings.Contains(cmd, "get namespace/org--demo") {
			return namespace("org--demo", "prod-uid")
		}
		if strings.Contains(cmd, "get namespace/rb-dev-owned") {
			return namespace("rb-dev-owned", "dev-uid")
		}
		return ""
	}}
	r := NewServiceReconcilerWithStore(Config{OutputDir: t.TempDir()}, nil, runner)
	fences := 0
	_, err := r.cleanupProjectNamespaces(context.Background(), project, "org--demo", func(context.Context) error { fences++; return nil })
	commands := strings.Join(runner.commands, "\n")
	if err != nil || !strings.Contains(commands, "delete --raw /api/v1/namespaces/rb-dev-owned") || !strings.Contains(commands, "delete --raw /api/v1/namespaces/org--demo") || fences < 5 {
		t.Fatalf("project left namespace or skipped fence: %v %s", err, commands)
	}
}

type templateReconcileStore struct {
	*store.FileStore
	*templateSource
}

type templateSource struct {
	inputs           *store.TemplateRuntimeInputs
	calls, loseAfter int
	collectible      bool
}

func (s *templateSource) LoadTemplateRuntimeInputs(context.Context, store.DeploymentLease, time.Duration) (*store.TemplateRuntimeInputs, error) {
	s.calls++
	if s.loseAfter > 0 && s.calls > s.loseAfter {
		return nil, store.ErrDeploymentLeaseLost
	}
	return s.inputs, nil
}
func (s *templateSource) TemplateSecretCollectible(context.Context, string, string, string, string, time.Duration) (bool, error) {
	return s.collectible, nil
}

func templateFixture(t *testing.T) (TemplateRuntimeProjectionRequest, *templateSource, *templateRunner) {
	t.Helper()
	key := "template-runtime-test-encryption-key-32-bytes"
	t.Setenv("ENCRYPTION_KEY", key)
	digest := sha256.Sum256([]byte(key))
	block, _ := aes.NewCipher(digest[:])
	gcm, _ := cipher.NewGCM(block)
	iv := []byte("0123456789ab")
	ciphertext := gcm.Seal(nil, iv, []byte("fixture-plaintext"), nil)
	tag := len(ciphertext) - gcm.Overhead()
	encode := base64.RawURLEncoding.EncodeToString
	sealed := "aes256gcm:v1:" + encode(iv) + ":" + encode(ciphertext[tag:]) + ":" + encode(ciphertext[:tag])
	source := &templateSource{collectible: true, inputs: &store.TemplateRuntimeInputs{ProjectID: "project-a", EnvironmentID: "env-a", ServiceID: "service-a", DeploymentID: "deployment-a", SealedSecrets: []store.TemplateSealedSecret{{EnvName: "TOKEN", SecretID: "secret-a", SealedValue: sealed}}}}
	runner := &templateRunner{secrets: map[string]map[string]any{}, privateFiles: true, workloads: []any{}}
	request := TemplateRuntimeProjectionRequest{Source: source, Runner: runner, OutputDir: t.TempDir(), BaseDomain: "example.test", Timeout: time.Second, Project: &store.Project{ID: "project-a", OrganizationID: "org", Slug: "demo"}, Service: &store.Service{ID: "service-a", ProjectID: "project-a", EnvironmentID: "env-a", EnvironmentKind: store.EnvironmentKindProd, Slug: "worker", Type: "worker"}, Deployment: &store.Deployment{ID: "deployment-a", ProjectID: "project-a", ServiceID: "service-a", EnvironmentID: "env-a", SnapshotVersion: 1, ReconcileAction: store.DeploymentActionApply, ReconcileLockedBy: "worker-a", ReconcileAttempts: 1, DesiredSpecSnapshot: json.RawMessage(`{"type":"worker","sourceType":"template","source":{"type":"template"},"environmentId":"env-a"}`)}}
	request.SecretClusterRole, request.OrchestratorServiceAccount, request.ControlPlaneNamespace = "raibitserver-template-secrets", "raibitserver-orchestrator", "control-plane"
	return request, source, runner
}

type templateRunner struct {
	onSecretCreate                                      func()
	binding                                             map[string]any
	commands, effects                                   []string
	namespace                                           map[string]any
	secrets                                             map[string]map[string]any
	workloads                                           []any
	privateFiles, failNamespace, sawDeletePreconditions bool
	secretCreates                                       int
}

func (r *templateRunner) Run(_ context.Context, spec command.Command, dryRun bool, _ time.Duration) (command.Result, error) {
	r.commands = append(r.commands, command.CommandString(spec))
	result := command.Result{Command: command.CommandString(spec), DryRun: dryRun}
	args := spec.Args
	encode := func(value any) string { raw, _ := json.Marshal(value); return string(raw) }
	if args[0] == "get" {
		switch {
		case strings.HasPrefix(args[1], "namespace/"):
			if r.namespace != nil {
				result.Stdout = encode(r.namespace)
			}
		case strings.HasPrefix(args[1], "rolebinding/"):
			if r.binding != nil {
				result.Stdout = encode(r.binding)
			}
		case strings.HasPrefix(args[1], "secret/"):
			if secret := r.secrets[strings.TrimPrefix(args[1], "secret/")]; secret != nil {
				result.Stdout = encode(secret)
			}
		case args[1] == "secrets":
			items := []any{}
			for _, secret := range r.secrets {
				items = append(items, secret)
			}
			result.Stdout = encode(map[string]any{"items": items})
		case args[1] == "pods,deployments,replicasets,statefulsets,daemonsets,jobs,cronjobs":
			result.Stdout = encode(map[string]any{"items": r.workloads})
		}
		return result, nil
	}
	for i, arg := range args {
		if arg != "-f" {
			continue
		}
		info, _ := os.Stat(args[i+1])
		if info == nil || info.Mode().Perm() != 0o600 {
			r.privateFiles = false
		}
		raw, err := os.ReadFile(args[i+1])
		if err != nil {
			return result, err
		}
		var object map[string]any
		if err := json.Unmarshal(raw, &object); err != nil {
			return result, err
		}
		kind, _ := object["kind"].(string)
		r.effects = append(r.effects, args[0]+" "+kind)
		if kind == "Namespace" {
			if r.failNamespace {
				return result, errors.New("namespace create denied")
			}
			object["metadata"].(map[string]any)["uid"] = "namespace-uid"
			r.namespace = object
		}
		if kind == "RoleBinding" {
			object["metadata"].(map[string]any)["uid"] = "binding-uid"
			r.binding = object
		}
		if kind == "Secret" {
			if r.binding == nil {
				return result, errors.New("namespace role binding missing")
			}
			if r.namespace == nil {
				return result, errors.New("namespace missing")
			}
			meta := object["metadata"].(map[string]any)
			meta["uid"], meta["resourceVersion"] = "secret-uid", "1"
			r.secrets[meta["name"].(string)] = object
			r.secretCreates++
			if r.onSecretCreate != nil {
				r.onSecretCreate()
			}
		}
		if kind == "DeleteOptions" {
			pre := object["preconditions"].(map[string]any)
			r.sawDeletePreconditions = pre["uid"] == "secret-uid" && pre["resourceVersion"] == "1"
			path := args[2]
			name := path[strings.LastIndex(path, "/")+1:]
			delete(r.secrets, name)
		}
		break
	}
	return result, nil
}
