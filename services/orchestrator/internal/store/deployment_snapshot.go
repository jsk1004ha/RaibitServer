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
	for _, key := range []string{"type", "port", "replicas", "command", "args", "schedule", "env", "secretEnv", "allowPublicEgress", "publicEgress", "egress", "allowTenantIngress"} {
		if value, exists := fields[key]; exists {
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				switch key {
				case "port", "replicas", "allowPublicEgress", "publicEgress", "egress", "allowTenantIngress":
					continue
				default:
					return nil, ErrDeploymentSnapshot
				}
			}
			selected[key] = value
		}
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
