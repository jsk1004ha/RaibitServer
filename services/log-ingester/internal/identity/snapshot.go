package identity

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
)

type snapshot struct {
	Type                                                           string
	Command, Args                                                  []string
	Port, Replicas                                                 *int
	Schedule                                                       string
	Env                                                            map[string]string
	SecretEnv                                                      []EnvironmentEntry
	AllowPublicEgress, PublicEgress, AllowTenantIngress            *bool
	Egress                                                         *struct{ PublicInternet bool }
	HealthCheckPath, LivenessPath, ReadinessPath, PublicHealthPath *string
	HealthCheck                                                    *struct{ Path string }
}
type EnvironmentEntry struct {
	Name      string             `json:"name"`
	Value     string             `json:"value,omitempty"`
	ValueFrom *EnvironmentSource `json:"valueFrom,omitempty"`
}
type (
	EnvironmentSource struct {
		SecretKeyRef SecretReference `json:"secretKeyRef"`
	}
	SecretReference struct {
		Name string `json:"name"`
		Key  string `json:"key"`
	}
)

func (entry *EnvironmentEntry) UnmarshalJSON(raw []byte) error {
	type wire EnvironmentEntry
	var parsed wire
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&parsed); err != nil {
		return ErrIdentity
	}
	if parsed.ValueFrom != nil && parsed.Value != "" {
		return ErrIdentity
	}
	*entry = EnvironmentEntry(parsed)
	return nil
}

var environmentName = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)

func parseSnapshot(raw json.RawMessage) (snapshot, error) {
	var spec snapshot
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return spec, ErrIdentity
	}
	for _, name := range []string{"type", "command", "args", "schedule", "env", "secretEnv"} {
		if value, exists := fields[name]; exists && string(value) == "null" {
			return spec, ErrIdentity
		}
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		return spec, ErrIdentity
	}
	if spec.Type == "" || (spec.Port != nil && (*spec.Port < 0 || *spec.Port > 65535)) || (spec.Replicas != nil && *spec.Replicas < 0) {
		return spec, ErrIdentity
	}
	for _, args := range [][]string{spec.Command, spec.Args} {
		if len(args) > 64 {
			return spec, ErrIdentity
		}
		for _, arg := range args {
			if len(arg) > 4096 || strings.ContainsAny(arg, "\x00\r\n") {
				return spec, ErrIdentity
			}
		}
	}
	return spec, nil
}

func runtimeEnvironment(state Input, spec snapshot) (string, error) {
	env := spec.Env
	if env == nil {
		env = map[string]string{}
	}
	env["RAIBITSERVER_DEPLOYMENT_ID"] = state.DeploymentID
	env["RAIBITSERVER_SERVICE_ID"] = state.ServiceID
	env["RAIBITSERVER_PROJECT_ID"] = state.ProjectID
	env["RAIBITSERVER_DEPLOYMENT_TYPE"] = state.DeploymentType
	if env["RAIBITSERVER_DEPLOYMENT_TYPE"] == "" {
		env["RAIBITSERVER_DEPLOYMENT_TYPE"] = "production"
	}
	if strings.TrimSpace(state.CommitSHA) != "" {
		env["RAIBITSERVER_GIT_SHA"] = strings.TrimSpace(state.CommitSHA)
	}
	entries := append([]EnvironmentEntry(nil), spec.SecretEnv...)
	for name, value := range env {
		entries = append(entries, EnvironmentEntry{Name: name, Value: value})
	}
	return EnvironmentHash(entries)
}

// EnvironmentHash compares only bounded named values and Secret references;
// neither secret values nor an environment payload is retained in authority.
func EnvironmentHash(entries []EnvironmentEntry) (string, error) {
	if len(entries) > 128 {
		return "", ErrIdentity
	}
	values := make(map[string]EnvironmentEntry, len(entries))
	for _, entry := range entries {
		if !environmentName.MatchString(entry.Name) || len(entry.Value) > 4096 || strings.ContainsAny(entry.Value, "\x00\r\n") {
			return "", ErrIdentity
		}
		if _, exists := values[entry.Name]; exists {
			return "", ErrIdentity
		}
		if entry.ValueFrom != nil {
			ref := entry.ValueFrom.SecretKeyRef
			if entry.Value != "" || len(ref.Name) > 63 || normalize(ref.Name) != ref.Name || ref.Name == "" || !environmentName.MatchString(ref.Key) {
				return "", ErrIdentity
			}
		}
		values[entry.Name] = entry
	}
	raw, err := json.Marshal(values)
	if err != nil {
		return "", ErrIdentity
	}
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:]), nil
}
