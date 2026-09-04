package backup

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type fakeRecoveryKubernetes struct {
	secret     LiveSecretObservation
	workload   LiveWorkloadObservation
	completion func(IsolatedJob) CompletedJobObservation
	created    CreatedJobObservation
	job        IsolatedJob
	calls      []string
}

func (f *fakeRecoveryKubernetes) ObserveProviderWorkload(_ context.Context, _, _ string) (LiveWorkloadObservation, error) {
	f.calls = append(f.calls, "workload")
	return f.workload, nil
}

func (f *fakeRecoveryKubernetes) ObserveSecret(_ context.Context, _, _ string) (LiveSecretObservation, error) {
	f.calls = append(f.calls, "secret")
	return f.secret, nil
}

func (f *fakeRecoveryKubernetes) CreateJob(_ context.Context, job IsolatedJob, stream JobStream) (CreatedJobObservation, error) {
	f.calls = append(f.calls, "create")
	f.job = job
	if bindingMatches(job, dumpDirection) {
		if _, err := io.WriteString(stream.Output(), "dump"); err != nil {
			return CreatedJobObservation{}, err
		}
	} else {
		if _, err := io.Copy(io.Discard, stream.Input()); err != nil {
			return CreatedJobObservation{}, err
		}
	}
	return f.created, nil
}

func (f *fakeRecoveryKubernetes) WaitJob(_ context.Context, _, _, _ string) (CompletedJobObservation, error) {
	f.calls = append(f.calls, "wait")
	return f.completion(f.job), nil
}

func trustedKubernetes(job IsolatedJob) *fakeRecoveryKubernetes {
	provider := job.spec.Connection.spec.Provenance.spec
	secret := job.spec.Connection.spec.Secret
	return &fakeRecoveryKubernetes{
		created: CreatedJobObservation{Name: "recovery-job", UID: "recovery-job-uid"},
		secret: LiveSecretObservation{Namespace: secret.namespace, Name: secret.name, UID: provider.CredentialUID, Annotations: map[string]string{
			"raibitserver.io/credential-generation": provider.CredentialGeneration,
			"raibitserver.io/credential-owner":      "raibitserver-provisioner",
			"raibitserver.io/resource-id":           job.spec.Connection.ResourceID(),
			"raibitserver.io/project-id":            job.spec.Connection.spec.ProjectID,
		}, Keys: []string{secret.key}},
		workload: LiveWorkloadObservation{Namespace: provider.Namespace, Name: provider.Name, UID: provider.UID, Generation: provider.Generation, Image: provider.Image},
		completion: func(job IsolatedJob) CompletedJobObservation {
			return CompletedJobObservation{Name: "recovery-job", UID: "recovery-job-uid", Image: job.spec.Image, SpecIdentity: job.Identity(), Succeeded: true, CompletionTime: time.Unix(1, 0), Labels: job.Labels()}
		},
	}
}

func Test_KubernetesJobRunner_when_same_name_secret_was_replaced(t *testing.T) {
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	client := trustedKubernetes(job)
	client.secret.UID = "replacement-secret-uid"
	runner, _ := NewKubernetesJobRunner(client)
	output := &countingWriteCloser{}
	handoff, _ := NewDumpHandoff(context.Background(), output, 16)
	if receipt, runErr := handoff.Execute(context.Background(), job, runner); !errors.Is(runErr, ErrRecoveryJob) || receipt.Name() != "" || strings.Join(client.calls, ",") != "workload,secret" || output.closes.Load() != 1 {
		t.Fatalf("receipt=%+v calls=%v closes=%d err=%v", receipt, client.calls, output.closes.Load(), runErr)
	}
}

func Test_KubernetesJobRunner_when_secret_generation_or_key_differs(t *testing.T) {
	for _, mutate := range []func(*LiveSecretObservation){
		func(value *LiveSecretObservation) {
			value.Annotations["raibitserver.io/credential-generation"] = strings.Repeat("x", 43)
		},
		func(value *LiveSecretObservation) { value.Keys = []string{"WRONG_KEY"} },
	} {
		connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
		job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
		if err != nil {
			t.Fatal(err)
		}
		client := trustedKubernetes(job)
		mutate(&client.secret)
		runner, _ := NewKubernetesJobRunner(client)
		handoff, _ := NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)
		if _, runErr := handoff.Execute(context.Background(), job, runner); !errors.Is(runErr, ErrRecoveryJob) || strings.Contains(strings.Join(client.calls, ","), "create") {
			t.Fatalf("stale Secret authority reached create: calls=%v err=%v", client.calls, runErr)
		}
	}
}

func Test_KubernetesJobRunner_when_live_authority_and_completion_are_exact(t *testing.T) {
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	job, err := NewIsolatedJob(testJobSpec(t, connection, StreamStdout))
	if err != nil {
		t.Fatal(err)
	}
	client := trustedKubernetes(job)
	runner, _ := NewKubernetesJobRunner(client)
	handoff, _ := NewDumpHandoff(context.Background(), &countingWriteCloser{}, 16)
	receipt, err := handoff.Execute(context.Background(), job, runner)
	if err != nil || receipt.UID() != "recovery-job-uid" || receipt.Bytes() != 4 || strings.Join(client.calls, ",") != "workload,secret,create,wait" {
		t.Fatalf("receipt=%+v calls=%v err=%v", receipt, client.calls, err)
	}
}

func Test_KubernetesJobRunner_when_completed_job_is_incomplete_or_wrong_attempt(t *testing.T) {
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	target := testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.7")
	artifact := testArtifact(t, source)
	restore, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	if err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*CompletedJobObservation){
		func(value *CompletedJobObservation) { value.Succeeded = false },
		func(value *CompletedJobObservation) { value.Labels["raibitserver.io/attempt"] = "3" },
	} {
		job, jobErr := NewIsolatedJob(testJobSpec(t, target, StreamStdin))
		if jobErr != nil {
			t.Fatal(jobErr)
		}
		client := trustedKubernetes(job)
		validCompletion := client.completion
		client.completion = func(job IsolatedJob) CompletedJobObservation {
			value := validCompletion(job)
			value.Labels = cloneMap(value.Labels)
			mutate(&value)
			return value
		}
		runner, _ := NewKubernetesJobRunner(client)
		handoff, _ := NewRestoreHandoff(context.Background(), io.NopCloser(strings.NewReader("dump")), 16)
		receipt, runErr := handoff.Execute(context.Background(), job, runner)
		if !errors.Is(runErr, ErrRecoveryJob) || receipt.Name() != "" {
			t.Fatalf("untrusted completion minted receipt: receipt=%+v err=%v", receipt, runErr)
		}
		if _, verifyErr := NewVerificationReceipt(restore, receipt, testBaseline(t)); !errors.Is(verifyErr, ErrRecoveryRequest) {
			t.Fatalf("untrusted completion reached verification: %v", verifyErr)
		}
	}
}
