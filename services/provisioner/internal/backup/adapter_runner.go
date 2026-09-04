package backup

import (
	"context"
	"errors"
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

type CreatedJobObservation struct {
	Name, UID                 string
	Namespace                 string
	snapshotName, snapshotUID string
	policyName, policyUID     string
	providerPodName           string
	providerPodUID            string
	authority                 string
	labels                    map[string]string
}

type KubernetesJobClient interface {
	CreateAuthorizedJob(context.Context, IsolatedJob, JobStream) (CreatedJobObservation, error)
	WaitJob(context.Context, CreatedJobObservation) (CompletedJobObservation, error)
	CleanupJob(context.Context, CreatedJobObservation) error
}

type KubernetesJobRunner struct{ client KubernetesJobClient }

func NewKubernetesJobRunner(client KubernetesJobClient) (*KubernetesJobRunner, error) {
	if client == nil {
		return nil, ErrRecoveryJob
	}
	return &KubernetesJobRunner{client: client}, nil
}

func (r *KubernetesJobRunner) Run(ctx context.Context, job IsolatedJob, stream JobStream) (result completedJobObservation, resultErr error) {
	runContext, cancel := context.WithTimeout(ctx, job.spec.Deadline)
	defer cancel()
	created, err := r.client.CreateAuthorizedJob(runContext, job, stream)
	if err != nil {
		return completedJobObservation{}, errors.Join(ErrRecoveryJob, err)
	}
	defer func() { resultErr = errors.Join(resultErr, r.client.CleanupJob(context.WithoutCancel(ctx), created)) }()
	if !recoveryPart.MatchString(created.Name) || !providerUIDPattern.MatchString(created.UID) {
		return completedJobObservation{}, ErrRecoveryJob
	}
	observed, err := r.client.WaitJob(runContext, created)
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
