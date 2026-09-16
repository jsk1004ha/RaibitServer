{{/* Generated JSON copy: node scripts/generate-resource-capabilities.mjs. */}}
{{- define "raibitserver.localProviderEngines" -}}
{{- $providers := list -}}
{{- range (.Files.Get "files/resource-capabilities-v1.json" | fromJson).engines -}}
{{- if and (eq .runtime "dedicated-local") .local.provision .local.authenticatedHealth -}}
{{- $providers = append $providers .engine -}}
{{- end -}}
{{- end -}}
{{- $providers | toJson -}}
{{- end -}}
