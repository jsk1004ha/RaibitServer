#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

CLUSTER_NAME="raibit-recovery-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
KIND_NODE_IMAGE="kindest/node:v1.34.3@sha256:08497ee19eace7b4b5348db5c6a1591d7752b164530a36f855cb0f2bdcbadd48"
KUBE_CONTEXT="kind-${CLUSTER_NAME}"
CONTROL_NAMESPACE="raibitserver-system"
TENANT_NAMESPACE="project-1"
RELEASE_NAME="nat"
FULLNAME="${RELEASE_NAME}-raibitserver"
PROVISIONER_USER="system:serviceaccount:${CONTROL_NAMESPACE}:${FULLNAME}-provisioner"
EVIDENCE_DIR="${RAIBITSERVER_RECOVERY_NATIVE_EVIDENCE_DIR:-${ROOT_DIR}/.omo/evidence/pr17-review-followup/p2-native-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}}"
WORK_DIR=""
CLUSTER_JOURNALED=0
PROXY_PID=""

mkdir -p "${EVIDENCE_DIR}"
exec > >(tee "${EVIDENCE_DIR}/run.log") 2>&1

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  cleanup_status=0
  if [[ -n "${PROXY_PID}" ]]; then
    kill "${PROXY_PID}" 2>/dev/null || true
    wait "${PROXY_PID}" 2>/dev/null || true
  fi
  if [[ "${CLUSTER_JOURNALED}" -eq 1 ]]; then
    timeout 120s kind delete cluster --name "${CLUSTER_NAME}" || cleanup_status=$?
  fi
  if [[ -n "${WORK_DIR}" ]]; then
    rm -rf -- "${WORK_DIR:?}"
  fi
  printf 'scenario_exit=%d\ncleanup_exit=%d\ncluster=%s\nfixture_interpretation=synthetic terminal Job with a non-controller blocking dependent Pod; not backup success\n' \
    "${status}" "${cleanup_status}" "${CLUSTER_NAME}" >"${EVIDENCE_DIR}/cleanup-receipt.txt"
  if [[ "${status}" -eq 0 && "${cleanup_status}" -ne 0 ]]; then
    status=${cleanup_status}
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for command in curl go helm jq kind kubectl timeout; do
  command -v "${command}" >/dev/null || { echo "required command is unavailable: ${command}" >&2; exit 1; }
done

if kind get clusters 2>/dev/null | grep -Fxq "${CLUSTER_NAME}"; then
  echo "refusing to reuse cluster: ${CLUSTER_NAME}" >&2
  exit 1
fi

cat >"${EVIDENCE_DIR}/resource-journal.txt" <<EOF
cluster=${CLUSTER_NAME}; cleanup=kind delete cluster --name ${CLUSTER_NAME}
context=${KUBE_CONTEXT}; ownership=created-by-this-script
namespaces=${CONTROL_NAMESPACE},${TENANT_NAMESPACE}; cleanup=owned-cluster-deletion
release=${RELEASE_NAME}; scope=worker-security-template-only; cleanup=owned-cluster-deletion
work_dir=mktemp-created-after-this-journal; cleanup=owned-script-exit-trap
EOF
WORK_DIR="$(mktemp -d)"
CLUSTER_JOURNALED=1

timeout 240s kind create cluster --name "${CLUSTER_NAME}" --image "${KIND_NODE_IMAGE}" --wait 180s
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s version -o json >"${EVIDENCE_DIR}/kubernetes-version.json"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s create namespace "${CONTROL_NAMESPACE}"

timeout 60s helm template "${RELEASE_NAME}" infra/helm/raibitserver \
  --namespace "${CONTROL_NAMESPACE}" --show-only templates/worker-security.yaml >"${EVIDENCE_DIR}/worker-security.yaml"
recovery_job_policy="$(awk -v policy_name="${FULLNAME}-provisioner-recovery-jobs" '
  $0 == "---" { capture = 0 }
  $0 == "  name: " policy_name { capture = 1 }
  capture { print }
' "${EVIDENCE_DIR}/worker-security.yaml")"
if [[ "$(grep -Fc 'oldObject.spec.ttlSecondsAfterFinished == 600' <<<"${recovery_job_policy}")" -ne 2 ]] ||
  ! grep -Fq "request.operation == 'DELETE' &&" <<<"${recovery_job_policy}" ||
  ! grep -Fq "request.operation != 'UPDATE' ||" <<<"${recovery_job_policy}" ||
  ! grep -Fq 'has(oldObject.metadata.deletionTimestamp)' <<<"${recovery_job_policy}" ||
  ! grep -Fq "foregroundDeletion" <<<"${recovery_job_policy}" ||
  ! grep -Fq 'object.spec == oldObject.spec && object.status == oldObject.status' <<<"${recovery_job_policy}"; then
  echo "rendered recovery Jobs policy must retain exact native TTL DELETE and foreground GC UPDATE guards" >&2
  exit 1
fi
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s apply -f "${EVIDENCE_DIR}/worker-security.yaml"

kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s create namespace "${TENANT_NAMESPACE}"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s label namespace "${TENANT_NAMESPACE}" \
  kubernetes.io/metadata.name="${TENANT_NAMESPACE}" \
  app.kubernetes.io/managed-by=raibitserver raibitserver.io/managed=true \
  raibitserver.io/namespace-kind=application raibitserver.io/project=demo \
  raibitserver.io/project-id=project-1 pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/audit=restricted pod-security.kubernetes.io/warn=restricted --overwrite

cat >"${WORK_DIR}/tenant-rolebinding.yaml" <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${FULLNAME}-provisioner-tenant-access
  namespace: ${TENANT_NAMESPACE}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${FULLNAME}-provisioner-tenant
subjects:
  - kind: ServiceAccount
    name: ${FULLNAME}-provisioner
    namespace: ${CONTROL_NAMESPACE}
EOF
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s apply -f "${WORK_DIR}/tenant-rolebinding.yaml"

timeout 120s bash -c "cd services/provisioner && exec go test ./internal/backup -run '^Test_RecoveryNetworkPolicyManifest_emits_admission_fixture$' -count=1 -v" >"${EVIDENCE_DIR}/generated-go.log"
sed -n 's/^.*BOUNDARY_FIXTURE=//p' "${EVIDENCE_DIR}/generated-go.log" >"${EVIDENCE_DIR}/generated-recovery.json"
test -s "${EVIDENCE_DIR}/generated-recovery.json"
jq -e 'type == "object" and (.policy | type == "object") and (.job | type == "object")' \
  "${EVIDENCE_DIR}/generated-recovery.json" >/dev/null
jq '.policy' "${EVIDENCE_DIR}/generated-recovery.json" >"${EVIDENCE_DIR}/generated-networkpolicy.json"

kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" \
  create -f "${EVIDENCE_DIR}/generated-networkpolicy.json"
policy_name="$(jq -r '.metadata.name' "${EVIDENCE_DIR}/generated-networkpolicy.json")"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get networkpolicy "${policy_name}" -o json >"${EVIDENCE_DIR}/stored-networkpolicy.json"
test "$(jq -r 'if .spec | has("ingress") then "present" else "omitted" end' "${EVIDENCE_DIR}/stored-networkpolicy.json")" = omitted
policy_uid="$(jq -r '.metadata.uid' "${EVIDENCE_DIR}/stored-networkpolicy.json")"

kubectl --context "${KUBE_CONTEXT}" proxy --port=0 >"${EVIDENCE_DIR}/kubectl-proxy.log" 2>&1 &
PROXY_PID=$!
for _ in $(seq 1 50); do
  proxy_port="$(sed -n 's/^Starting to serve on 127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p' "${EVIDENCE_DIR}/kubectl-proxy.log")"
  [[ -n "${proxy_port}" ]] && break
  kill -0 "${PROXY_PID}" 2>/dev/null || { cat "${EVIDENCE_DIR}/kubectl-proxy.log" >&2; exit 1; }
  sleep 0.1
done
[[ -n "${proxy_port:-}" ]] || { echo "kubectl proxy did not publish its port" >&2; exit 1; }
uid_delete() {
  local stem=$1 api_path=$2 uid=$3 status_code
  jq -n --arg uid "${uid}" '{apiVersion:"v1", kind:"DeleteOptions", preconditions:{uid:$uid}, propagationPolicy:"Background"}' >"${EVIDENCE_DIR}/${stem}-delete-options.json"
  status_code="$(curl --silent --show-error --output "${EVIDENCE_DIR}/${stem}-delete-response.json" --write-out '%{http_code}' \
    --request DELETE --header "Impersonate-User: ${PROVISIONER_USER}" --header 'Content-Type: application/json' \
    --data-binary @"${EVIDENCE_DIR}/${stem}-delete-options.json" "http://127.0.0.1:${proxy_port}${api_path}")"
  printf '%s\n' "${status_code}" >"${EVIDENCE_DIR}/${stem}-delete-status.txt"
  case "${status_code}" in 200|202) ;; *) cat "${EVIDENCE_DIR}/${stem}-delete-response.json" >&2; return 1 ;; esac
}
uid_delete networkpolicy "/apis/networking.k8s.io/v1/namespaces/${TENANT_NAMESPACE}/networkpolicies/${policy_name}" "${policy_uid}"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  wait --for=delete "networkpolicy/${policy_name}" --timeout=30s
if kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get networkpolicy "${policy_name}" >"${EVIDENCE_DIR}/post-delete-networkpolicy.stdout" 2>"${EVIDENCE_DIR}/post-delete-networkpolicy.stderr"; then
  echo "UID-preconditioned delete returned but recovery NetworkPolicy still exists" >&2
  exit 1
fi
grep -E 'NotFound|not found' "${EVIDENCE_DIR}/post-delete-networkpolicy.stderr"

jq '.metadata.name = "recovery-egress-bbbbbbbbbbbbbbbbbbbbbbbb" | .spec.ingress = [{}]' \
  "${EVIDENCE_DIR}/generated-networkpolicy.json" >"${WORK_DIR}/nonempty-ingress.json"
if kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" \
  create -f "${WORK_DIR}/nonempty-ingress.json" >"${EVIDENCE_DIR}/nonempty-ingress.stdout" 2>"${EVIDENCE_DIR}/nonempty-ingress.stderr"; then
  echo "nonempty recovery ingress unexpectedly admitted" >&2
  exit 1
fi
grep -F "${FULLNAME}-provisioner-recovery-networkpolicies" "${EVIDENCE_DIR}/nonempty-ingress.stderr"

cancel_authority="dddddddddddddddddddddddddddddddd"
cat >"${WORK_DIR}/cancel-provider-statefulset.yaml" <<EOF
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: native-provider
  namespace: ${TENANT_NAMESPACE}
spec:
  serviceName: native-provider
  replicas: 1
  selector:
    matchLabels: { app.kubernetes.io/name: native-provider }
  template:
    metadata:
      labels:
        app.kubernetes.io/name: native-provider
        app.kubernetes.io/managed-by: raibitserver
        raibitserver.io/managed: "true"
        raibitserver.io/project-id: project-1
        raibitserver.io/resource-id: resource-1
        raibitserver.io/provider: postgresql
    spec:
      automountServiceAccountToken: false
      containers:
        - name: provider
          image: registry.k8s.io/pause:3.10
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
            runAsNonRoot: true
            runAsUser: 65532
            seccompProfile: { type: RuntimeDefault }
EOF
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s create -f "${WORK_DIR}/cancel-provider-statefulset.yaml"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  rollout status statefulset/native-provider --timeout=90s
provider_uid="$(kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" get pod native-provider-0 -o jsonpath='{.metadata.uid}')"
provider_version="$(kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" get pod native-provider-0 -o jsonpath='{.metadata.resourceVersion}')"
provider_bind_patch="$(jq -nc --arg uid "${provider_uid}" --arg version "${provider_version}" --arg authority "${cancel_authority}" '[{"op":"test","path":"/metadata/uid","value":$uid},{"op":"test","path":"/metadata/resourceVersion","value":$version},{"op":"add","path":"/metadata/labels/raibitserver.io~1recovery-authority","value":$authority}]')"
annotation_mutation="$(jq -c '. + [{"op":"add","path":"/metadata/annotations","value":{"native.raibitserver.io/forbidden":"changed"}}]' <<<"${provider_bind_patch}")"
if kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" --namespace "${TENANT_NAMESPACE}" \
  patch pod/native-provider-0 --type=json -p "${annotation_mutation}" >"${EVIDENCE_DIR}/provider-annotation-mutation.stdout" 2>"${EVIDENCE_DIR}/provider-annotation-mutation.stderr"; then
  echo "recovery authority update unexpectedly changed provider annotations" >&2
  exit 1
fi
grep -F "${FULLNAME}-provisioner-recovery-provider-pods" "${EVIDENCE_DIR}/provider-annotation-mutation.stderr"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" --namespace "${TENANT_NAMESPACE}" \
  patch pod/native-provider-0 --type=json -p "${provider_bind_patch}" -o json >"${EVIDENCE_DIR}/cancel-provider-bound.json"

cancel_suffix="dddddddddddddddddddddddd"
cancel_job_name="recovery-job-${cancel_suffix}"
cancel_policy_name="recovery-egress-${cancel_suffix}"
cancel_snapshot_name="recovery-credential-${cancel_suffix}"
jq --arg name "${cancel_snapshot_name}" '.snapshot | .metadata.name = $name' \
  "${EVIDENCE_DIR}/generated-recovery.json" >"${EVIDENCE_DIR}/cancel-snapshot.json"
jq --arg name "${cancel_policy_name}" --arg authority "${cancel_authority}" \
  '.policy | .metadata.name = $name | .spec.egress[0].to[0].podSelector.matchLabels["raibitserver.io/recovery-authority"] = $authority' \
  "${EVIDENCE_DIR}/generated-recovery.json" >"${EVIDENCE_DIR}/cancel-networkpolicy.json"
jq --arg name "${cancel_job_name}" --arg snapshot "${cancel_snapshot_name}" '
  .job | .metadata.name = $name |
  .metadata.labels["raibitserver.io/credential-snapshot"] = $snapshot |
  .spec.template.metadata.labels["raibitserver.io/credential-snapshot"] = $snapshot |
  (.spec.template.spec.containers[].env[] | select(has("valueFrom")).valueFrom.secretKeyRef.name) = $snapshot
' "${EVIDENCE_DIR}/generated-recovery.json" >"${EVIDENCE_DIR}/cancel-active-job.json"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" create -f "${EVIDENCE_DIR}/cancel-snapshot.json"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" create -f "${EVIDENCE_DIR}/cancel-networkpolicy.json"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" create -f "${EVIDENCE_DIR}/cancel-active-job.json"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  wait --for=jsonpath='{.status.active}'=1 "job/${cancel_job_name}" --timeout=60s
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get job "${cancel_job_name}" -o json >"${EVIDENCE_DIR}/cancel-job-active.json"
jq -e '.status.active == 1 and ((.status.conditions // []) | all(.type != "Complete" and .type != "Failed"))' \
  "${EVIDENCE_DIR}/cancel-job-active.json" >/dev/null
if timeout 15s kubectl --context "${KUBE_CONTEXT}" --request-timeout=10s --as "${PROVISIONER_USER}" --namespace "${TENANT_NAMESPACE}" \
  logs -f "job/${cancel_job_name}" -c step-0 >"${EVIDENCE_DIR}/cancel-stream.stdout" 2>"${EVIDENCE_DIR}/cancel-stream.stderr"; then
  echo "active recovery Job log stream unexpectedly succeeded" >&2
  exit 1
fi

cancel_job_uid="$(jq -r '.metadata.uid' "${EVIDENCE_DIR}/cancel-job-active.json")"
cat >"${WORK_DIR}/cancel-dependent-pod.yaml" <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: native-cancel-dependent
  namespace: ${TENANT_NAMESPACE}
  labels:
    job-name: ${cancel_job_name}
    batch.kubernetes.io/controller-uid: ${cancel_job_uid}
  finalizers: ["recovery.raibitserver.io/native-hold"]
  ownerReferences:
    - apiVersion: batch/v1
      kind: Job
      name: ${cancel_job_name}
      uid: ${cancel_job_uid}
      controller: true
      blockOwnerDeletion: true
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: dependent
      image: registry.k8s.io/pause:3.10
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
EOF
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s create -f "${WORK_DIR}/cancel-dependent-pod.yaml"
cancel_policy_uid="$(kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" get networkpolicy "${cancel_policy_name}" -o jsonpath='{.metadata.uid}')"
cancel_snapshot_uid="$(kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" get secret "${cancel_snapshot_name}" -o jsonpath='{.metadata.uid}')"
uid_delete cancel-job "/apis/batch/v1/namespaces/${TENANT_NAMESPACE}/jobs/${cancel_job_name}" "${cancel_job_uid}"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" wait --for=delete "job/${cancel_job_name}" --timeout=30s
if kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get job "${cancel_job_name}" >"${EVIDENCE_DIR}/cancel-job-post-delete.stdout" 2>"${EVIDENCE_DIR}/cancel-job-post-delete.stderr"; then
  echo "background cancellation returned but recovery Job still exists" >&2
  exit 1
fi
grep -E 'NotFound|not found' "${EVIDENCE_DIR}/cancel-job-post-delete.stderr"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  wait --for=jsonpath='{.metadata.deletionTimestamp}' pod/native-cancel-dependent --timeout=30s
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get pod native-cancel-dependent -o json >"${EVIDENCE_DIR}/cancel-pod-terminating.json"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get networkpolicy "${cancel_policy_name}" -o json >"${EVIDENCE_DIR}/cancel-policy-protected.json"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get secret "${cancel_snapshot_name}" -o jsonpath='{.metadata.uid}' >"${EVIDENCE_DIR}/cancel-snapshot-protected-uid.txt"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get pod native-provider-0 -o json >"${EVIDENCE_DIR}/cancel-provider-protected.json"
jq -e --arg uid "${cancel_job_uid}" '.metadata.deletionTimestamp != null and .metadata.finalizers == ["recovery.raibitserver.io/native-hold"] and .metadata.ownerReferences[0].uid == $uid' \
  "${EVIDENCE_DIR}/cancel-pod-terminating.json" >/dev/null
jq -e --arg uid "${cancel_policy_uid}" '.metadata.uid == $uid' "${EVIDENCE_DIR}/cancel-policy-protected.json" >/dev/null
test "$(cat "${EVIDENCE_DIR}/cancel-snapshot-protected-uid.txt")" = "${cancel_snapshot_uid}"
jq -e --arg authority "${cancel_authority}" '.metadata.labels["raibitserver.io/recovery-authority"] == $authority' \
  "${EVIDENCE_DIR}/cancel-provider-protected.json" >/dev/null

kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  patch pod/native-cancel-dependent --type=json -p='[{"op":"remove","path":"/metadata/finalizers/0"}]'
cancel_pod_selector="job-name=${cancel_job_name},batch.kubernetes.io/controller-uid=${cancel_job_uid}"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  wait --for=delete pod --selector "${cancel_pod_selector}" --timeout=60s
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get pods --selector "${cancel_pod_selector}" -o json >"${EVIDENCE_DIR}/cancel-owned-pods-absent.json"
jq -e '.apiVersion == "v1" and (.kind == "PodList" or .kind == "List") and (.items | type) == "array" and (.items | length) == 0' "${EVIDENCE_DIR}/cancel-owned-pods-absent.json" >/dev/null
uid_delete cancel-policy "/apis/networking.k8s.io/v1/namespaces/${TENANT_NAMESPACE}/networkpolicies/${cancel_policy_name}" "${cancel_policy_uid}"
uid_delete cancel-snapshot "/api/v1/namespaces/${TENANT_NAMESPACE}/secrets/${cancel_snapshot_name}" "${cancel_snapshot_uid}"
provider_version="$(kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" get pod native-provider-0 -o jsonpath='{.metadata.resourceVersion}')"
provider_release_patch="$(jq -nc --arg uid "${provider_uid}" --arg version "${provider_version}" --arg authority "${cancel_authority}" '[{"op":"test","path":"/metadata/uid","value":$uid},{"op":"test","path":"/metadata/resourceVersion","value":$version},{"op":"test","path":"/metadata/labels/raibitserver.io~1recovery-authority","value":$authority},{"op":"remove","path":"/metadata/labels/raibitserver.io~1recovery-authority"}]')"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" --namespace "${TENANT_NAMESPACE}" \
  patch pod/native-provider-0 --type=json -p "${provider_release_patch}" -o json >"${EVIDENCE_DIR}/cancel-provider-released.json"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" wait --for=delete "networkpolicy/${cancel_policy_name}" --timeout=30s
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" wait --for=delete "secret/${cancel_snapshot_name}" --timeout=30s
jq -e '.metadata.labels | has("raibitserver.io/recovery-authority") | not' "${EVIDENCE_DIR}/cancel-provider-released.json" >/dev/null
if kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get networkpolicy "${cancel_policy_name}" >"${EVIDENCE_DIR}/cancel-policy-post-delete.stdout" 2>"${EVIDENCE_DIR}/cancel-policy-post-delete.stderr"; then
  echo "cancel cleanup NetworkPolicy still exists" >&2
  exit 1
fi
if kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get secret "${cancel_snapshot_name}" >"${EVIDENCE_DIR}/cancel-snapshot-post-delete.stdout" 2>"${EVIDENCE_DIR}/cancel-snapshot-post-delete.stderr"; then
  echo "cancel cleanup snapshot still exists" >&2
  exit 1
fi
grep -E 'NotFound|not found' "${EVIDENCE_DIR}/cancel-policy-post-delete.stderr"
grep -E 'NotFound|not found' "${EVIDENCE_DIR}/cancel-snapshot-post-delete.stderr"
printf 'job_uid=%s\npolicy_uid=%s\nsnapshot_uid=%s\nactive_before_delete=true\nstream_failure_observed=true\nprotections_held_while_pod_terminating=true\npod_absent_before_protection_release=true\n' \
  "${cancel_job_uid}" "${cancel_policy_uid}" "${cancel_snapshot_uid}" >"${EVIDENCE_DIR}/cancel-lifecycle-receipt.txt"

jq '.job | .spec.suspend = true' \
  "${EVIDENCE_DIR}/generated-recovery.json" >"${EVIDENCE_DIR}/native-ttl-job.json"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" \
  create -f "${EVIDENCE_DIR}/native-ttl-job.json"
job_name="$(jq -r '.metadata.name' "${EVIDENCE_DIR}/native-ttl-job.json")"
job_uid="$(kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" get job "${job_name}" -o jsonpath='{.metadata.uid}')"
cat >"${WORK_DIR}/dependent-pod.yaml" <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: native-ttl-dependent
  namespace: ${TENANT_NAMESPACE}
  ownerReferences:
    - apiVersion: batch/v1
      kind: Job
      name: ${job_name}
      uid: ${job_uid}
      blockOwnerDeletion: true
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: dependent
      image: registry.k8s.io/pause:3.10
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
EOF
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s apply -f "${WORK_DIR}/dependent-pod.yaml"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" get pod native-ttl-dependent -o json >"${EVIDENCE_DIR}/dependent-pod.json"
test "$(jq -r '.metadata.ownerReferences[0].uid' "${EVIDENCE_DIR}/dependent-pod.json")" = "${job_uid}"

started_at="$(date -u -d '12 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
finished_at="$(date -u -d '11 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get pod native-ttl-dependent -o json >"${EVIDENCE_DIR}/pre-ttl-dependent-pod.json"
jq -e --arg uid "${job_uid}" '
  .metadata.ownerReferences[0].uid == $uid and
  .metadata.ownerReferences[0].blockOwnerDeletion == true and
  (.metadata.ownerReferences[0] | has("controller") | not) and
  (.metadata | has("deletionTimestamp")) == false
' "${EVIDENCE_DIR}/pre-ttl-dependent-pod.json" >/dev/null
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" patch job "${job_name}" \
  --subresource=status --type=merge -p "{\"status\":{\"startTime\":\"${started_at}\",\"completionTime\":\"${finished_at}\",\"succeeded\":1,\"conditions\":[{\"type\":\"SuccessCriteriaMet\",\"status\":\"True\",\"lastTransitionTime\":\"${finished_at}\",\"reason\":\"NativeTTLProbe\"},{\"type\":\"Complete\",\"status\":\"True\",\"lastTransitionTime\":\"${finished_at}\",\"reason\":\"NativeTTLProbe\"}]}}" \
  -o json >"${EVIDENCE_DIR}/terminal-job.json"
jq -e --arg started "${started_at}" --arg finished "${finished_at}" '
  .status.startTime == $started and .status.completionTime == $finished and .status.succeeded == 1 and
  (.status.conditions | any(.type == "SuccessCriteriaMet" and .status == "True")) and
  (.status.conditions | any(.type == "Complete" and .status == "True"))
' "${EVIDENCE_DIR}/terminal-job.json" >/dev/null

kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace kube-system get pod \
  --selector component=kube-controller-manager -o json >"${EVIDENCE_DIR}/controller-manager.json"
if jq -e '.items[0].spec.containers[0].command | any(. == "--use-service-account-credentials=true")' "${EVIDENCE_DIR}/controller-manager.json" >/dev/null; then
  controller_identity='system:serviceaccount:kube-system:ttl-after-finished-controller'
  garbage_collector_identity='system:serviceaccount:kube-system:generic-garbage-collector'
else
  controller_identity='system:kube-controller-manager'
  garbage_collector_identity='system:kube-controller-manager'
fi
printf 'controller_identity=%s\ngarbage_collector_identity=%s\njob_uid=%s\ndependent_pre_ttl_exists=true\ndependent_owner_reference_controller=false\nterminal_fixture=synthetic SuccessCriteriaMet+Complete conditions with startTime 12 minutes and completionTime 11 minutes before submission\nproof_interpretation=dependent Pod existed without deletionTimestamp immediately before terminal status; subsequent absence requires native foreground GC, not Job-controller cleanup\nttl_seconds=600\n' \
  "${controller_identity}" "${garbage_collector_identity}" "${job_uid}" >"${EVIDENCE_DIR}/native-delete-observation.txt"

kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  wait --for=delete "job/${job_name}" --timeout=120s
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  wait --for=delete pod/native-ttl-dependent --timeout=120s
if kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get job "${job_name}" >"${EVIDENCE_DIR}/post-ttl-job.stdout" 2>"${EVIDENCE_DIR}/post-ttl-job.stderr"; then
  echo "TTL wait returned but recovery Job still exists" >&2
  exit 1
fi
grep -E 'NotFound|not found' "${EVIDENCE_DIR}/post-ttl-job.stderr"
if kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get pod native-ttl-dependent >"${EVIDENCE_DIR}/post-ttl-pod.stdout" 2>"${EVIDENCE_DIR}/post-ttl-pod.stderr"; then
  echo "foreground GC wait returned but dependent Pod still exists" >&2
  exit 1
fi
grep -E 'NotFound|not found' "${EVIDENCE_DIR}/post-ttl-pod.stderr"
printf 'NETWORKPOLICY_OMITTED_INGRESS=PASS\nNETWORKPOLICY_UID_DELETE_ABSENT=PASS\nNONEMPTY_INGRESS_DENIED=PASS\nRUNNING_JOB_CANCEL_PROTECTION_LIFECYCLE=PASS\nNATIVE_TTL_DELETE=PASS\nFOREGROUND_POD_GC=PASS\n'
