package kube

import (
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/raibitserver/orchestrator/internal/store"
)

var ErrPreviewObject = errors.New("owned preview Kubernetes object is unavailable")

type previewObjectJSON struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   struct {
		Name              string            `json:"name"`
		Namespace         string            `json:"namespace"`
		UID               string            `json:"uid"`
		ResourceVersion   string            `json:"resourceVersion"`
		DeletionTimestamp string            `json:"deletionTimestamp"`
		Labels            map[string]string `json:"labels"`
		Annotations       map[string]string `json:"annotations"`
	} `json:"metadata"`
	Spec struct {
		Selector map[string]string `json:"selector"`
		Rules    []struct {
			Host string `json:"host"`
			HTTP struct {
				Paths []struct {
					Backend struct {
						Service struct {
							Name string `json:"name"`
						} `json:"service"`
					} `json:"backend"`
				} `json:"paths"`
			} `json:"http"`
		} `json:"rules"`
	} `json:"spec"`
}

func ObservePreviewObject(raw []byte, runtime store.PreviewRuntime, projectID, serviceID, kind string) (store.PreviewOwnedObject, error) {
	object, err := parsePreviewObject(raw)
	if err != nil {
		return store.PreviewOwnedObject{}, err
	}
	expectedName := runtime.WorkloadName
	group := ""
	apiVersion := "v1"
	switch kind {
	case "Deployment":
		group = "apps"
		apiVersion = "apps/v1"
	case "Service":
	case "Ingress":
		group = "networking.k8s.io"
		apiVersion = "networking.k8s.io/v1"
	default:
		return store.PreviewOwnedObject{}, ErrPreviewObject
	}
	labels := object.Metadata.Labels
	if object.APIVersion != apiVersion || object.Kind != kind || object.Metadata.Name != expectedName || object.Metadata.Namespace != runtime.Namespace ||
		labels["app.kubernetes.io/managed-by"] != "raibitserver" || labels["raibitserver.io/project-id"] != projectID ||
		labels["raibitserver.io/service-id"] != serviceID || labels["raibitserver.io/deployment-id"] != runtime.DeploymentID ||
		labels["raibitserver.io/preview-lineage-id"] != runtime.LineageID || labels["raibitserver.io/preview-generation"] != strconv.Itoa(runtime.Generation) {
		return store.PreviewOwnedObject{}, ErrPreviewObject
	}
	if kind == "Service" && object.Spec.Selector["app.kubernetes.io/name"] != runtime.WorkloadName {
		return store.PreviewOwnedObject{}, ErrPreviewObject
	}
	if kind == "Ingress" && (len(object.Spec.Rules) != 1 || object.Spec.Rules[0].Host != runtime.ProbeHost || len(object.Spec.Rules[0].HTTP.Paths) != 1 || object.Spec.Rules[0].HTTP.Paths[0].Backend.Service.Name != runtime.ServiceName) {
		return store.PreviewOwnedObject{}, ErrPreviewObject
	}
	return store.PreviewOwnedObject{Group: group, Version: "v1", Kind: kind, Namespace: runtime.Namespace, Name: expectedName, UID: object.Metadata.UID, ResourceVersion: object.Metadata.ResourceVersion}, nil
}

func PreviewRouteManifest(work store.PreviewRouteWork, runtime store.PreviewRuntime, uid, resourceVersion string, port int, options ...DeploymentOptions) (map[string]any, error) {
	ingressClass, err := trustedIngressClassName(options)
	if err != nil {
		return nil, err
	}
	ingressErrors, err := trustedIngressErrorOptions(options)
	if err != nil {
		return nil, err
	}
	metadata := map[string]any{
		"name": work.RouteName, "namespace": work.Namespace,
		"labels": map[string]any{
			"app.kubernetes.io/name":                  work.RouteName,
			"app.kubernetes.io/managed-by":            "raibitserver",
			"raibitserver.io/managed":                 "true",
			"raibitserver.io/project-id":              work.ProjectID,
			"raibitserver.io/service-id":              work.ServiceID,
			"raibitserver.io/deployment-id":           runtime.DeploymentID,
			"raibitserver.io/preview-route":           "true",
			"raibitserver.io/preview-lineage-id":      work.Lease.LineageID,
			"raibitserver.io/preview-generation":      strconv.Itoa(runtime.Generation),
			"raibitserver.io/preview-backend-service": runtime.ServiceName,
		},
		"annotations": ingressAnnotations(work.StableHost, ingressErrors),
	}
	if uid != "" {
		metadata["uid"], metadata["resourceVersion"] = uid, resourceVersion
	}
	return map[string]any{"apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "metadata": metadata, "spec": map[string]any{"ingressClassName": ingressClass, "rules": []any{map[string]any{"host": work.StableHost, "http": map[string]any{"paths": []any{map[string]any{"path": "/", "pathType": "Prefix", "backend": map[string]any{"service": map[string]any{"name": runtime.ServiceName, "port": map[string]any{"number": port}}}}}}}}}}, nil
}

func ObservePreviewRoute(raw []byte, work store.PreviewRouteWork, runtime store.PreviewRuntime) (store.PreviewRouteObserved, error) {
	object, err := parsePreviewObject(raw)
	if err != nil {
		return store.PreviewRouteObserved{}, err
	}
	labels := object.Metadata.Labels
	if object.APIVersion != "networking.k8s.io/v1" || object.Kind != "Ingress" || object.Metadata.Namespace != work.Namespace || object.Metadata.Name != work.RouteName ||
		!validRouteIdentity(object, work) || labels["raibitserver.io/deployment-id"] != runtime.DeploymentID ||
		labels["raibitserver.io/preview-generation"] != strconv.Itoa(runtime.Generation) || labels["raibitserver.io/preview-backend-service"] != runtime.ServiceName ||
		len(object.Spec.Rules) != 1 || object.Spec.Rules[0].Host != work.StableHost || len(object.Spec.Rules[0].HTTP.Paths) != 1 ||
		object.Spec.Rules[0].HTTP.Paths[0].Backend.Service.Name != runtime.ServiceName {
		return store.PreviewRouteObserved{}, ErrPreviewObject
	}
	return store.PreviewRouteObserved{Version: 1, LineageVersion: work.Lease.Version, DeploymentID: runtime.DeploymentID, Generation: runtime.Generation, Namespace: work.Namespace, Name: work.RouteName, UID: object.Metadata.UID, ResourceVersion: object.Metadata.ResourceVersion}, nil
}

func ObserveRouteIdentity(raw []byte, work store.PreviewRouteWork) (string, string, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return "", "", nil
	}
	object, err := parsePreviewObject(raw)
	if err != nil {
		return "", "", err
	}
	if object.APIVersion != "networking.k8s.io/v1" || object.Kind != "Ingress" || object.Metadata.Namespace != work.Namespace || object.Metadata.Name != work.RouteName || !validRouteIdentity(object, work) {
		return "", "", ErrPreviewObject
	}
	labels := object.Metadata.Labels
	generation, err := strconv.Atoi(labels["raibitserver.io/preview-generation"])
	backend := labels["raibitserver.io/preview-backend-service"]
	if err != nil || generation < 1 || !dnsLabel.MatchString(backend) || len(object.Spec.Rules) != 1 || object.Spec.Rules[0].Host != work.StableHost ||
		len(object.Spec.Rules[0].HTTP.Paths) != 1 || object.Spec.Rules[0].HTTP.Paths[0].Backend.Service.Name != backend || labels["raibitserver.io/deployment-id"] == "" {
		return "", "", ErrPreviewObject
	}
	return object.Metadata.UID, object.Metadata.ResourceVersion, nil
}

var dnsLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func validRouteIdentity(object previewObjectJSON, work store.PreviewRouteWork) bool {
	labels := object.Metadata.Labels
	return labels["app.kubernetes.io/name"] == work.RouteName && labels["app.kubernetes.io/managed-by"] == "raibitserver" &&
		labels["raibitserver.io/managed"] == "true" && labels["raibitserver.io/project-id"] == work.ProjectID &&
		labels["raibitserver.io/service-id"] == work.ServiceID && labels["raibitserver.io/preview-route"] == "true" &&
		labels["raibitserver.io/preview-lineage-id"] == work.Lease.LineageID && object.Metadata.Annotations["raibitserver.io/hostname"] == work.StableHost
}

func parsePreviewObject(raw []byte) (previewObjectJSON, error) {
	if len(raw) == 0 || len(raw) > 128*1024 {
		return previewObjectJSON{}, ErrPreviewObject
	}
	var object previewObjectJSON
	if err := json.Unmarshal(raw, &object); err != nil {
		return previewObjectJSON{}, ErrPreviewObject
	}
	if object.Metadata.UID == "" || len(object.Metadata.UID) > 128 || object.Metadata.ResourceVersion == "" || len(object.Metadata.ResourceVersion) > math.MaxInt16 || object.Metadata.DeletionTimestamp != "" {
		return previewObjectJSON{}, ErrPreviewObject
	}
	return object, nil
}
