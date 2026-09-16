package backup

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
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
	receipt                        recoveryreceipt.Receipt
	receiptPresent                 bool
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
	steps                     []createdJobStep
	streamStep                int
	helperReceipt             bool
	engine                    Engine
	image                     string
}

type createdJobStep struct {
	executable, action string
	binding            StreamBinding
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

type completedJobObservation struct {
	name, uid, specIdentity string
	receipt                 recoveryreceipt.Receipt
	receiptPresent          bool
}

func validateCompletedJob(job IsolatedJob, observed CompletedJobObservation) (completedJobObservation, error) {
	if !recoveryPart.MatchString(observed.Name) || !providerUIDPattern.MatchString(observed.UID) || !observed.Succeeded || observed.CompletionTime.IsZero() || observed.Image != job.spec.Image || observed.SpecIdentity != isolatedJobIdentity(job) {
		return completedJobObservation{}, ErrRecoveryJob
	}
	for key, value := range expectedJobLabels(job) {
		if observed.Labels[key] != value {
			return completedJobObservation{}, ErrRecoveryJob
		}
	}
	engine, action, direction, helper := expectedHelperReceipt(job)
	if helper && (!observed.receiptPresent || observed.receipt.ValidateFor(engine, action, direction) != nil) {
		return completedJobObservation{}, ErrRecoveryJob
	}
	return completedJobObservation{name: observed.Name, uid: observed.UID, specIdentity: observed.SpecIdentity, receipt: observed.receipt, receiptPresent: observed.receiptPresent}, nil
}

func (c *CommandKubernetesJobClient) completeObservedJob(ctx context.Context, created CreatedJobObservation, observed kubernetesJobObservation) (CompletedJobObservation, error) {
	completed, err := observed.completed()
	if err != nil || !created.helperReceipt {
		return completed, err
	}
	if created.streamStep < 0 || created.streamStep >= len(created.steps) {
		return CompletedJobObservation{}, ErrRecoveryJob
	}
	var pods recoveryPodList
	selector := "job-name=" + created.Name
	if err := c.readJSON(ctx, []string{"get", "pods", "--namespace", created.Namespace, "-l", selector, "-o", "json"}, &pods); err != nil || len(pods.Items) != 1 {
		return CompletedJobObservation{}, ErrRecoveryJob
	}
	receipt, err := validateRecoveryPodReceipt(pods.Items[0], created)
	if err != nil {
		return CompletedJobObservation{}, ErrRecoveryJob
	}
	direction := recoveryreceipt.DirectionDump
	stream := created.steps[created.streamStep]
	if stream.binding == StreamStdin {
		direction = recoveryreceipt.DirectionRestore
	}
	if receipt.ValidateFor(recoveryreceipt.Engine(created.engine), recoveryreceipt.Action(stream.action), direction) != nil {
		return CompletedJobObservation{}, ErrRecoveryJob
	}
	completed.receipt, completed.receiptPresent = receipt, true
	return completed, nil
}

func expectedHelperReceipt(job IsolatedJob) (recoveryreceipt.Engine, recoveryreceipt.Action, recoveryreceipt.Direction, bool) {
	_, valid := recoveryHelperCommand(job.spec.Steps, job.spec.Connection.Engine())
	if !valid {
		return "", "", "", false
	}
	for _, step := range job.spec.Steps {
		if step.binding == StreamNone {
			continue
		}
		direction := recoveryreceipt.DirectionDump
		if step.binding == StreamStdin {
			direction = recoveryreceipt.DirectionRestore
		}
		return recoveryreceipt.Engine(job.spec.Connection.Engine()), recoveryreceipt.Action(step.command.args[0]), direction, true
	}
	return "", "", "", false
}

type recoveryPodOwner struct {
	APIVersion, Kind, Name, UID string
	Controller                  *bool
}

type recoveryPodContainer struct {
	Name, Image   string
	Command, Args []string
}

type recoveryPodTermination struct {
	ExitCode int
	Message  string
}

type recoveryPodContainerStatus struct {
	Name  string
	State struct {
		Terminated *recoveryPodTermination
	}
}

type recoveryPod struct {
	Metadata struct {
		Name, Namespace, UID string
		Labels               map[string]string
		OwnerReferences      []recoveryPodOwner
	}
	Spec struct {
		InitContainers []recoveryPodContainer
		Containers     []recoveryPodContainer
	}
	Status struct {
		Phase                 string
		InitContainerStatuses []recoveryPodContainerStatus
		ContainerStatuses     []recoveryPodContainerStatus
	}
}

type recoveryPodList struct{ Items []recoveryPod }

func validateRecoveryPodReceipt(pod recoveryPod, created CreatedJobObservation) (recoveryreceipt.Receipt, error) {
	if pod.Metadata.Namespace != created.Namespace || !providerUIDPattern.MatchString(pod.Metadata.UID) || pod.Status.Phase != "Succeeded" || len(pod.Metadata.OwnerReferences) != 1 || len(created.steps) == 0 || len(pod.Spec.InitContainers) != len(created.steps)-1 || len(pod.Spec.Containers) != 1 || len(pod.Status.InitContainerStatuses) != len(created.steps)-1 || len(pod.Status.ContainerStatuses) != 1 {
		return recoveryreceipt.Receipt{}, ErrRecoveryJob
	}
	owner := pod.Metadata.OwnerReferences[0]
	if owner.APIVersion != "batch/v1" || owner.Kind != "Job" || owner.Name != created.Name || owner.UID != created.UID || owner.Controller == nil || !*owner.Controller {
		return recoveryreceipt.Receipt{}, ErrRecoveryJob
	}
	for key, value := range created.labels {
		if pod.Metadata.Labels[key] != value {
			return recoveryreceipt.Receipt{}, ErrRecoveryJob
		}
	}
	for index, expected := range created.steps {
		container, status := recoveryPodStep(pod, index)
		name := "step-" + strconv.Itoa(index)
		if container.Name != name || container.Image != created.image || len(container.Command) != 1 || container.Command[0] != expected.executable || len(container.Args) != 1 || container.Args[0] != expected.action || status.Name != name || status.State.Terminated == nil || status.State.Terminated.ExitCode != 0 {
			return recoveryreceipt.Receipt{}, ErrRecoveryJob
		}
	}
	finalStatus := pod.Status.ContainerStatuses[0]
	receipt, err := recoveryreceipt.Parse([]byte(finalStatus.State.Terminated.Message))
	if err != nil {
		return recoveryreceipt.Receipt{}, ErrRecoveryJob
	}
	return receipt, nil
}

func recoveryPodStep(pod recoveryPod, index int) (recoveryPodContainer, recoveryPodContainerStatus) {
	if index == len(pod.Spec.InitContainers) {
		return pod.Spec.Containers[0], pod.Status.ContainerStatuses[0]
	}
	return pod.Spec.InitContainers[index], pod.Status.InitContainerStatuses[index]
}
