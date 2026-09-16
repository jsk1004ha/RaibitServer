package backup

import (
	"context"
	"strings"
	"time"

	"github.com/raibitserver/provisioner/internal/command"
)

type cleanupLifecycleCommands struct {
	*fakeRecoveryCommands
	jobDeleteErr, jobDeleteWaitErr error
	jobDeleted, recoveryPodsRemain bool
	unrelatedPodSameName           bool
	podSelector                    string
}

func (f *cleanupLifecycleCommands) Run(ctx context.Context, name string, args []string, dryRun bool, timeout time.Duration) (string, error) {
	if len(args) > 1 && args[0] == "wait" && args[1] == "--for=delete" {
		if f.jobDeleteWaitErr != nil {
			return "kubectl wait", f.jobDeleteWaitErr
		}
		f.jobDeleted = true
	}
	return f.fakeRecoveryCommands.Run(ctx, name, args, dryRun, timeout)
}

func (f *cleanupLifecycleCommands) RunSensitiveOutput(ctx context.Context, name string, args []string, timeout time.Duration) (string, []byte, error) {
	if f.jobDeleted && len(args) > 1 {
		if strings.HasPrefix(args[1], "job/") {
			return "kubectl get job", nil, command.ErrObjectNotFound
		}
		if args[1] == "pods" && strings.Contains(strings.Join(args, " "), "job-name=") {
			for index, arg := range args {
				if arg == "-l" && index+1 < len(args) {
					f.podSelector = args[index+1]
				}
			}
			if f.recoveryPodsRemain {
				return "kubectl get pods", mustJSON(map[string]any{"apiVersion": "v1", "kind": "PodList", "items": f.recoveryJobPods()}), nil
			}
			if f.unrelatedPodSameName {
				return "kubectl get pods", mustJSON(map[string]any{"apiVersion": "v1", "kind": "PodList", "items": []any{map[string]any{
					"metadata": map[string]any{"name": "unrelated", "namespace": f.job.spec.Namespace, "uid": "unrelated-uid", "labels": map[string]any{"job-name": recoveryObjectNames(f.job).job}},
				}}}), nil
			}
			return "kubectl get pods", mustJSON(map[string]any{"apiVersion": "v1", "kind": "PodList", "items": []any{}}), nil
		}
	}
	return f.fakeRecoveryCommands.RunSensitiveOutput(ctx, name, args, timeout)
}

func (f *cleanupLifecycleCommands) DeleteObjectUID(ctx context.Context, resource, namespace, name, uid string, timeout time.Duration) (string, error) {
	f.cleanupSawCanceled = f.cleanupSawCanceled || ctx.Err() != nil
	_, f.cleanupSawDeadline = ctx.Deadline()
	f.deleted = append(f.deleted, resource+"/"+name+"@"+uid)
	if resource == "job" && f.jobDeleteErr != nil {
		return "kubernetes-api delete", f.jobDeleteErr
	}
	return "kubernetes-api delete", nil
}
