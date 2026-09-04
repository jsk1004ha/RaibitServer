package backup

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/provisioner/internal/command"
)

type fakeRecoveryCommands struct {
	job                    IsolatedJob
	created                []map[string]any
	deleted                []string
	sourceReplaced         bool
	workloadUID            string
	workloadImage          string
	workloadGeneration     int64
	snapshotAlreadyExists  bool
	workloadReads          int
	driftBeforeJob         bool
	streamErr              error
	cleanupSawCanceled     bool
	cleanupSawDeadline     bool
	jobCreates             int
	authorityBound         bool
	authorityReleased      bool
	authorityValue         string
	bindErrAfterSideEffect bool
	createFailureKind      string
	jobReceipt             string
	jobPodCount            int
	omitJobPods            bool
	mutateJobPod           func(map[string]any)
}

func (f *fakeRecoveryCommands) Run(ctx context.Context, _ string, args []string, _ bool, _ time.Duration) (string, error) {
	if len(args) > 0 && args[0] == "wait" {
		return "kubectl wait", nil
	}
	if len(args) > 1 && args[0] == "patch" && strings.HasPrefix(args[1], "pod/") {
		f.cleanupSawCanceled = f.cleanupSawCanceled || ctx.Err() != nil
		_, f.cleanupSawDeadline = ctx.Deadline()
		if !patchContains(args, "test", "/metadata/uid", "provider-pod-uid") || !patchContains(args, "test", "/metadata/resourceVersion", "32") || !patchContains(args, "remove", "/metadata/labels/raibitserver.io~1recovery-authority", "") {
			return "kubectl patch", ErrRecoveryJob
		}
		f.authorityReleased = true
		return "kubectl patch", nil
	}
	return "", fmt.Errorf("unexpected command: %v", args)
}

func (f *fakeRecoveryCommands) RunSensitiveOutput(ctx context.Context, _ string, args []string, _ time.Duration) (string, []byte, error) {
	if err := ctx.Err(); err != nil {
		return "kubectl", nil, err
	}
	provider := f.job.spec.Connection.spec.Provenance.spec
	switch args[1] {
	case "statefulset/" + provider.Name:
		f.workloadReads++
		uid, image, generation := provider.UID, provider.Image, provider.Generation
		if f.workloadUID != "" {
			uid = f.workloadUID
		}
		if f.workloadImage != "" {
			image = f.workloadImage
		}
		if f.workloadGeneration != 0 {
			generation = f.workloadGeneration
		}
		if f.driftBeforeJob && f.workloadReads > 1 {
			uid = "replacement-workload-uid"
		}
		return "kubectl get statefulset", mustJSON(map[string]any{"metadata": map[string]any{"name": provider.Name, "namespace": provider.Namespace, "uid": uid, "generation": generation}, "spec": map[string]any{"template": map[string]any{"metadata": map[string]any{"labels": map[string]any{"app.kubernetes.io/name": provider.Name, "app.kubernetes.io/managed-by": "raibitserver", "raibitserver.io/managed": "true", "raibitserver.io/provider": string(f.job.spec.Connection.Engine()), "raibitserver.io/resource-id": f.job.spec.Connection.ResourceID(), "raibitserver.io/project-id": f.job.spec.Connection.spec.ProjectID}}, "spec": map[string]any{"containers": []any{map[string]any{"image": image}}}}}}), nil
	case "secret/" + f.job.spec.Connection.spec.Secret.name:
		ref := f.job.spec.Connection.spec.Secret
		f.sourceReplaced = true
		return "kubectl get secret", mustJSON(map[string]any{"metadata": map[string]any{"name": ref.name, "namespace": ref.namespace, "uid": provider.CredentialUID, "resourceVersion": "19", "annotations": map[string]any{"raibitserver.io/credential-generation": provider.CredentialGeneration, "raibitserver.io/credential-owner": "raibitserver-provisioner", "raibitserver.io/resource-id": f.job.spec.Connection.ResourceID(), "raibitserver.io/project-id": f.job.spec.Connection.spec.ProjectID}}, "data": map[string]any{ref.key: base64.StdEncoding.EncodeToString([]byte("old-exact-secret")), "UNRELATED": base64.StdEncoding.EncodeToString([]byte("must-not-copy"))}}), nil
	case "pods":
		if strings.Contains(strings.Join(args, " "), "job-name=") {
			return "kubectl get pods", mustJSON(map[string]any{"items": f.recoveryJobPods()}), nil
		}
		return "kubectl get pods", mustJSON(map[string]any{"items": []any{f.providerPod("31", "")}}), nil
	default:
		if strings.HasPrefix(args[1], "pod/") {
			if args[0] == "patch" {
				authority := patchValue(args)
				if authority == "" || !patchContains(args, "test", "/metadata/uid", "provider-pod-uid") || !patchContains(args, "test", "/metadata/resourceVersion", "31") {
					return "kubectl patch pod", nil, ErrRecoveryJob
				}
				f.authorityBound = true
				f.authorityValue = authority
				if f.bindErrAfterSideEffect {
					return "kubectl patch pod", nil, context.Canceled
				}
				return "kubectl patch pod", mustJSON(f.providerPod("32", authority)), nil
			}
			return "kubectl get pod", mustJSON(f.providerPod("32", f.authorityValue)), nil
		}
		if strings.HasPrefix(args[1], "secret/recovery-credential-") {
			ref := f.job.spec.Connection.spec.Secret
			provider := f.job.spec.Connection.spec.Provenance.spec
			return "kubectl get secret", mustJSON(map[string]any{"metadata": map[string]any{"name": strings.TrimPrefix(args[1], "secret/"), "namespace": ref.namespace, "uid": "snapshot-uid", "resourceVersion": "20", "labels": expectedJobLabels(f.job), "annotations": map[string]any{"raibitserver.io/source-secret-uid": provider.CredentialUID, "raibitserver.io/source-secret-resource-version": "19", "raibitserver.io/source-secret-key": ref.key}}, "immutable": true, "data": map[string]any{ref.key: base64.StdEncoding.EncodeToString([]byte("old-exact-secret"))}}), nil
		}
		if strings.HasPrefix(args[1], "job/") {
			manifest := f.created[len(f.created)-1]
			metadata := manifest["metadata"].(map[string]any)
			spec := manifest["spec"].(map[string]any)
			return "kubectl get job", mustJSON(map[string]any{"metadata": map[string]any{"name": metadata["name"], "namespace": metadata["namespace"], "uid": "job-uid", "labels": metadata["labels"], "annotations": metadata["annotations"]}, "spec": map[string]any{"template": spec["template"]}, "status": map[string]any{"succeeded": 1, "completionTime": "2026-09-04T00:00:00Z"}}), nil
		}
		if strings.HasPrefix(args[1], "networkpolicy/") {
			for index := len(f.created) - 1; index >= 0; index-- {
				manifest := f.created[index]
				if manifest["kind"] != "NetworkPolicy" {
					continue
				}
				metadata := manifest["metadata"].(map[string]any)
				return "kubectl get networkpolicy", mustJSON(map[string]any{"metadata": map[string]any{"name": metadata["name"], "namespace": metadata["namespace"], "uid": "policy-uid", "labels": metadata["labels"]}}), nil
			}
			return "kubectl get networkpolicy", nil, command.ErrObjectNotFound
		}
	}
	return "", nil, fmt.Errorf("unexpected get: %v", args)
}

func Test_CommandKubernetesJobClient_rejects_changed_provider_before_any_create(t *testing.T) {
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*fakeRecoveryCommands){
		"uid":        func(f *fakeRecoveryCommands) { f.workloadUID = "replacement-workload-uid" },
		"generation": func(f *fakeRecoveryCommands) { f.workloadGeneration = 99 },
		"image": func(f *fakeRecoveryCommands) {
			f.workloadImage = "registry.example/replacement@sha256:" + strings.Repeat("a", 64)
		},
	} {
		t.Run(name, func(t *testing.T) {
			commands := &fakeRecoveryCommands{job: job}
			mutate(commands)
			client, clientErr := NewCommandKubernetesJobClient(commands, time.Minute)
			if clientErr != nil {
				t.Fatal(clientErr)
			}
			handoff, _ := NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)
			runner, _ := NewKubernetesJobRunner(client)
			if _, runErr := handoff.Execute(context.Background(), job, runner); !errors.Is(runErr, ErrRecoveryJob) || len(commands.created) != 0 {
				t.Fatalf("creates=%d err=%v", len(commands.created), runErr)
			}
		})
	}
}

func (f *fakeRecoveryCommands) RunCreateInputUID(ctx context.Context, _ string, _ []string, input []byte, _ time.Duration) (string, string, error) {
	if err := ctx.Err(); err != nil {
		return "kubectl create", "", err
	}
	var object map[string]any
	if json.Unmarshal(input, &object) != nil {
		return "", "", ErrRecoveryJob
	}
	f.created = append(f.created, object)
	if fmt.Sprint(object["kind"]) == f.createFailureKind {
		return "kubectl create", "", context.Canceled
	}
	switch object["kind"] {
	case "Secret":
		if object["immutable"] != true || !f.sourceReplaced {
			return "", "", ErrRecoveryJob
		}
		data := object["data"].(map[string]any)
		if len(data) != 1 || data[f.job.spec.Connection.spec.Secret.key] != base64.StdEncoding.EncodeToString([]byte("old-exact-secret")) {
			return "", "", ErrRecoveryJob
		}
		if f.snapshotAlreadyExists {
			return "kubectl create", "", command.ErrAlreadyExists
		}
		return "kubectl create", "snapshot-uid", nil
	case "NetworkPolicy":
		return "kubectl create", "policy-uid", nil
	case "Job":
		f.jobCreates++
		if containsString(object, f.job.spec.Connection.spec.Secret.name) || !containsString(object, "recovery-credential-") {
			return "", "", ErrRecoveryJob
		}
		return "kubectl create", "job-uid", nil
	}
	return "", "", ErrRecoveryJob
}

func (f *fakeRecoveryCommands) RunStream(ctx context.Context, _ string, args []string, _ io.Reader, output io.Writer, _ time.Duration) (string, error) {
	if err := ctx.Err(); err != nil {
		return "kubectl stream", err
	}
	if f.streamErr != nil {
		return "kubectl logs", f.streamErr
	}
	if args[0] == "attach" {
		return "kubectl attach", nil
	}
	if args[0] != "logs" {
		return "", ErrRecoveryJob
	}
	_, err := io.WriteString(output, "dump")
	return "kubectl logs", err
}

func (f *fakeRecoveryCommands) DeleteObjectUID(ctx context.Context, resource, _, name, uid string, _ time.Duration) (string, error) {
	f.cleanupSawCanceled = f.cleanupSawCanceled || ctx.Err() != nil
	_, f.cleanupSawDeadline = ctx.Deadline()
	f.deleted = append(f.deleted, resource+"/"+name+"@"+uid)
	return "kubectl delete", nil
}

func Test_CommandKubernetesJobClient_snapshots_exact_secret_before_replacement_and_cleans_by_UID(t *testing.T) {
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	commands := &fakeRecoveryCommands{job: job}
	client, err := NewCommandKubernetesJobClient(commands, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	runner, _ := NewKubernetesJobRunner(client)
	handoff, _ := NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)
	receipt, err := handoff.Execute(context.Background(), job, runner)
	if err != nil || receipt.UID() != "job-uid" || receipt.Bytes() != 4 || len(commands.created) != 3 || len(commands.deleted) != 3 || !commands.authorityReleased {
		t.Fatalf("receipt=%+v creates=%d deletes=%v err=%v", receipt, len(commands.created), commands.deleted, err)
	}
	policySpec := commands.created[1]["spec"].(map[string]any)
	jobSpec := commands.created[2]["spec"].(map[string]any)
	podSpec := jobSpec["template"].(map[string]any)["spec"].(map[string]any)
	container := podSpec["containers"].([]any)[0].(map[string]any)
	security := container["securityContext"].(map[string]any)
	automount, _ := podSpec["automountServiceAccountToken"].(bool)
	privilege, _ := security["allowPrivilegeEscalation"].(bool)
	readOnly, _ := security["readOnlyRootFilesystem"].(bool)
	if automount || fmt.Sprint(jobSpec["backoffLimit"]) != "0" || privilege || !readOnly || len(policySpec["ingress"].([]any)) != 0 || len(policySpec["egress"].([]any)) != 2 {
		t.Fatalf("runtime boundary missing: pod=%#v policy=%#v", podSpec, policySpec)
	}
	for _, suffix := range []string{"@job-uid", "@policy-uid", "@snapshot-uid"} {
		if !strings.Contains(strings.Join(commands.deleted, ","), suffix) {
			t.Fatalf("UID cleanup missing %s: %v", suffix, commands.deleted)
		}
	}
}
