package kube

import (
	"errors"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/raibitserver/orchestrator/internal/store"
)

var ErrHealthPath = errors.New("invalid service health path")

func healthPathsFromService(service *store.Service) ([4]string, error) {
	paths := [4]string{service.HealthCheckPath, service.LivenessPath, service.ReadinessPath, service.PublicHealthPath}
	for index, key := range []string{"healthCheckPath", "livenessPath", "readinessPath", "publicHealthPath"} {
		raw, found := desiredValue(service, key)
		if !found {
			continue
		}
		if raw == nil {
			paths[index] = ""
			continue
		}
		value, ok := raw.(string)
		if !ok || value == "" {
			return paths, ErrHealthPath
		}
		paths[index] = value
	}
	if raw, found := desiredValue(service, "healthCheck"); found && raw != nil {
		legacy, ok := raw.(map[string]any)
		if !ok {
			return paths, ErrHealthPath
		}
		if rawPath, exists := legacy["path"]; exists && rawPath != nil {
			path, ok := rawPath.(string)
			if !ok || path == "" || (paths[0] != "" && paths[0] != path) {
				return paths, ErrHealthPath
			}
			// Explicit null is authoritative over a retained legacy alias.
			if rawCommon, present := desiredValue(service, "healthCheckPath"); !present || rawCommon != nil {
				paths[0] = path
			}
		}
	}
	return paths, nil
}

func validateHealthPaths(spec AppServiceSpec) error {
	if spec.ServiceType != "web" && spec.PublicHealthPath != "" {
		return ErrHealthPath
	}
	for _, path := range []string{spec.HealthCheckPath, spec.LivenessPath, spec.ReadinessPath, spec.PublicHealthPath} {
		if path == "" {
			continue
		}
		if len(path) > 1024 || !utf8.ValidString(path) || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
			return ErrHealthPath
		}
		if strings.ContainsAny(path, "\\?#") || strings.IndexFunc(path, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
			return ErrHealthPath
		}
		decoded, err := url.PathUnescape(path)
		if err != nil || !utf8.ValidString(decoded) {
			return ErrHealthPath
		}
		for index := 0; index < len(path); index++ {
			if path[index] != '%' {
				continue
			}
			value, err := url.PathUnescape(path[index : index+3])
			if err != nil || strings.ContainsAny(value, "/\\?#%") {
				return ErrHealthPath
			}
			index += 2
		}
		if strings.IndexFunc(decoded, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
			return ErrHealthPath
		}
		for _, segment := range strings.Split(decoded, "/") {
			if segment == "." || segment == ".." {
				return ErrHealthPath
			}
		}
	}
	return nil
}

func applyHealthProbes(container map[string]any, spec AppServiceSpec) {
	if spec.ServiceType != "web" {
		return
	}
	for name, path := range map[string]string{
		"startupProbe":   firstNonEmpty(spec.HealthCheckPath, spec.ReadinessPath),
		"readinessProbe": firstNonEmpty(spec.ReadinessPath, spec.HealthCheckPath),
		"livenessProbe":  firstNonEmpty(spec.LivenessPath, spec.HealthCheckPath),
	} {
		probe := map[string]any{"initialDelaySeconds": 5, "periodSeconds": 10, "timeoutSeconds": 2, "failureThreshold": 3}
		if name == "startupProbe" {
			probe["failureThreshold"] = 30
		}
		if path == "" {
			probe["tcpSocket"] = map[string]any{"port": spec.Port}
		} else {
			probe["httpGet"] = map[string]any{"path": path, "port": spec.Port, "scheme": "HTTP"}
		}
		container[name] = probe
	}
}

func (spec AppServiceSpec) EffectivePublicHealthPath() string {
	return firstNonEmpty(spec.PublicHealthPath, spec.ReadinessPath, spec.HealthCheckPath, "/")
}
