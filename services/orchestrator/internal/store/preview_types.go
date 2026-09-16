package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	PreviewStateOpen   = "OPEN"
	PreviewStateClosed = "CLOSED"
	PreviewPromote     = "promote"
	PreviewClear       = "clear"
)

type PreviewRouteStore interface {
	ClaimNextPreviewRoute(context.Context, ClaimOptions) (*PreviewRouteWork, error)
	RenewPreviewRouteLease(context.Context, PreviewRouteLease, time.Time) error
	SetPreviewRouteIntent(context.Context, PreviewRouteLease, PreviewRouteIntent) error
	CompletePreviewRoute(context.Context, PreviewRouteLease, PreviewRouteObserved) error
}

type PreviewRouteLease struct {
	LineageID string
	Version   int
	Token     string
	WorkerID  string
}

type PreviewRouteWork struct {
	Lease             PreviewRouteLease
	Operation         string
	OrganizationID    string
	ProjectID         string
	ServiceID         string
	State             string
	Namespace         string
	RouteName         string
	StableHost        string
	Candidate         *Deployment
	CurrentDeployment string
	CurrentGeneration int
}

type PreviewRouteIntent struct {
	Version         int    `json:"version"`
	LineageVersion  int    `json:"lineageVersion"`
	Operation       string `json:"operation"`
	DeploymentID    string `json:"deploymentId,omitempty"`
	Generation      int    `json:"generation,omitempty"`
	Token           string `json:"token"`
	Namespace       string `json:"namespace"`
	Name            string `json:"name"`
	UID             string `json:"uid,omitempty"`
	ResourceVersion string `json:"resourceVersion,omitempty"`
}

type PreviewRouteObserved struct {
	Version         int       `json:"version"`
	LineageVersion  int       `json:"lineageVersion"`
	DeploymentID    string    `json:"deploymentId,omitempty"`
	Generation      int       `json:"generation,omitempty"`
	Namespace       string    `json:"namespace"`
	Name            string    `json:"name"`
	UID             string    `json:"uid,omitempty"`
	ResourceVersion string    `json:"resourceVersion,omitempty"`
	ObservedAt      time.Time `json:"observedAt"`
}

func newPreviewToken() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("create preview reconcile token: %w", err)
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

const PreviewInventoryLimit = 32

var (
	ErrPreviewContract = errors.New("invalid preview lifecycle contract")
	dnsLabelPattern    = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	previewIDPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	resourceVersionRe  = regexp.MustCompile(`^[1-9][0-9]*$`)
)

type PreviewRuntime struct {
	Version          int    `json:"version"`
	LineageID        string `json:"lineageId"`
	DeploymentID     string `json:"deploymentId"`
	Generation       int    `json:"generation"`
	LineageVersion   int    `json:"lineageVersion"`
	StableHost       string `json:"stableHost"`
	ProbeHost        string `json:"probeHost"`
	Namespace        string `json:"namespace"`
	WorkloadName     string `json:"workloadName"`
	ServiceName      string `json:"serviceName"`
	ProbeIngressName string `json:"probeIngressName"`
	RouteName        string `json:"routeName"`
}

type PreviewOwnedObject struct {
	Group           string `json:"group"`
	Version         string `json:"version"`
	Kind            string `json:"kind"`
	Namespace       string `json:"namespace"`
	Name            string `json:"name"`
	UID             string `json:"uid"`
	ResourceVersion string `json:"resourceVersion,omitempty"`
}

func ParsePreviewRuntime(raw json.RawMessage, lineageID, deploymentID string, generation int) (PreviewRuntime, error) {
	var runtime PreviewRuntime
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if len(raw) == 0 || decoder.Decode(&runtime) != nil || runtime.Version != 1 || runtime.LineageID != lineageID ||
		runtime.DeploymentID != deploymentID || runtime.Generation != generation || runtime.LineageVersion < 1 ||
		!previewIDPattern.MatchString(runtime.LineageID) || !previewIDPattern.MatchString(runtime.DeploymentID) ||
		!validPreviewHost(runtime.StableHost) || !validPreviewHost(runtime.ProbeHost) || runtime.StableHost == runtime.ProbeHost ||
		!dnsLabelPattern.MatchString(runtime.Namespace) || !dnsLabelPattern.MatchString(runtime.WorkloadName) ||
		runtime.ServiceName != runtime.WorkloadName || runtime.ProbeIngressName != runtime.WorkloadName ||
		!dnsLabelPattern.MatchString(runtime.RouteName) {
		return PreviewRuntime{}, ErrPreviewContract
	}
	return runtime, nil
}

func ParsePreviewInventory(raw json.RawMessage) ([]PreviewOwnedObject, error) {
	var objects []PreviewOwnedObject
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if len(raw) == 0 || decoder.Decode(&objects) != nil || len(objects) > PreviewInventoryLimit {
		return nil, ErrPreviewContract
	}
	seen := make(map[string]struct{}, len(objects))
	for _, object := range objects {
		if !validPreviewOwnedObject(object) {
			return nil, ErrPreviewContract
		}
		key := object.Group + "/" + object.Version + "/" + object.Kind + "/" + object.Namespace + "/" + object.Name
		if _, exists := seen[key]; exists {
			return nil, ErrPreviewContract
		}
		seen[key] = struct{}{}
	}
	return objects, nil
}

func validPreviewOwnedObject(object PreviewOwnedObject) bool {
	if !dnsLabelPattern.MatchString(object.Namespace) || !dnsLabelPattern.MatchString(object.Name) ||
		!previewIDPattern.MatchString(object.UID) || (object.ResourceVersion != "" && (!resourceVersionRe.MatchString(object.ResourceVersion) || len(object.ResourceVersion) > 128)) {
		return false
	}
	switch {
	case object.Group == "apps" && object.Version == "v1" && object.Kind == "Deployment":
		return true
	case object.Group == "" && object.Version == "v1" && object.Kind == "Service":
		return true
	case object.Group == "networking.k8s.io" && object.Version == "v1" && object.Kind == "Ingress":
		return true
	default:
		return false
	}
}

func validPreviewHost(host string) bool {
	if len(host) > 253 || !strings.Contains(host, ".") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if !dnsLabelPattern.MatchString(label) {
			return false
		}
	}
	return true
}
