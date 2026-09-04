package reconciler

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/raibitserver/orchestrator/internal/command"
	"github.com/raibitserver/orchestrator/internal/kube"
	"github.com/raibitserver/orchestrator/internal/store"
)

func (r *ServiceReconciler) runNextPreviewRoute(ctx context.Context) (*ReconcileResult, error) {
	work, err := r.store.ClaimNextPreviewRoute(ctx, store.ClaimOptions{WorkerID: r.config.WorkerID, Lease: 60 * time.Second, Now: r.now().UTC()})
	if err != nil || work == nil {
		return nil, err
	}
	result := &ReconcileResult{Processed: 1, ProjectID: work.ProjectID, ServiceID: work.ServiceID, Reason: "preview_route_" + work.Operation}
	if err := r.store.RenewPreviewRouteLease(ctx, work.Lease, r.now().UTC()); err != nil {
		return result, err
	}
	actual, err := r.getPreviewRoute(ctx, *work)
	if err != nil {
		return result, err
	}
	uid, resourceVersion, err := kube.ObserveRouteIdentity([]byte(actual.Stdout), *work)
	if err != nil {
		return result, err
	}
	intent := store.PreviewRouteIntent{Version: 1, LineageVersion: work.Lease.Version, Operation: work.Operation, Token: work.Lease.Token, Namespace: work.Namespace, Name: work.RouteName, UID: uid, ResourceVersion: resourceVersion}
	if work.Candidate != nil {
		intent.DeploymentID, intent.Generation = work.Candidate.ID, work.Candidate.PreviewGeneration
	}
	if err := r.store.SetPreviewRouteIntent(ctx, work.Lease, intent); err != nil {
		return result, err
	}
	if work.Operation == store.PreviewClear {
		return result, r.clearPreviewRoute(ctx, *work, intent)
	}
	return result, r.promotePreviewRoute(ctx, *work, intent)
}

func (r *ServiceReconciler) promotePreviewRoute(ctx context.Context, work store.PreviewRouteWork, intent store.PreviewRouteIntent) error {
	if work.Candidate == nil {
		return store.ErrPreviewContract
	}
	runtime, err := store.ParsePreviewRuntime(work.Candidate.PreviewRuntimeJSON, work.Lease.LineageID, work.Candidate.ID, work.Candidate.PreviewGeneration)
	if err != nil || runtime.LineageVersion != work.Lease.Version || runtime.Namespace != work.Namespace || runtime.RouteName != work.RouteName || runtime.StableHost != work.StableHost {
		return store.ErrPreviewContract
	}
	service, err := r.store.GetService(ctx, work.ServiceID)
	if err != nil {
		return err
	}
	manifest := kube.PreviewRouteManifest(work, runtime, intent.UID, intent.ResourceVersion, r.config.IngressClassName, service.Port)
	file, err := r.writeManifest(work.Candidate.ID, []map[string]any{manifest}, "preview-route")
	if err != nil {
		return err
	}
	if err := r.store.RenewPreviewRouteLease(ctx, work.Lease, r.now().UTC()); err != nil {
		return err
	}
	verb := "create"
	if intent.UID != "" {
		verb = "replace"
	}
	_, mutationErr := r.runKubectl(ctx, []string{verb, "-f", file})
	if err := r.store.RenewPreviewRouteLease(ctx, work.Lease, r.now().UTC()); err != nil {
		return err
	}
	actual, observeErr := r.getPreviewRoute(ctx, work)
	if observeErr != nil {
		return errors.Join(mutationErr, observeErr)
	}
	observed, observeErr := kube.ObservePreviewRoute([]byte(actual.Stdout), work, runtime)
	if observeErr != nil {
		return errors.Join(mutationErr, observeErr)
	}
	observed.ObservedAt = r.now().UTC()
	if err := r.store.CompletePreviewRoute(ctx, work.Lease, observed); err != nil {
		return errors.Join(mutationErr, err)
	}
	return nil
}

func (r *ServiceReconciler) clearPreviewRoute(ctx context.Context, work store.PreviewRouteWork, intent store.PreviewRouteIntent) error {
	if intent.UID != "" {
		file, err := r.writePreviewDeleteOptions("route-"+work.Lease.LineageID, intent.UID)
		if err != nil {
			return err
		}
		if err := r.store.RenewPreviewRouteLease(ctx, work.Lease, r.now().UTC()); err != nil {
			return err
		}
		_, mutationErr := r.runKubectl(ctx, []string{"delete", "--raw", previewObjectPath(store.PreviewOwnedObject{Group: "networking.k8s.io", Version: "v1", Kind: "Ingress", Namespace: work.Namespace, Name: work.RouteName}), "-f", file})
		if err := r.store.RenewPreviewRouteLease(ctx, work.Lease, r.now().UTC()); err != nil {
			return err
		}
		actual, observeErr := r.getPreviewRoute(ctx, work)
		if observeErr != nil {
			return errors.Join(mutationErr, observeErr)
		}
		if strings.TrimSpace(actual.Stdout) != "" {
			return errors.Join(mutationErr, kube.ErrPreviewObject)
		}
	}
	return r.store.CompletePreviewRoute(ctx, work.Lease, store.PreviewRouteObserved{Version: 1, LineageVersion: work.Lease.Version, Namespace: work.Namespace, Name: work.RouteName, ObservedAt: r.now().UTC()})
}

func (r *ServiceReconciler) getPreviewRoute(ctx context.Context, work store.PreviewRouteWork) (command.Result, error) {
	return r.runKubectl(ctx, []string{"get", "ingress/" + work.RouteName, "--namespace", work.Namespace, "--ignore-not-found=true", "-o", "json"})
}

func (r *ServiceReconciler) writePreviewDeleteOptions(identity, uid string) (string, error) {
	if err := os.MkdirAll(r.config.OutputDir, 0o755); err != nil {
		return "", err
	}
	file := filepath.Join(r.config.OutputDir, fmt.Sprintf("preview-%x-delete-options.json", sha256.Sum256([]byte(identity))))
	payload, err := json.MarshalIndent(map[string]any{"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": map[string]any{"uid": uid}, "propagationPolicy": "Foreground"}, "", "  ")
	if err != nil {
		return "", err
	}
	return file, os.WriteFile(file, append(payload, '\n'), 0o600)
}

func previewObjectPath(object store.PreviewOwnedObject) string {
	namespace, name := url.PathEscape(object.Namespace), url.PathEscape(object.Name)
	switch object.Kind {
	case "Deployment":
		return "/apis/apps/v1/namespaces/" + namespace + "/deployments/" + name
	case "Service":
		return "/api/v1/namespaces/" + namespace + "/services/" + name
	case "Ingress":
		return "/apis/networking.k8s.io/v1/namespaces/" + namespace + "/ingresses/" + name
	default:
		return ""
	}
}
