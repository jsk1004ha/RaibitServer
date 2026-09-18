package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

var ErrDeploymentSnapshot = errors.New("invalid deployment runtime snapshot")

type snapshotSecretEnv struct {
	Name      string `json:"name"`
	ValueFrom struct {
		SecretKeyRef struct {
			Name string `json:"name"`
			Key  string `json:"key"`
		} `json:"secretKeyRef"`
	} `json:"valueFrom"`
}

type runtimeSnapshot struct {
	HealthCheckPath  *string `json:"healthCheckPath"`
	LivenessPath     *string `json:"livenessPath"`
	ReadinessPath    *string `json:"readinessPath"`
	PublicHealthPath *string `json:"publicHealthPath"`
	HealthCheck      *struct {
		Path string `json:"path"`
	} `json:"healthCheck"`
	Type               string              `json:"type"`
	Port               *int                `json:"port"`
	Replicas           *int                `json:"replicas"`
	Command            []string            `json:"command"`
	Args               []string            `json:"args"`
	Schedule           string              `json:"schedule"`
	Env                map[string]string   `json:"env"`
	SecretEnv          []snapshotSecretEnv `json:"secretEnv"`
	AllowPublicEgress  bool                `json:"allowPublicEgress"`
	PublicEgress       bool                `json:"publicEgress"`
	AllowTenantIngress bool                `json:"allowTenantIngress"`
	Persistence        json.RawMessage     `json:"persistence"`
	Resources          json.RawMessage     `json:"resources"`
	Egress             struct {
		PublicInternet bool `json:"publicInternet"`
	} `json:"egress"`
}

// RuntimeService projects only execution fields; live identity and lifecycle
// remain authoritative. The returned maps belong to the projection, not live.
func (deployment *Deployment) RuntimeService(live *Service) (*Service, error) {
	raw := bytes.TrimSpace(deployment.DesiredSpecSnapshot)
	missing := len(raw) == 0 || bytes.Equal(raw, []byte("null"))
	lineaged := deployment.SourceDeploymentID != "" || deployment.RetryOfDeploymentID != "" ||
		strings.EqualFold(deployment.TriggerType, "retry") || strings.EqualFold(deployment.TriggerType, "redeploy")
	if missing && deployment.SnapshotVersion == 0 && !lineaged {
		return live, nil
	}
	if missing || deployment.SnapshotVersion != 1 {
		return nil, ErrDeploymentSnapshot
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, ErrDeploymentSnapshot
	}
	selected := make(map[string]json.RawMessage)
	for _, key := range []string{"type", "port", "replicas", "command", "args", "schedule", "env", "secretEnv", "allowPublicEgress", "publicEgress", "egress", "allowTenantIngress", "healthCheckPath", "livenessPath", "readinessPath", "publicHealthPath", "healthCheck", "persistence", "resources"} {
		if value, exists := fields[key]; exists {
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				switch key {
				case "port", "replicas", "allowPublicEgress", "publicEgress", "egress", "allowTenantIngress", "healthCheckPath", "livenessPath", "readinessPath", "publicHealthPath", "healthCheck", "persistence", "resources":
					continue
				default:
					return nil, ErrDeploymentSnapshot
				}
			}
			selected[key] = value
		}
	}
	livePersistence, liveHasPersistence, err := runtimePersistenceFromService(live)
	if err != nil {
		return nil, ErrDeploymentSnapshot
	}
	snapshotPersistence, snapshotHasPersistence := selected["persistence"]
	switch {
	case liveHasPersistence && snapshotHasPersistence:
		if !jsonValuesEqual(livePersistence, snapshotPersistence) {
			return nil, ErrDeploymentSnapshot
		}
	case liveHasPersistence:
		// Persistence is service identity state. Historical snapshots created
		// before it was enabled must still mount the service's current claim.
		selected["persistence"] = livePersistence
	case snapshotHasPersistence:
		// A snapshot may not resurrect storage that the live service does not own.
		return nil, ErrDeploymentSnapshot
	}
	encoded, err := json.Marshal(selected)
	if err != nil {
		return nil, ErrDeploymentSnapshot
	}
	var execution runtimeSnapshot
	if err := json.Unmarshal(encoded, &execution); err != nil || strings.TrimSpace(execution.Type) == "" {
		return nil, ErrDeploymentSnapshot
	}
	view := *live
	view.HealthCheckPath, view.LivenessPath, view.ReadinessPath, view.PublicHealthPath = "", "", "", ""
	for target, value := range map[*string]*string{&view.HealthCheckPath: execution.HealthCheckPath, &view.LivenessPath: execution.LivenessPath, &view.ReadinessPath: execution.ReadinessPath, &view.PublicHealthPath: execution.PublicHealthPath} {
		if value != nil {
			if !validHealthPath(*value) {
				return nil, ErrDeploymentSnapshot
			}
			*target = *value
		}
	}
	if execution.HealthCheck != nil && execution.HealthCheck.Path != "" {
		if !validHealthPath(execution.HealthCheck.Path) || (view.HealthCheckPath != "" && view.HealthCheckPath != execution.HealthCheck.Path) {
			return nil, ErrDeploymentSnapshot
		}
		if raw, exists := fields["healthCheckPath"]; exists && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return nil, ErrDeploymentSnapshot
		}
		view.HealthCheckPath = execution.HealthCheck.Path
	}
	if execution.Type != "web" && view.PublicHealthPath != "" {
		return nil, ErrDeploymentSnapshot
	}
	view.Type, view.Port, view.Replicas = execution.Type, 3000, 1
	if execution.Port != nil {
		if *execution.Port < 0 || *execution.Port > 65535 {
			return nil, ErrDeploymentSnapshot
		}
		if *execution.Port > 0 {
			view.Port = *execution.Port
		}
	}
	if execution.Replicas != nil {
		if *execution.Replicas < 0 {
			return nil, ErrDeploymentSnapshot
		}
		if *execution.Replicas > 0 {
			view.Replicas = *execution.Replicas
		}
	}
	// Keep the existing command/env/Secret-reference validators at the kube seam.
	view.DesiredState = nil
	view.DesiredSpec = nil
	if err := json.Unmarshal(encoded, &view.DesiredSpec); err != nil {
		return nil, ErrDeploymentSnapshot
	}
	return &view, nil
}

func runtimePersistenceFromService(service *Service) (json.RawMessage, bool, error) {
	if service == nil {
		return nil, false, nil
	}
	var value any
	found := false
	if service.DesiredSpec != nil {
		value, found = service.DesiredSpec["persistence"]
	}
	if !found && service.DesiredState != nil {
		value, found = service.DesiredState["persistence"]
	}
	if !found || value == nil {
		return nil, false, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, false, err
	}
	return encoded, true, nil
}

func jsonValuesEqual(left, right json.RawMessage) bool {
	var leftValue any
	var rightValue any
	if json.Unmarshal(left, &leftValue) != nil || json.Unmarshal(right, &rightValue) != nil {
		return false
	}
	leftCanonical, leftErr := json.Marshal(leftValue)
	rightCanonical, rightErr := json.Marshal(rightValue)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftCanonical, rightCanonical)
}

func snapshotJSONFromRecord(row record) json.RawMessage {
	raw, err := json.Marshal(row["desiredSpecSnapshot"])
	if err != nil {
		return json.RawMessage(`false`)
	}
	return raw
}

func snapshotVersionFromRecord(row record) int {
	value := row["snapshotVersion"]
	if value == nil {
		return 0
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return -1
	}
	var version int
	if err := json.Unmarshal(raw, &version); err != nil || version < 1 {
		return -1
	}
	return version
}
