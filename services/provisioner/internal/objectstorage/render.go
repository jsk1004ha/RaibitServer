package objectstorage

import (
	"encoding/json"
	"fmt"
	"strings"
)

type Ownership struct {
	Namespace        string
	Name             string
	PVCName          string
	SecretName       string
	GatewayNamespace string
}

func ValidateRendered(manifests []map[string]any, ownership Ownership) error {
	if !validDNSLabel(ownership.Namespace) ||
		!validDNSLabel(ownership.Name) ||
		!validDNSLabel(ownership.PVCName) ||
		!validDNSLabel(ownership.SecretName) ||
		!validDNSLabel(ownership.GatewayNamespace) ||
		len(manifests) != 5 {
		return ErrConfig
	}
	byKind := make(map[string]map[string]any, len(manifests))
	for _, manifest := range manifests {
		kind, ok := manifest["kind"].(string)
		if !ok || byKind[kind] != nil {
			return ErrConfig
		}
		byKind[kind] = manifest
	}
	for _, kind := range []string{"Namespace", "PersistentVolumeClaim", "Service", "StatefulSet", "NetworkPolicy"} {
		if byKind[kind] == nil {
			return ErrConfig
		}
	}
	if !ownedMetadata(byKind["PersistentVolumeClaim"], ownership.PVCName, ownership) ||
		!ownedMetadata(byKind["Service"], ownership.Name, ownership) ||
		!ownedMetadata(byKind["StatefulSet"], ownership.Name, ownership) ||
		!ownedMetadata(byKind["NetworkPolicy"], ownership.Name+"-provider", ownership) {
		return ErrConfig
	}
	if err := validatePVC(byKind["PersistentVolumeClaim"], ownership); err != nil {
		return fmt.Errorf("PVC: %w", err)
	}
	if err := validateService(byKind["Service"], ownership); err != nil {
		return fmt.Errorf("Service: %w", err)
	}
	if err := validateStatefulSet(byKind["StatefulSet"], ownership); err != nil {
		return fmt.Errorf("StatefulSet: %w", err)
	}
	if err := validateNetworkPolicy(byKind["NetworkPolicy"], ownership); err != nil {
		return fmt.Errorf("NetworkPolicy: %w", err)
	}
	return nil
}

func ownedMetadata(manifest map[string]any, name string, ownership Ownership) bool {
	metadata := object(manifest["metadata"])
	labels := object(metadata["labels"])
	return metadata["name"] == name &&
		metadata["namespace"] == ownership.Namespace &&
		labels["app.kubernetes.io/name"] == ownership.Name &&
		labels["app.kubernetes.io/managed-by"] == "raibitserver" &&
		labels["raibitserver.io/managed"] == "true" &&
		labels["raibitserver.io/provider"] == "object-storage" &&
		strings.TrimSpace(fmt.Sprint(labels["raibitserver.io/resource-id"])) != ""
}

func validatePVC(manifest map[string]any, ownership Ownership) error {
	spec := object(manifest["spec"])
	if !equalStrings(spec["accessModes"], []string{"ReadWriteOnce"}) ||
		object(object(spec["resources"])["requests"])["storage"] == nil {
		return ErrConfig
	}
	return nil
}

func validateService(manifest map[string]any, ownership Ownership) error {
	spec := object(manifest["spec"])
	ports := list(spec["ports"])
	if len(ports) != 1 || object(ports[0])["name"] != "provider" ||
		number(object(ports[0])["port"]) != 8333 ||
		object(ports[0])["targetPort"] != "provider" ||
		spec["clusterIP"] != "None" ||
		spec["type"] != nil ||
		spec["externalIPs"] != nil {
		return ErrConfig
	}
	return nil
}

func validateStatefulSet(manifest map[string]any, ownership Ownership) error {
	spec := object(manifest["spec"])
	templateSpec := object(object(object(spec["template"])["spec"]))
	containers := list(templateSpec["containers"])
	volumes := list(templateSpec["volumes"])
	if number(spec["replicas"]) != 1 || len(containers) != 1 || len(volumes) != 2 ||
		templateSpec["automountServiceAccountToken"] != false {
		return fmt.Errorf("pod shape: %w", ErrConfig)
	}
	container := object(containers[0])
	ports := list(container["ports"])
	mounts := list(container["volumeMounts"])
	security := object(container["securityContext"])
	resources := object(container["resources"])
	requests := object(resources["requests"])
	limits := object(resources["limits"])
	if container["image"] != PinnedImage ||
		len(ports) != 1 ||
		len(mounts) != 2 ||
		number(object(ports[0])["containerPort"]) != 8333 ||
		number(security["runAsUser"]) != 1000 ||
		security["runAsNonRoot"] != true ||
		security["allowPrivilegeEscalation"] != false ||
		len(requests) != 3 ||
		requests["cpu"] != "100m" ||
		requests["memory"] != "128Mi" ||
		requests["ephemeral-storage"] != "256Mi" ||
		len(limits) != 3 ||
		limits["cpu"] != "1" ||
		limits["memory"] != "1Gi" ||
		limits["ephemeral-storage"] != "1Gi" {
		return fmt.Errorf("container contract: %w", ErrConfig)
	}
	dataVolume := namedObject(volumes, "data")
	configVolume := namedObject(volumes, "provider-config")
	dataMount := namedObject(mounts, "data")
	configMount := namedObject(mounts, "provider-config")
	if object(dataVolume["persistentVolumeClaim"])["claimName"] != ownership.PVCName ||
		object(configVolume["secret"])["secretName"] != ownership.SecretName ||
		dataMount["mountPath"] != "/data" ||
		configMount["mountPath"] != "/etc/seaweedfs" ||
		configMount["readOnly"] != true {
		return fmt.Errorf("storage mounts: %w", ErrConfig)
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		return ErrConfig
	}
	text := string(payload)
	required := []string{
		`"key":"` + ConfigSecretKey + `"`,
		`"drop":["ALL"]`,
		`"runAsGroup":1000`,
		`"fsGroup":1000`,
	}
	for index, fragment := range required {
		if !strings.Contains(text, fragment) {
			return fmt.Errorf("missing workload fragment %d: %w", index, ErrConfig)
		}
	}
	for _, forbidden := range []string{"hostPort", "privileged", "MINIO_ROOT", "admin.access-key", "admin.secret-key"} {
		if strings.Contains(text, forbidden) {
			return fmt.Errorf("forbidden workload field: %w", ErrConfig)
		}
	}
	return nil
}

func validateNetworkPolicy(manifest map[string]any, ownership Ownership) error {
	spec := object(manifest["spec"])
	ingress := list(spec["ingress"])
	egress := list(spec["egress"])
	if !equalStrings(spec["policyTypes"], []string{"Ingress", "Egress"}) ||
		len(ingress) != 1 ||
		len(egress) != 0 {
		return ErrConfig
	}
	rule := object(ingress[0])
	from := list(rule["from"])
	ports := list(rule["ports"])
	if len(from) != 1 || len(ports) != 1 || number(object(ports[0])["port"]) != 8333 {
		return ErrConfig
	}
	peer := object(from[0])
	namespaceLabels := object(object(peer["namespaceSelector"])["matchLabels"])
	podLabels := object(object(peer["podSelector"])["matchLabels"])
	if len(namespaceLabels) != 1 ||
		len(podLabels) != 1 ||
		namespaceLabels["kubernetes.io/metadata.name"] != ownership.GatewayNamespace ||
		podLabels[GatewayPodLabelKey] != GatewayPodLabelValue {
		return ErrConfig
	}
	return nil
}

func object(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func list(value any) []any {
	result, _ := value.([]any)
	return result
}

func number(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}

func equalStrings(value any, expected []string) bool {
	items := list(value)
	if len(items) != len(expected) {
		return false
	}
	for index, item := range items {
		if item != expected[index] {
			return false
		}
	}
	return true
}

func namedObject(items []any, name string) map[string]any {
	for _, item := range items {
		candidate := object(item)
		if candidate["name"] == name {
			return candidate
		}
	}
	return nil
}
