package backup

import (
	"context"
	"errors"
	"slices"
	"time"
)

type LiveSecretObservation struct {
	Namespace, Name, UID string
	Annotations          map[string]string
	Keys                 []string
}

type LiveWorkloadObservation struct {
	Namespace, Name, UID, Image string
	Generation                  int64
}

type CompletedJobObservation struct {
	Name, UID, Image, SpecIdentity string
	Succeeded                      bool
	CompletionTime                 time.Time
	Labels                         map[string]string
}

type CreatedJobObservation struct{ Name, UID string }

type KubernetesJobClient interface {
	ObserveProviderWorkload(context.Context, string, string) (LiveWorkloadObservation, error)
	ObserveSecret(context.Context, string, string) (LiveSecretObservation, error)
	CreateJob(context.Context, IsolatedJob, JobStream) (CreatedJobObservation, error)
	WaitJob(context.Context, string, string, string) (CompletedJobObservation, error)
}

type KubernetesJobRunner struct{ client KubernetesJobClient }

func NewKubernetesJobRunner(client KubernetesJobClient) (*KubernetesJobRunner, error) {
	if client == nil {
		return nil, ErrRecoveryJob
	}
	return &KubernetesJobRunner{client: client}, nil
}

func (r *KubernetesJobRunner) Run(ctx context.Context, job IsolatedJob, stream JobStream) (completedJobObservation, error) {
	runContext, cancel := context.WithTimeout(ctx, job.spec.Deadline)
	defer cancel()
	connection := job.spec.Connection
	provider := connection.spec.Provenance.spec
	workload, err := r.client.ObserveProviderWorkload(runContext, provider.Namespace, provider.Name)
	if err != nil {
		return completedJobObservation{}, errors.Join(ErrRecoveryJob, err)
	}
	if workload.Namespace != provider.Namespace || workload.Name != provider.Name || workload.UID != provider.UID || workload.Generation != provider.Generation || workload.Image != provider.Image {
		return completedJobObservation{}, ErrRecoveryJob
	}
	if connection.Engine() != EngineSQLite {
		secret := connection.spec.Secret
		live, observeErr := r.client.ObserveSecret(runContext, secret.namespace, secret.name)
		if observeErr != nil {
			return completedJobObservation{}, errors.Join(ErrRecoveryJob, observeErr)
		}
		if live.Namespace != secret.namespace || live.Name != secret.name || live.UID != provider.CredentialUID || live.Annotations["raibitserver.io/credential-generation"] != provider.CredentialGeneration || live.Annotations["raibitserver.io/credential-owner"] != "raibitserver-provisioner" || live.Annotations["raibitserver.io/resource-id"] != connection.ResourceID() || live.Annotations["raibitserver.io/project-id"] != connection.spec.ProjectID || !slices.Contains(live.Keys, secret.key) {
			return completedJobObservation{}, ErrRecoveryJob
		}
	}
	created, err := r.client.CreateJob(runContext, job, stream)
	if err != nil {
		return completedJobObservation{}, errors.Join(ErrRecoveryJob, err)
	}
	if !recoveryPart.MatchString(created.Name) || !providerUIDPattern.MatchString(created.UID) {
		return completedJobObservation{}, ErrRecoveryJob
	}
	observed, err := r.client.WaitJob(runContext, job.spec.Namespace, created.Name, created.UID)
	if err != nil {
		return completedJobObservation{}, err
	}
	if observed.Name != created.Name || observed.UID != created.UID {
		return completedJobObservation{}, ErrRecoveryJob
	}
	return validateCompletedJob(job, observed)
}

type completedJobObservation struct{ name, uid, specIdentity string }

func validateCompletedJob(job IsolatedJob, observed CompletedJobObservation) (completedJobObservation, error) {
	if !recoveryPart.MatchString(observed.Name) || !providerUIDPattern.MatchString(observed.UID) || !observed.Succeeded || observed.CompletionTime.IsZero() || observed.Image != job.spec.Image || observed.SpecIdentity != isolatedJobIdentity(job) {
		return completedJobObservation{}, ErrRecoveryJob
	}
	for key, value := range expectedJobLabels(job) {
		if observed.Labels[key] != value {
			return completedJobObservation{}, ErrRecoveryJob
		}
	}
	return completedJobObservation{name: observed.Name, uid: observed.UID, specIdentity: observed.SpecIdentity}, nil
}
