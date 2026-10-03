{{- define "raibitserver.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "raibitserver.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "raibitserver.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "raibitserver.commonLabels" -}}
app.kubernetes.io/part-of: raibitserver
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "raibitserver.operationalEnv" -}}
- name: RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED
  value: {{ ternary "1" "0" .Values.operational.enabled | quote }}
- name: RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE
  value: {{ ternary "1" "0" .Values.operational.implementationAvailable | quote }}
- name: RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION
  value: {{ .Values.operational.protocolVersion | quote }}
- name: RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST
  value: {{ .Values.operational.contractDigest | quote }}
- name: RAIBITSERVER_RELEASE_REVISION
  value: {{ .Values.operational.releaseRevision | quote }}
- name: RAIBITSERVER_RELEASE_SOURCE_CLEAN
  value: {{ ternary "1" "0" .Values.operational.releaseSourceClean | quote }}
{{- end -}}
