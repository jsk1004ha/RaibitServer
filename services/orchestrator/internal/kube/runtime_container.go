package kube

import "sort"

func runtimeContainer(spec AppServiceSpec) map[string]any {
	container := map[string]any{
		"name":            spec.Name,
		"image":           spec.Image,
		"imagePullPolicy": "IfNotPresent",
		"resources": map[string]any{
			"requests": map[string]any{"cpu": "100m", "memory": "128Mi", "ephemeral-storage": "64Mi"},
			"limits":   map[string]any{"cpu": "500m", "memory": "512Mi", "ephemeral-storage": "256Mi"},
		},
		"securityContext": map[string]any{
			"allowPrivilegeEscalation": false,
			"readOnlyRootFilesystem":   true,
			"runAsNonRoot":             true,
			"capabilities":             map[string]any{"drop": []any{"ALL"}},
		},
		"volumeMounts": []any{map[string]any{"name": "tmp", "mountPath": "/tmp"}},
	}
	if spec.ServiceType == "web" || spec.ServiceType == "private" {
		container["ports"] = []any{map[string]any{"name": "http", "containerPort": spec.Port}}
	}
	if len(spec.Command) > 0 {
		container["command"] = spec.Command
	}
	if len(spec.Args) > 0 {
		container["args"] = spec.Args
	}
	if len(spec.Env) > 0 || len(spec.SecretEnv) > 0 {
		env := make([]any, 0, len(spec.Env)+len(spec.SecretEnv))
		names := make([]string, 0, len(spec.Env))
		for name := range spec.Env {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			env = append(env, map[string]any{"name": name, "value": spec.Env[name]})
		}
		for index := range spec.SecretEnv {
			env = append(env, spec.SecretEnv[index])
		}
		container["env"] = env
	}
	applyHealthProbes(container, spec)
	return container
}
