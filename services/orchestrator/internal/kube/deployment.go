package kube

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/raibitserver/orchestrator/internal/store"
)

const (
	ReadinessDeploymentRollout = "deployment-rollout"
	ReadinessJobCompletion     = "job-completion"
	ReadinessCronJobObserved   = "cronjob-observed"

	maxRuntimeArrayEntries         = 64
	maxRuntimeEntryBytes           = 4096
	maxRuntimeEnvironmentEntries   = 128
	maxCronScheduleBytes           = 128
	maxPreviewRouteIdentityLength  = 39
	tenantQuotaName                = "tenant-resource-budget"
	defaultIngressGatewayNamespace = "ingress-nginx"
	defaultIngressClassName        = "nginx"
	defaultIngressCustomHTTPErrors = "500,502,503,504"
)

type DeploymentOptions struct {
	IngressGatewayNamespace string
	IngressClassName        string
	IngressCustomHTTPErrors string
	IngressErrorMiddleware  string
}

type ingressErrorOptions struct {
	customHTTPErrors string
	middleware       string
	disabled         bool
}

type AppServiceSpec struct {
	HealthCheckPath    string            `json:"healthCheckPath,omitempty"`
	LivenessPath       string            `json:"livenessPath,omitempty"`
	ReadinessPath      string            `json:"readinessPath,omitempty"`
	PublicHealthPath   string            `json:"publicHealthPath,omitempty"`
	Name               string            `json:"name"`
	Namespace          string            `json:"namespace"`
	Image              string            `json:"image"`
	Port               int               `json:"port"`
	Replicas           int               `json:"replicas"`
	Host               string            `json:"host,omitempty"`
	Env                map[string]string `json:"env,omitempty"`
	SecretEnv          []map[string]any  `json:"secretEnv,omitempty"`
	ProjectID          string            `json:"projectId"`
	ServiceID          string            `json:"serviceId"`
	ProjectSlug        string            `json:"projectSlug"`
	OrganizationSlug   string            `json:"organizationSlug"`
	ServiceType        string            `json:"serviceType"`
	DeploymentID       string            `json:"deploymentId"`
	Command            []string          `json:"command,omitempty"`
	Args               []string          `json:"args,omitempty"`
	Schedule           string            `json:"schedule,omitempty"`
	Preview            bool              `json:"preview"`
	PullRequestNumber  int               `json:"pullRequestNumber,omitempty"`
	BaseServiceName    string            `json:"baseServiceName,omitempty"`
	PublicEgress       bool              `json:"publicEgress,omitempty"`
	AllowTenantIngress bool              `json:"allowTenantIngress,omitempty"`
	PreviewLineageID   string            `json:"previewLineageId,omitempty"`
	PreviewGeneration  int               `json:"previewGeneration,omitempty"`
	InvalidReason      string            `json:"-"`
}

type DeploymentPlan struct {
	Kind              string           `json:"kind"`
	WorkloadName      string           `json:"workloadName"`
	ReadinessStrategy string           `json:"readinessStrategy"`
	Service           AppServiceSpec   `json:"service"`
	Safe              bool             `json:"safe"`
	Error             string           `json:"error,omitempty"`
	Reconcile         string           `json:"reconcile"`
	Manifests         []map[string]any `json:"manifests"`
}

type workloadDescriptor struct {
	serviceType string
	kind        string
	readiness   string
	name        string
}

func NewDeploymentPlan(spec AppServiceSpec, options ...DeploymentOptions) DeploymentPlan {
	if spec.Replicas <= 0 {
		spec.Replicas = 1
	}
	if spec.Port <= 0 {
		spec.Port = 3000
	}
	if strings.TrimSpace(spec.ServiceType) == "" {
		spec.ServiceType = "web"
	}
	spec.Name = boundedDNSName(spec.Name, firstNonEmpty(spec.ServiceID, spec.Name), 63)
	spec.Namespace = boundedDNSName(spec.Namespace, firstNonEmpty(spec.ProjectID, spec.Namespace), 63)
	ingressGatewayNamespace, err := trustedIngressGatewayNamespace(options)
	if err != nil {
		return unsafeDeploymentPlan(spec, err)
	}
	ingressClassName, err := trustedIngressClassName(options)
	if err != nil {
		return unsafeDeploymentPlan(spec, err)
	}
	ingressErrors, err := trustedIngressErrorOptions(options)
	if err != nil {
		return unsafeDeploymentPlan(spec, err)
	}
	descriptor, err := describeWorkload(spec)
	if err != nil {
		return unsafeDeploymentPlan(spec, err)
	}
	spec.ServiceType = descriptor.serviceType
	manifests := compileServiceManifests(spec, descriptor, ingressGatewayNamespace, ingressClassName, ingressErrors)
	if spec.PreviewLineageID != "" {
		manifests = previewCandidateManifests(manifests)
	}
	return DeploymentPlan{
		Kind:              descriptor.kind,
		WorkloadName:      descriptor.name,
		ReadinessStrategy: descriptor.readiness,
		Service:           spec,
		Safe:              true,
		Reconcile:         "apply-" + descriptor.readiness + "-sync",
		Manifests:         manifests,
	}
}

func previewCandidateManifests(manifests []map[string]any) []map[string]any {
	owned := make([]map[string]any, 0, 3)
	for _, manifest := range manifests {
		switch manifest["kind"] {
		case "Deployment", "Service", "Ingress":
			owned = append(owned, manifest)
		}
	}
	return owned
}

func unsafeDeploymentPlan(spec AppServiceSpec, err error) DeploymentPlan {
	return DeploymentPlan{Service: spec, Safe: false, Error: err.Error(), Reconcile: "rejected", Manifests: []map[string]any{}}
}

func describeWorkload(spec AppServiceSpec) (workloadDescriptor, error) {
	if err := validateHealthPaths(spec); err != nil {
		return workloadDescriptor{}, err
	}
	if spec.InvalidReason != "" {
		return workloadDescriptor{}, fmt.Errorf("invalid service runtime configuration: %s", spec.InvalidReason)
	}
	serviceType := strings.ToLower(strings.TrimSpace(spec.ServiceType))
	descriptor := workloadDescriptor{serviceType: serviceType, name: spec.Name}
	switch serviceType {
	case "web", "private", "worker":
		descriptor.kind = "Deployment"
		descriptor.readiness = ReadinessDeploymentRollout
	case "cron":
		descriptor.kind = "CronJob"
		descriptor.readiness = ReadinessCronJobObserved
		descriptor.name = boundedDNSName(spec.Name, firstNonEmpty(spec.ServiceID, spec.Name)+"\x00"+spec.Name, 52)
		if spec.Schedule == "" {
			spec.Schedule = "0 * * * *"
		}
		if err := validateCronSchedule(spec.Schedule); err != nil {
			return workloadDescriptor{}, err
		}
	case "job", "one-off", "one_off":
		if strings.TrimSpace(spec.DeploymentID) == "" {
			return workloadDescriptor{}, fmt.Errorf("job workload requires a deployment ID")
		}
		descriptor.serviceType = "job"
		descriptor.kind = "Job"
		descriptor.readiness = ReadinessJobCompletion
		descriptor.name = jobWorkloadName(spec.Name, spec.DeploymentID)
	default:
		return workloadDescriptor{}, fmt.Errorf("unsupported service type %q", spec.ServiceType)
	}
	return descriptor, nil
}

func SpecFromState(project *store.Project, service *store.Service, deployment *store.Deployment, baseDomain string) AppServiceSpec {
	runtimeService, snapshotErr := deployment.RuntimeService(service)
	if snapshotErr != nil {
		return AppServiceSpec{ProjectID: project.ID, ServiceID: service.ID, DeploymentID: deployment.ID, InvalidReason: snapshotErr.Error()}
	}
	projectSlug := boundedDNSName(firstNonEmpty(project.Slug, project.Name, project.ID, "project"), project.ID, 63)
	organizationSlug := boundedDNSName(firstNonEmpty(project.OrganizationSlug, project.OrganizationID, "org"), firstNonEmpty(project.OrganizationID, project.OrganizationSlug), 63)
	serviceName := boundedDNSName(firstNonEmpty(service.Slug, service.Name, service.ID, "service"), service.ID, 63)
	baseServiceName := serviceName
	domain := rootBaseDomain(firstNonEmpty(baseDomain, service.BaseDomain, "raibitserver.local"))
	organizationNamespaceID := normalizeDNSName(firstNonEmpty(project.OrganizationID, project.OrganizationSlug, "org"))
	projectNamespaceSlug := normalizeDNSName(firstNonEmpty(project.Slug, project.Name, project.ID, "project"))
	tenantIdentity := organizationNamespaceID + "--" + projectNamespaceSlug
	tenantLabel := boundedDNSName(tenantIdentity, project.OrganizationID+"\x00"+project.ID, 63)
	organizationRouteSlug := normalizeDNSName(firstNonEmpty(project.OrganizationSlug, project.OrganizationID, "org"))
	projectRouteSlug := normalizeDNSName(firstNonEmpty(project.Slug, project.Name, project.ID, "project"))
	serviceRouteName := normalizeDNSName(firstNonEmpty(service.Slug, service.Name, service.ID, "service"))
	serviceRouteIdentity := organizationRouteSlug + "--" + projectRouteSlug
	if serviceRouteName != "web" {
		serviceRouteIdentity += "--" + serviceRouteName
	}
	// Keep every generated tenant route directly under the base domain so one
	// wildcard certificate (*.example.com) covers production and preview apps.
	serviceRouteLabel := boundedDNSName("apps--"+serviceRouteIdentity, "apps--"+serviceRouteIdentity, 63)
	host := serviceRouteLabel + "." + domain
	preview := false
	var previewRuntime store.PreviewRuntime
	if deployment.DeploymentType == "preview" && deployment.PullRequestNumber > 0 {
		preview = true
		previewKey := "pr-" + strconv.Itoa(deployment.PullRequestNumber)
		previewRouteLabel := boundedDNSName(serviceRouteIdentity, serviceRouteIdentity, maxPreviewRouteIdentityLength)
		previewLabel := "preview--" + previewKey + "--" + previewRouteLabel
		host = previewLabel + "." + domain
		serviceName = previewKey + "-" + baseServiceName
		serviceName = identityDNSName(serviceName, deployment.ID, 63)
	}
	if deployment.PreviewLineageID != "" {
		var runtimeErr error
		previewRuntime, runtimeErr = store.ParsePreviewRuntime(deployment.PreviewRuntimeJSON, deployment.PreviewLineageID, deployment.ID, deployment.PreviewGeneration)
		if runtimeErr != nil {
			return AppServiceSpec{ProjectID: project.ID, ServiceID: service.ID, DeploymentID: deployment.ID, InvalidReason: runtimeErr.Error()}
		}
		preview = true
		host = previewRuntime.ProbeHost
		serviceName = previewRuntime.WorkloadName
		tenantLabel = previewRuntime.Namespace
	}
	image, err := ResolveImageReference(firstNonEmpty(deployment.ImageURL, service.ImageURL), deployment.ImageDigest, true)
	if err != nil {
		image = firstNonEmpty(deployment.ImageURL, service.ImageURL)
	}
	command, commandErr := runtimeStringArray(runtimeService, "command")
	args, argsErr := runtimeStringArray(runtimeService, "args")
	schedule, scheduleErr := runtimeSchedule(runtimeService)
	environment, environmentErr := runtimeEnvironment(runtimeService, deployment)
	secretEnv, secretEnvErr := runtimeSecretEnv(runtimeService)
	environmentConflictErr := runtimeEnvironmentConflict(environment, secretEnv)
	paths, healthErr := healthPathsFromService(runtimeService)
	invalidReason := firstError(commandErr, argsErr, scheduleErr, environmentErr, secretEnvErr, environmentConflictErr, healthErr)
	return AppServiceSpec{
		HealthCheckPath: paths[0], LivenessPath: paths[1], ReadinessPath: paths[2], PublicHealthPath: paths[3],
		Name: serviceName, Namespace: tenantLabel, Image: image, Port: runtimeService.Port, Replicas: runtimeService.Replicas, Host: host,
		ProjectID: project.ID, ServiceID: service.ID, ProjectSlug: projectSlug, OrganizationSlug: organizationSlug,
		ServiceType: firstNonEmpty(runtimeService.Type, "web"), DeploymentID: deployment.ID, Command: command, Args: args, Schedule: schedule, Env: environment, SecretEnv: secretEnv,
		Preview: preview, PullRequestNumber: deployment.PullRequestNumber, BaseServiceName: baseServiceName,
		PreviewLineageID: deployment.PreviewLineageID, PreviewGeneration: deployment.PreviewGeneration,
		PublicEgress: servicePublicEgress(runtimeService), AllowTenantIngress: serviceTenantIngress(runtimeService), InvalidReason: invalidReason,
	}
}

func rootBaseDomain(domain string) string {
	domain = strings.TrimSpace(domain)
	domain = strings.TrimPrefix(domain, "apps.")
	domain = strings.TrimPrefix(domain, "preview.")
	return domain
}

func ResolveImageReference(image, digest string, allowMutable bool) (string, error) {
	image = strings.TrimSpace(image)
	digest = strings.TrimSpace(digest)
	if image == "" {
		return "", fmt.Errorf("image reference is required")
	}
	if strings.Contains(image, "@") {
		parts := strings.SplitN(image, "@", 2)
		if !sha256DigestPattern.MatchString(parts[1]) {
			return "", fmt.Errorf("image reference contains an invalid sha256 digest")
		}
		if digest != "" && !sha256DigestPattern.MatchString(digest) {
			return "", fmt.Errorf("image digest field contains an invalid sha256 digest")
		}
		if digest != "" && digest != parts[1] {
			return "", fmt.Errorf("image digest conflict between image reference and deployment record")
		}
		return parts[0] + "@" + parts[1], nil
	}
	if !sha256DigestPattern.MatchString(digest) {
		if allowMutable {
			return image, nil
		}
		return "", fmt.Errorf("live deployment requires a valid sha256 image digest")
	}
	lastSlash := strings.LastIndex(image, "/")
	if colon := strings.LastIndex(image, ":"); colon > lastSlash {
		image = image[:colon]
	}
	return image + "@" + digest, nil
}

func CompileServiceManifests(spec AppServiceSpec, options ...DeploymentOptions) []map[string]any {
	return NewDeploymentPlan(spec, options...).Manifests
}

func compileServiceManifests(spec AppServiceSpec, descriptor workloadDescriptor, ingressGatewayNamespace, ingressClassName string, ingressErrors ingressErrorOptions) []map[string]any {
	if descriptor.serviceType == "cron" && spec.Schedule == "" {
		spec.Schedule = "0 * * * *"
	}
	labels := workloadLabels(spec)
	items := []map[string]any{
		namespaceManifest(spec),
		resourceQuotaManifest(spec),
	}
	switch descriptor.kind {
	case "Deployment":
		items = append(items, deploymentManifest(spec, descriptor.name, labels))
	case "CronJob":
		items = append(items, cronJobManifest(spec, descriptor.name, labels))
	case "Job":
		items = append(items, jobManifest(spec, descriptor.name, labels))
	}
	if descriptor.serviceType == "web" || descriptor.serviceType == "private" {
		items = append(items, serviceManifest(spec, labels))
	}
	items = append(items, networkPolicyManifest(spec, labels, ingressGatewayNamespace))
	if descriptor.serviceType == "web" && spec.Host != "" {
		items = append(items, ingressManifest(spec, labels, ingressClassName, ingressErrors))
	}
	if spec.PublicEgress {
		items = append(items, servicePublicEgressPolicy(spec, labels))
	}
	return items
}

func List(manifests []map[string]any) map[string]any {
	return map[string]any{"apiVersion": "v1", "kind": "List", "items": manifests}
}

func ListJSON(manifests []map[string]any) ([]byte, error) {
	return json.MarshalIndent(List(manifests), "", "  ")
}

// CleanupManifests returns only exact namespaced objects owned by this
// deployment. Shared project-scoped objects such as Namespace and
// ResourceQuota are never part of a service or preview cleanup operation.
func CleanupManifests(plan DeploymentPlan) []map[string]any {
	items := make([]map[string]any, 0, len(plan.Manifests))
	for _, manifest := range plan.Manifests {
		if manifest["kind"] == "Namespace" || manifest["kind"] == "ResourceQuota" {
			continue
		}
		metadata, ok := manifest["metadata"].(map[string]any)
		if !ok || metadata["namespace"] != plan.Service.Namespace {
			continue
		}
		labels, ok := metadata["labels"].(map[string]any)
		if !ok || labels["raibitserver.io/deployment-id"] != plan.Service.DeploymentID {
			continue
		}
		items = append(items, manifest)
	}
	return items
}

func workloadLabels(spec AppServiceSpec) map[string]any {
	labels := map[string]any{
		"app.kubernetes.io/name":        spec.Name,
		"app.kubernetes.io/managed-by":  "raibitserver",
		"raibitserver.io/managed":       "true",
		"raibitserver.io/project":       spec.ProjectSlug,
		"raibitserver.io/service":       spec.Name,
		"raibitserver.io/deployment":    spec.DeploymentID,
		"raibitserver.io/project-id":    spec.ProjectID,
		"raibitserver.io/service-id":    spec.ServiceID,
		"raibitserver.io/deployment-id": spec.DeploymentID,
	}
	if spec.Preview {
		labels["raibitserver.io/preview"] = "true"
		labels["raibitserver.io/pull-request"] = strconv.Itoa(spec.PullRequestNumber)
		labels["raibitserver.io/base-service"] = spec.BaseServiceName
		if spec.PreviewLineageID != "" {
			labels["raibitserver.io/preview-lineage-id"] = spec.PreviewLineageID
			labels["raibitserver.io/preview-generation"] = strconv.Itoa(spec.PreviewGeneration)
		}
	}
	return labels
}

func namespaceManifest(spec AppServiceSpec) map[string]any {
	return map[string]any{
		"apiVersion": "v1",
		"kind":       "Namespace",
		"metadata": map[string]any{
			"name": spec.Namespace,
			"labels": map[string]any{
				"app.kubernetes.io/managed-by":       "raibitserver",
				"raibitserver.io/managed":            "true",
				"raibitserver.io/namespace-kind":     "application",
				"raibitserver.io/project":            spec.ProjectSlug,
				"raibitserver.io/project-id":         spec.ProjectID,
				"pod-security.kubernetes.io/enforce": "restricted",
				"pod-security.kubernetes.io/audit":   "restricted",
				"pod-security.kubernetes.io/warn":    "restricted",
			},
		},
	}
}

func resourceQuotaManifest(spec AppServiceSpec) map[string]any {
	return map[string]any{
		"apiVersion": "v1",
		"kind":       "ResourceQuota",
		"metadata": map[string]any{
			"name":      tenantQuotaName,
			"namespace": spec.Namespace,
			"labels": map[string]any{
				"app.kubernetes.io/managed-by":   "raibitserver",
				"raibitserver.io/managed":        "true",
				"raibitserver.io/namespace-kind": "application",
				"raibitserver.io/project":        spec.ProjectSlug,
				"raibitserver.io/project-id":     spec.ProjectID,
				"raibitserver.io/resource-kind":  "tenant-resource-quota",
			},
		},
		"spec": map[string]any{
			"hard": map[string]any{
				"resourcequotas":                    "1",
				"pods":                              "100",
				"count/pods":                        "200",
				"count/deployments.apps":            "50",
				"count/replicasets.apps":            "200",
				"count/statefulsets.apps":           "50",
				"count/jobs.batch":                  "100",
				"count/cronjobs.batch":              "50",
				"services":                          "100",
				"persistentvolumeclaims":            "50",
				"secrets":                           "200",
				"configmaps":                        "100",
				"count/ingresses.networking.k8s.io": "100",
				"count/networkpolicies.networking.k8s.io": "200",
				"requests.cpu":               "50",
				"requests.memory":            "100Gi",
				"requests.ephemeral-storage": "100Gi",
				"limits.cpu":                 "100",
				"limits.memory":              "200Gi",
				"limits.ephemeral-storage":   "200Gi",
				"requests.storage":           "1Ti",
			},
		},
	}
}

func deploymentManifest(spec AppServiceSpec, workloadName string, labels map[string]any) map[string]any {
	return map[string]any{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]any{"name": workloadName, "namespace": spec.Namespace, "labels": labels},
		"spec": map[string]any{
			"replicas": spec.Replicas,
			"selector": map[string]any{"matchLabels": map[string]any{"app.kubernetes.io/name": spec.Name}},
			"strategy": map[string]any{"type": "RollingUpdate", "rollingUpdate": map[string]any{"maxUnavailable": 0, "maxSurge": 1}},
			"template": podTemplate(spec, labels, ""),
		},
	}
}

func cronJobManifest(spec AppServiceSpec, workloadName string, labels map[string]any) map[string]any {
	return map[string]any{
		"apiVersion": "batch/v1", "kind": "CronJob",
		"metadata": map[string]any{"name": workloadName, "namespace": spec.Namespace, "labels": labels},
		"spec": map[string]any{
			"schedule":                   spec.Schedule,
			"concurrencyPolicy":          "Forbid",
			"successfulJobsHistoryLimit": 1,
			"failedJobsHistoryLimit":     1,
			"jobTemplate": map[string]any{
				"spec": map[string]any{"backoffLimit": 1, "template": podTemplate(spec, labels, "OnFailure")},
			},
		},
	}
}

func jobManifest(spec AppServiceSpec, workloadName string, labels map[string]any) map[string]any {
	return map[string]any{
		"apiVersion": "batch/v1", "kind": "Job",
		"metadata": map[string]any{"name": workloadName, "namespace": spec.Namespace, "labels": labels},
		"spec":     map[string]any{"backoffLimit": 1, "template": podTemplate(spec, labels, "Never")},
	}
}

func podTemplate(spec AppServiceSpec, labels map[string]any, restartPolicy string) map[string]any {
	podSpec := map[string]any{
		"securityContext":              map[string]any{"runAsNonRoot": true, "seccompProfile": map[string]any{"type": "RuntimeDefault"}},
		"automountServiceAccountToken": false,
		"containers":                   []any{runtimeContainer(spec)},
		"volumes":                      []any{map[string]any{"name": "tmp", "emptyDir": map[string]any{"sizeLimit": "128Mi"}}},
	}
	if restartPolicy != "" {
		podSpec["restartPolicy"] = restartPolicy
	}
	return map[string]any{
		"metadata": map[string]any{
			"labels":      labels,
			"annotations": map[string]any{"raibitserver.io/verify-image-signatures": "required"},
		},
		"spec": podSpec,
	}
}

func serviceManifest(spec AppServiceSpec, labels map[string]any) map[string]any {
	return map[string]any{"apiVersion": "v1", "kind": "Service", "metadata": map[string]any{"name": spec.Name, "namespace": spec.Namespace, "labels": labels}, "spec": map[string]any{"type": "ClusterIP", "selector": map[string]any{"app.kubernetes.io/name": spec.Name}, "ports": []any{map[string]any{"name": "http", "port": spec.Port, "targetPort": "http"}}}}
}

func ingressManifest(spec AppServiceSpec, labels map[string]any, ingressClassName string, ingressErrors ingressErrorOptions) map[string]any {
	return map[string]any{"apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "metadata": map[string]any{"name": spec.Name, "namespace": spec.Namespace, "labels": labels, "annotations": ingressAnnotations(spec.Host, ingressErrors)}, "spec": map[string]any{"ingressClassName": ingressClassName, "rules": []any{map[string]any{"host": spec.Host, "http": map[string]any{"paths": []any{map[string]any{"path": "/", "pathType": "Prefix", "backend": map[string]any{"service": map[string]any{"name": spec.Name, "port": map[string]any{"number": spec.Port}}}}}}}}}}
}

func ingressAnnotations(host string, ingressErrors ingressErrorOptions) map[string]any {
	annotations := map[string]any{"raibitserver.io/hostname": host}
	if !ingressErrors.disabled {
		annotations["nginx.ingress.kubernetes.io/custom-http-errors"] = ingressErrors.customHTTPErrors
	}
	if !ingressErrors.disabled && ingressErrors.middleware != "" {
		annotations["traefik.ingress.kubernetes.io/router.middlewares"] = ingressErrors.middleware
	}
	return annotations
}

func networkPolicyManifest(spec AppServiceSpec, labels map[string]any, ingressGatewayNamespace string) map[string]any {
	namespaceSelector := map[string]any{"matchLabels": map[string]any{"kubernetes.io/metadata.name": spec.Namespace}}
	ingressControllerSelector := map[string]any{"matchLabels": map[string]any{"kubernetes.io/metadata.name": ingressGatewayNamespace}}
	dnsNamespaceSelector := map[string]any{"matchLabels": map[string]any{"kubernetes.io/metadata.name": "kube-system"}}
	dnsPodSelector := map[string]any{"matchLabels": map[string]any{"k8s-app": "kube-dns"}}
	ingress := []any{}
	port := []any{map[string]any{"protocol": "TCP", "port": spec.Port}}
	switch spec.ServiceType {
	case "web":
		ingress = append(ingress, map[string]any{
			"from":  []any{map[string]any{"namespaceSelector": ingressControllerSelector}},
			"ports": port,
		})
	case "private":
		ingress = append(ingress, map[string]any{
			"from":  []any{map[string]any{"namespaceSelector": namespaceSelector}},
			"ports": port,
		})
	}
	if spec.AllowTenantIngress && spec.ServiceType != "private" {
		ingress = append(ingress, map[string]any{
			"from":  []any{map[string]any{"namespaceSelector": namespaceSelector}},
			"ports": port,
		})
	}
	return map[string]any{
		"apiVersion": "networking.k8s.io/v1",
		"kind":       "NetworkPolicy",
		"metadata":   map[string]any{"name": boundedDNSName(spec.Name+"-default", spec.ServiceID+"\x00"+spec.Name+"\x00default-policy", 63), "namespace": spec.Namespace, "labels": labels},
		"spec": map[string]any{
			"podSelector": map[string]any{"matchLabels": map[string]any{"app.kubernetes.io/name": spec.Name}},
			"policyTypes": []any{"Ingress", "Egress"},
			"ingress":     ingress,
			"egress": []any{
				map[string]any{"to": []any{map[string]any{"namespaceSelector": namespaceSelector}}},
				map[string]any{
					"to":    []any{map[string]any{"namespaceSelector": dnsNamespaceSelector, "podSelector": dnsPodSelector}},
					"ports": []any{map[string]any{"protocol": "UDP", "port": 53}, map[string]any{"protocol": "TCP", "port": 53}},
				},
			},
		},
	}
}

func trustedIngressGatewayNamespace(options []DeploymentOptions) (string, error) {
	namespace := defaultIngressGatewayNamespace
	if len(options) > 0 && strings.TrimSpace(options[0].IngressGatewayNamespace) != "" {
		namespace = strings.TrimSpace(options[0].IngressGatewayNamespace)
	}
	if len(namespace) > 63 || !dnsLabelValidationPattern.MatchString(namespace) {
		return "", fmt.Errorf("invalid ingress gateway namespace: expected a Kubernetes DNS label")
	}
	return namespace, nil
}

func trustedIngressClassName(options []DeploymentOptions) (string, error) {
	className := defaultIngressClassName
	if len(options) > 0 && strings.TrimSpace(options[0].IngressClassName) != "" {
		className = strings.TrimSpace(options[0].IngressClassName)
	}
	if len(className) > 253 || !dnsSubdomainValidationPattern.MatchString(className) {
		return "", fmt.Errorf("invalid ingress class name: expected a Kubernetes DNS subdomain")
	}
	return className, nil
}

func trustedIngressErrorOptions(options []DeploymentOptions) (ingressErrorOptions, error) {
	rawStatuses := defaultIngressCustomHTTPErrors
	middleware := ""
	if len(options) > 0 {
		if strings.TrimSpace(options[0].IngressCustomHTTPErrors) != "" {
			rawStatuses = options[0].IngressCustomHTTPErrors
		}
		middleware = strings.ToLower(strings.TrimSpace(options[0].IngressErrorMiddleware))
	}
	if strings.EqualFold(strings.TrimSpace(rawStatuses), "disabled") {
		return ingressErrorOptions{disabled: true}, nil
	}
	statusSet := map[int]struct{}{}
	for _, rawStatus := range strings.Split(rawStatuses, ",") {
		status, err := strconv.Atoi(strings.TrimSpace(rawStatus))
		if err != nil || status < 400 || status > 599 {
			return ingressErrorOptions{}, fmt.Errorf("invalid ingress custom HTTP errors: expected comma-separated HTTP status codes from 400 through 599")
		}
		statusSet[status] = struct{}{}
	}
	statuses := make([]int, 0, len(statusSet))
	for status := range statusSet {
		statuses = append(statuses, status)
	}
	sort.Ints(statuses)
	normalizedStatuses := make([]string, len(statuses))
	for index, status := range statuses {
		normalizedStatuses[index] = strconv.Itoa(status)
	}
	if middleware != "" && !traefikMiddlewareValidationPattern.MatchString(middleware) {
		return ingressErrorOptions{}, fmt.Errorf("invalid ingress error middleware: expected <namespace>-<name>@kubernetescrd")
	}
	return ingressErrorOptions{customHTTPErrors: strings.Join(normalizedStatuses, ","), middleware: middleware}, nil
}

func servicePublicEgressPolicy(spec AppServiceSpec, labels map[string]any) map[string]any {
	return map[string]any{
		"apiVersion": "networking.k8s.io/v1",
		"kind":       "NetworkPolicy",
		"metadata":   map[string]any{"name": boundedDNSName(spec.Name+"-public-egress", spec.ServiceID+"\x00"+spec.Name+"\x00public-egress", 63), "namespace": spec.Namespace, "labels": labels},
		"spec": map[string]any{
			"podSelector": map[string]any{"matchLabels": map[string]any{"app.kubernetes.io/name": spec.Name}},
			"policyTypes": []any{"Egress"},
			"egress": []any{
				map[string]any{"to": []any{map[string]any{"ipBlock": map[string]any{"cidr": "0.0.0.0/0", "except": privateIPv4EgressExceptions}}}},
				map[string]any{"to": []any{map[string]any{"ipBlock": map[string]any{"cidr": "::/0", "except": privateIPv6EgressExceptions}}}},
			},
		},
	}
}

func runtimeStringArray(service *store.Service, key string) ([]string, error) {
	value, found := desiredValue(service, key)
	if !found {
		return nil, nil
	}
	values := []any{}
	switch typed := value.(type) {
	case []any:
		values = typed
	case []string:
		values = make([]any, len(typed))
		for index, entry := range typed {
			values[index] = entry
		}
	default:
		return nil, fmt.Errorf("%s must be an array of strings", key)
	}
	if len(values) == 0 || len(values) > maxRuntimeArrayEntries {
		return nil, fmt.Errorf("%s must contain between 1 and %d entries", key, maxRuntimeArrayEntries)
	}
	result := make([]string, len(values))
	for index, value := range values {
		entry, ok := value.(string)
		if !ok || strings.TrimSpace(entry) == "" {
			return nil, fmt.Errorf("%s[%d] must be a non-empty string", key, index)
		}
		if len([]byte(entry)) > maxRuntimeEntryBytes || containsControl(entry) {
			return nil, fmt.Errorf("%s[%d] exceeds runtime argument safety limits", key, index)
		}
		result[index] = entry
	}
	return result, nil
}

func runtimeSchedule(service *store.Service) (string, error) {
	value, found := desiredValue(service, "schedule")
	if !found {
		return "0 * * * *", nil
	}
	schedule, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("schedule must be a string")
	}
	if err := validateCronSchedule(schedule); err != nil {
		return "", err
	}
	return strings.TrimSpace(schedule), nil
}

func runtimeSecretEnv(service *store.Service) ([]map[string]any, error) {
	value, found := desiredValue(service, "secretEnv")
	if !found {
		return nil, nil
	}
	values, ok := value.([]any)
	if !ok || len(values) == 0 || len(values) > maxRuntimeEnvironmentEntries {
		return nil, fmt.Errorf("secretEnv must contain between 1 and %d Kubernetes Secret references", maxRuntimeEnvironmentEntries)
	}
	result := make([]map[string]any, 0, len(values))
	seen := map[string]bool{}
	for index, raw := range values {
		entry, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("secretEnv[%d] must be an object", index)
		}
		name, _ := entry["name"].(string)
		valueFrom, _ := entry["valueFrom"].(map[string]any)
		secretKeyRef, _ := valueFrom["secretKeyRef"].(map[string]any)
		secretName, _ := secretKeyRef["name"].(string)
		key, _ := secretKeyRef["key"].(string)
		if !environmentNamePattern.MatchString(name) || seen[name] {
			return nil, fmt.Errorf("secretEnv[%d] has an invalid or duplicate environment name", index)
		}
		if !dnsLabelValidationPattern.MatchString(secretName) || len(secretName) > 63 || !environmentNamePattern.MatchString(key) {
			return nil, fmt.Errorf("secretEnv[%d] has an invalid Kubernetes Secret reference", index)
		}
		seen[name] = true
		result = append(result, map[string]any{"name": name, "valueFrom": map[string]any{"secretKeyRef": map[string]any{"name": secretName, "key": key}}})
	}
	return result, nil
}

func runtimeEnvironment(service *store.Service, deployment *store.Deployment) (map[string]string, error) {
	result := map[string]string{}
	if value, found := desiredValue(service, "env"); found {
		switch entries := value.(type) {
		case map[string]any:
			for name, raw := range entries {
				text, ok := raw.(string)
				if !ok {
					return nil, fmt.Errorf("env[%s] must be a string", name)
				}
				result[name] = text
			}
		case map[string]string:
			for name, text := range entries {
				result[name] = text
			}
		default:
			return nil, fmt.Errorf("env must be an object")
		}
	}

	// These values describe the exact release selected by the control plane.
	// They intentionally override tenant-supplied values so applications can
	// rely on them as authoritative deployment evidence.
	result["RAIBITSERVER_DEPLOYMENT_ID"] = deployment.ID
	result["RAIBITSERVER_SERVICE_ID"] = deployment.ServiceID
	result["RAIBITSERVER_PROJECT_ID"] = deployment.ProjectID
	result["RAIBITSERVER_DEPLOYMENT_TYPE"] = firstNonEmpty(deployment.DeploymentType, "production")
	if commitSHA := strings.TrimSpace(deployment.CommitSHA); commitSHA != "" {
		result["RAIBITSERVER_GIT_SHA"] = commitSHA
	}

	if len(result) > maxRuntimeEnvironmentEntries {
		return nil, fmt.Errorf("env must contain at most %d values", maxRuntimeEnvironmentEntries)
	}
	for name, value := range result {
		if !environmentNamePattern.MatchString(name) {
			return nil, fmt.Errorf("env contains an invalid environment name %q", name)
		}
		if len([]byte(value)) > maxRuntimeEntryBytes || containsControl(value) {
			return nil, fmt.Errorf("env[%s] contains an invalid value", name)
		}
	}
	return result, nil
}

func runtimeEnvironmentConflict(environment map[string]string, secretEnv []map[string]any) error {
	if len(environment)+len(secretEnv) > maxRuntimeEnvironmentEntries {
		return fmt.Errorf("environment must contain at most %d plain values and Secret references in total", maxRuntimeEnvironmentEntries)
	}
	for _, entry := range secretEnv {
		name, _ := entry["name"].(string)
		if _, exists := environment[name]; exists {
			return fmt.Errorf("environment name %s is configured as both a plain value and a Secret reference", name)
		}
	}
	return nil
}

func desiredValue(service *store.Service, key string) (any, bool) {
	if service != nil && service.DesiredSpec != nil {
		if value, found := service.DesiredSpec[key]; found {
			return value, true
		}
	}
	if service != nil && service.DesiredState != nil {
		if value, found := service.DesiredState[key]; found {
			return value, true
		}
	}
	return nil, false
}

func validateCronSchedule(schedule string) error {
	if schedule == "" || len([]byte(schedule)) > maxCronScheduleBytes || containsControl(schedule) {
		return fmt.Errorf("invalid cron schedule")
	}
	fields := strings.Fields(schedule)
	if len(fields) != 5 {
		return fmt.Errorf("invalid cron schedule: expected five fields")
	}
	for index, field := range fields {
		if err := validateCronField(field, cronFieldRules[index]); err != nil {
			return fmt.Errorf("invalid cron schedule field %q: %w", field, err)
		}
	}
	return nil
}

type cronFieldRule struct {
	min   int
	max   int
	names map[string]int
}

func validateCronField(field string, rule cronFieldRule) error {
	if !cronFieldPattern.MatchString(field) {
		return fmt.Errorf("unsupported characters")
	}
	for _, segment := range strings.Split(field, ",") {
		stepParts := strings.Split(segment, "/")
		if len(stepParts) > 2 || stepParts[0] == "" {
			return fmt.Errorf("invalid step expression")
		}
		if len(stepParts) == 2 {
			step, err := strconv.Atoi(stepParts[1])
			if err != nil || step <= 0 {
				return fmt.Errorf("step must be a positive integer")
			}
		}
		base := stepParts[0]
		if base == "*" || base == "?" {
			continue
		}
		rangeParts := strings.Split(base, "-")
		if len(rangeParts) > 2 {
			return fmt.Errorf("invalid range")
		}
		start, err := parseCronValue(rangeParts[0], rule)
		if err != nil {
			return err
		}
		if len(rangeParts) == 2 {
			end, err := parseCronValue(rangeParts[1], rule)
			if err != nil {
				return err
			}
			if start > end {
				return fmt.Errorf("range start exceeds range end")
			}
		}
	}
	return nil
}

func parseCronValue(value string, rule cronFieldRule) (int, error) {
	if named, ok := rule.names[strings.ToLower(value)]; ok {
		return named, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < rule.min || parsed > rule.max {
		return 0, fmt.Errorf("value must be between %d and %d", rule.min, rule.max)
	}
	return parsed, nil
}

func containsControl(value string) bool {
	return strings.IndexFunc(value, unicode.IsControl) >= 0
}

func firstError(errors ...error) string {
	for _, err := range errors {
		if err != nil {
			return err.Error()
		}
	}
	return ""
}

func jobWorkloadName(serviceName, deploymentID string) string {
	hash := sha256.Sum256([]byte(deploymentID))
	suffix := fmt.Sprintf("%x", hash[:6])
	maxBase := 63 - len(suffix) - 1
	base := boundedDNSName(serviceName, serviceName, maxBase)
	return base + "-" + suffix
}

func resourceName(value string) string {
	return boundedDNSName(value, value, 63)
}

func boundedDNSName(value, identity string, limit int) string {
	value = normalizeDNSName(value)
	if limit <= 0 {
		return "item"
	}
	if len(value) <= limit {
		return value
	}
	hash := sha256.Sum256([]byte(firstNonEmpty(identity, value)))
	suffix := fmt.Sprintf("%x", hash[:6])
	if limit <= len(suffix) {
		return suffix[:limit]
	}
	baseLimit := limit - len(suffix) - 1
	base := strings.TrimRight(value[:baseLimit], "-")
	if base == "" {
		return suffix[:limit]
	}
	return base + "-" + suffix
}

func identityDNSName(value, identity string, limit int) string {
	if limit <= 0 {
		return "item"
	}
	value = normalizeDNSName(value)
	hash := sha256.Sum256([]byte(firstNonEmpty(identity, value)))
	suffix := fmt.Sprintf("%x", hash[:6])
	if limit <= len(suffix) {
		return suffix[:limit]
	}
	baseLimit := limit - len(suffix) - 1
	if len(value) > baseLimit {
		value = strings.TrimRight(value[:baseLimit], "-")
	}
	if value == "" {
		return suffix[:limit]
	}
	return value + "-" + suffix
}

func normalizeDNSName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = dnsNamePattern.ReplaceAllString(value, "-")
	value = strings.Trim(value, "-")
	if value == "" {
		return "item"
	}
	return value
}

var privateIPv4EgressExceptions = []any{"10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"}
var privateIPv6EgressExceptions = []any{"::1/128", "fc00::/7", "fe80::/10", "fd00:ec2::254/128"}
var sha256DigestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var cronFieldPattern = regexp.MustCompile(`^[0-9A-Za-z*/?,-]+$`)
var environmentNamePattern = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
var dnsLabelValidationPattern = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`)
var dnsSubdomainValidationPattern = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$`)
var traefikMiddlewareValidationPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?@kubernetescrd$`)
var cronFieldRules = []cronFieldRule{
	{min: 0, max: 59},
	{min: 0, max: 23},
	{min: 1, max: 31},
	{min: 1, max: 12, names: map[string]int{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}},
	{min: 0, max: 7, names: map[string]int{"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}},
}
var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)
var dnsNamePattern = regexp.MustCompile(`[^a-z0-9-]+`)

func slug(value string) string {
	out := strings.ToLower(strings.TrimSpace(value))
	out = slugPattern.ReplaceAllString(out, "-")
	out = strings.Trim(out, "-")
	if out == "" {
		return "item"
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func servicePublicEgress(service *store.Service) bool {
	if service == nil {
		return false
	}
	return boolValue(service.DesiredSpec["allowPublicEgress"]) ||
		boolValue(service.DesiredSpec["publicEgress"]) ||
		boolValue(mapValue(service.DesiredSpec, "egress")["publicInternet"]) ||
		boolValue(service.DesiredState["allowPublicEgress"]) ||
		boolValue(service.DesiredState["publicEgress"]) ||
		boolValue(mapValue(service.DesiredState, "egress")["publicInternet"])
}

func serviceTenantIngress(service *store.Service) bool {
	if service == nil {
		return false
	}
	if value, ok := desiredValue(service, "allowTenantIngress"); ok {
		if enabled, ok := value.(bool); ok {
			return enabled
		}
	}
	return false
}

func mapValue(row map[string]any, key string) map[string]any {
	if row == nil || row[key] == nil {
		return map[string]any{}
	}
	if typed, ok := row[key].(map[string]any); ok {
		return typed
	}
	return map[string]any{}
}

func boolValue(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true") || strings.TrimSpace(typed) == "1"
	case float64:
		return typed != 0
	case int:
		return typed != 0
	default:
		return false
	}
}
