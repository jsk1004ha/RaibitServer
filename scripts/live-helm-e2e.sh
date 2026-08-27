#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

CLUSTER_NAME="${RAIBITSERVER_LIVE_E2E_CLUSTER:-raibitserver-live-e2e}"
KIND_NODE_IMAGE="${RAIBITSERVER_LIVE_E2E_KIND_NODE_IMAGE:-kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f}"
POSTGRES_IMAGE="${RAIBITSERVER_LIVE_E2E_POSTGRES_IMAGE:-postgres:16.14-alpine3.23@sha256:c95dee655b8a0743021bdbd2d21abb7ef2fd520c5df39bd328798769c049648f}"
CONTROL_PLANE_NAMESPACE="${RAIBITSERVER_LIVE_E2E_NAMESPACE:-raibitserver-system}"
RELEASE_NAME="${RAIBITSERVER_LIVE_E2E_RELEASE:-live}"
IMAGE_REGISTRY="raibitserver.local"
IMAGE_TAG="live-e2e"
POSTGRES_USER="raibitserver"
POSTGRES_PASSWORD="raibitserver-live-e2e"
POSTGRES_DATABASE="raibitserver"
TENANT_NAMESPACE="live-org--live-project"
PROVIDER_TENANT_NAMESPACE="live-provider-org--live-provider-project"
ADMISSION_TENANT_NAMESPACE="live-admission-org--live-admission-project"
WORK_DIR="$(mktemp -d)"
CLUSTER_CREATED=0
PORT_FORWARD_PID=""
POSTGRES_PORT_FORWARD_PID=""
API_PROXY_PID=""

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required command is unavailable: $1" >&2
    exit 1
  fi
}

for command in docker kind kubectl helm curl go base64; do
  require_command "${command}"
done

diagnostics() {
  kubectl --context "kind-${CLUSTER_NAME}" --namespace "${CONTROL_PLANE_NAMESPACE}" get all --output wide 2>/dev/null || true
  kubectl --context "kind-${CLUSTER_NAME}" --namespace "${PROVIDER_TENANT_NAMESPACE}" get all --output wide 2>/dev/null || true
  for component in postgres api orchestrator provisioner; do
    kubectl --context "kind-${CLUSTER_NAME}" --namespace "${CONTROL_PLANE_NAMESPACE}" logs \
      --selector "app.kubernetes.io/name=raibitserver-${component}" --all-containers --tail=200 2>/dev/null || true
  done
}

cleanup() {
  status=$?
  trap - EXIT
  if [[ -n "${PORT_FORWARD_PID}" ]]; then
    kill "${PORT_FORWARD_PID}" >/dev/null 2>&1 || true
    wait "${PORT_FORWARD_PID}" 2>/dev/null || true
  fi
  if [[ -n "${POSTGRES_PORT_FORWARD_PID}" ]]; then
    kill "${POSTGRES_PORT_FORWARD_PID}" >/dev/null 2>&1 || true
    wait "${POSTGRES_PORT_FORWARD_PID}" 2>/dev/null || true
  fi
  if [[ -n "${API_PROXY_PID}" ]]; then
    kill "${API_PROXY_PID}" >/dev/null 2>&1 || true
    wait "${API_PROXY_PID}" 2>/dev/null || true
  fi
  if [[ "${status}" -ne 0 && "${CLUSTER_CREATED}" -eq 1 ]]; then
    diagnostics
  fi
  if [[ "${CLUSTER_CREATED}" -eq 1 ]]; then
    if ! kind delete cluster --name "${CLUSTER_NAME}" >/dev/null; then
      echo "failed to delete kind cluster: ${CLUSTER_NAME}" >&2
      if [[ "${status}" -eq 0 ]]; then
        status=1
      fi
    fi
  fi
  rm -rf -- "${WORK_DIR:?}"
  exit "${status}"
}
trap cleanup EXIT

if kind get clusters 2>/dev/null | grep -Fxq "${CLUSTER_NAME}"; then
  echo "kind cluster already exists; choose a different RAIBITSERVER_LIVE_E2E_CLUSTER: ${CLUSTER_NAME}" >&2
  exit 1
fi

echo "[live-e2e] building production images"
docker build --file apps/api/Dockerfile --tag "${IMAGE_REGISTRY}/raibitserver/api:${IMAGE_TAG}" .
docker build --file services/orchestrator/Dockerfile --tag "${IMAGE_REGISTRY}/raibitserver/orchestrator:${IMAGE_TAG}" .
docker build --file services/provisioner/Dockerfile --tag "${IMAGE_REGISTRY}/raibitserver/provisioner:${IMAGE_TAG}" .

echo "[live-e2e] creating pinned kind cluster"
kind create cluster --name "${CLUSTER_NAME}" --image "${KIND_NODE_IMAGE}" --wait 180s
CLUSTER_CREATED=1
KUBE_CONTEXT="kind-${CLUSTER_NAME}"

kind load docker-image "${IMAGE_REGISTRY}/raibitserver/api:${IMAGE_TAG}" --name "${CLUSTER_NAME}"
kind load docker-image "${IMAGE_REGISTRY}/raibitserver/orchestrator:${IMAGE_TAG}" --name "${CLUSTER_NAME}"
kind load docker-image "${IMAGE_REGISTRY}/raibitserver/provisioner:${IMAGE_TAG}" --name "${CLUSTER_NAME}"
docker exec "${CLUSTER_NAME}-control-plane" crictl pull "${POSTGRES_IMAGE}"

kubectl --context "${KUBE_CONTEXT}" create namespace "${CONTROL_PLANE_NAMESPACE}"
kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  labels:
    app.kubernetes.io/name: raibitserver-postgres
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: raibitserver-postgres
  template:
    metadata:
      labels:
        app.kubernetes.io/name: raibitserver-postgres
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 70
        runAsGroup: 70
        fsGroup: 70
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: postgres
          image: ${POSTGRES_IMAGE}
          imagePullPolicy: IfNotPresent
          env:
            - { name: POSTGRES_USER, value: ${POSTGRES_USER} }
            - { name: POSTGRES_PASSWORD, value: ${POSTGRES_PASSWORD} }
            - { name: POSTGRES_DB, value: ${POSTGRES_DATABASE} }
            - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }
          ports:
            - { name: postgres, containerPort: 5432 }
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "${POSTGRES_USER}", "-d", "${POSTGRES_DATABASE}"]
            periodSeconds: 2
            timeoutSeconds: 2
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: "1", memory: 512Mi }
          securityContext:
            allowPrivilegeEscalation: false
            runAsNonRoot: true
            runAsUser: 70
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data }
      volumes:
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  labels:
    app.kubernetes.io/name: raibitserver-postgres
spec:
  selector:
    app.kubernetes.io/name: raibitserver-postgres
  ports:
    - { name: postgres, port: 5432, targetPort: postgres }
EOF

kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" rollout status deployment/postgres --timeout=180s

DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres.${CONTROL_PLANE_NAMESPACE}.svc.cluster.local:5432/${POSTGRES_DATABASE}"
kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" create secret generic raibitserver-control-plane-database \
  --from-literal="DATABASE_URL=${DATABASE_URL}"
kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" create secret generic raibitserver-api-runtime \
  --from-literal="RAIBITSERVER_AUTH_JWT_SECRET=live-e2e-jwt-secret-at-least-32-characters" \
  --from-literal="RAIBITSERVER_SECRET_ENCRYPTION_KEY=live-e2e-encryption-key-at-least-32-characters" \
  --from-literal="RAIBITSERVER_EMAIL_WEBHOOK_URL=https://mailer.example.test/v1/verification" \
  --from-literal="RAIBITSERVER_EMAIL_FROM=RAIBITSERVER <email-verification@example.test>"

# Live health checks are scheduled explicitly below. The long interval keeps
# the worker quiescent between a completed check and its intentional restart.
echo "[live-e2e] installing the real Helm chart and running its migration hook"
helm upgrade --install "${RELEASE_NAME}" infra/helm/raibitserver \
  --kube-context "${KUBE_CONTEXT}" \
  --namespace "${CONTROL_PLANE_NAMESPACE}" \
  --set-string "image.registry=${IMAGE_REGISTRY}" \
  --set-string "image.tag=${IMAGE_TAG}" \
  --set image.pullPolicy=IfNotPresent \
  --set api.replicas=1 \
  --set api.pdb.enabled=false \
  --set dashboard.enabled=false \
  --set ingress.enabled=false \
  --set builder.replicas=0 \
  --set orchestrator.replicas=0 \
  --set orchestrator.execute=true \
  --set orchestrator.reconcileIntervalSeconds=1 \
  --set provisioner.replicas=1 \
  --set provisioner.execute=true \
  --set provisioner.reconcileIntervalSeconds=1 \
  --set provisioner.healthIntervalSeconds=300 \
  --set-string "provisioner.providerImages.postgresql=${POSTGRES_IMAGE}" \
  --wait \
  --timeout 10m

API_DEPLOYMENT="${RELEASE_NAME}-raibitserver-api"
ORCHESTRATOR_DEPLOYMENT="${RELEASE_NAME}-raibitserver-orchestrator"
PROVISIONER_DEPLOYMENT="${RELEASE_NAME}-raibitserver-provisioner"
API_SERVICE="${RELEASE_NAME}-raibitserver-api"

kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" rollout status \
  "deployment/${API_DEPLOYMENT}" --timeout=180s
kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" rollout status \
  "deployment/${PROVISIONER_DEPLOYMENT}" --timeout=180s

echo "[live-e2e] verifying orchestrator ResourceQuota and Ingress admission contracts"
ORCHESTRATOR_USER="system:serviceaccount:${CONTROL_PLANE_NAMESPACE}:${RELEASE_NAME}-raibitserver-orchestrator"
kubectl --context "${KUBE_CONTEXT}" --as "${ORCHESTRATOR_USER}" create -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${ADMISSION_TENANT_NAMESPACE}
  labels:
    app.kubernetes.io/managed-by: raibitserver
    raibitserver.io/managed: "true"
    raibitserver.io/namespace-kind: application
    raibitserver.io/project: live-admission-project
    raibitserver.io/project-id: live-admission-project
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
EOF
kubectl --context "${KUBE_CONTEXT}" --as "${ORCHESTRATOR_USER}" create -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-resource-budget
  namespace: ${ADMISSION_TENANT_NAMESPACE}
  labels:
    app.kubernetes.io/managed-by: raibitserver
    raibitserver.io/managed: "true"
    raibitserver.io/namespace-kind: application
    raibitserver.io/project: live-admission-project
    raibitserver.io/project-id: live-admission-project
    raibitserver.io/resource-kind: tenant-resource-quota
spec:
  hard:
    resourcequotas: "1"
    pods: "100"
    count/pods: "200"
    count/deployments.apps: "50"
    count/replicasets.apps: "200"
    count/statefulsets.apps: "50"
    count/jobs.batch: "100"
    count/cronjobs.batch: "50"
    services: "100"
    persistentvolumeclaims: "50"
    secrets: "200"
    configmaps: "100"
    count/ingresses.networking.k8s.io: "100"
    count/networkpolicies.networking.k8s.io: "200"
    requests.cpu: "50"
    requests.memory: 100Gi
    requests.ephemeral-storage: 100Gi
    limits.cpu: "100"
    limits.memory: 200Gi
    limits.ephemeral-storage: 200Gi
    requests.storage: 1Ti
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: ${ADMISSION_TENANT_NAMESPACE}
  labels:
    app.kubernetes.io/name: web
    app.kubernetes.io/managed-by: raibitserver
    raibitserver.io/managed: "true"
    raibitserver.io/project: live-admission-project
    raibitserver.io/service: web
    raibitserver.io/deployment: live-admission-deployment
    raibitserver.io/project-id: live-admission-project
    raibitserver.io/service-id: live-admission-service
    raibitserver.io/deployment-id: live-admission-deployment
  annotations:
    raibitserver.io/hostname: apps--live-admission--project.example.test
spec:
  ingressClassName: nginx
  rules:
    - host: apps--live-admission--project.example.test
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 8080
EOF
kubectl --context "${KUBE_CONTEXT}" --as "${ORCHESTRATOR_USER}" \
  --namespace "${ADMISSION_TENANT_NAMESPACE}" patch ingress web \
  --type merge \
  --patch '{"metadata":{"labels":{"raibitserver.io/deployment":"live-admission-deployment-next","raibitserver.io/deployment-id":"live-admission-deployment-next"}}}' \
  --dry-run=server >/dev/null
if kubectl --context "${KUBE_CONTEXT}" --as "${ORCHESTRATOR_USER}" \
  --namespace "${ADMISSION_TENANT_NAMESPACE}" patch ingress web \
  --type merge --patch '{"metadata":{"labels":{"raibitserver.io/service-id":"attacker"}}}' \
  --dry-run=server >/dev/null 2>&1; then
  echo "orchestrator Ingress admission accepted a changed service owner" >&2
  exit 1
fi
if kubectl --context "${KUBE_CONTEXT}" --as "${ORCHESTRATOR_USER}" \
  --namespace "${ADMISSION_TENANT_NAMESPACE}" patch resourcequota tenant-resource-budget \
  --type merge --patch '{"spec":{"hard":{"pods":"101"}}}' --dry-run=server >/dev/null 2>&1; then
  echo "orchestrator ResourceQuota admission accepted a modified hard budget" >&2
  exit 1
fi
if kubectl --context "${KUBE_CONTEXT}" --as "${ORCHESTRATOR_USER}" \
  --namespace "${ADMISSION_TENANT_NAMESPACE}" patch ingress web \
  --type merge --patch '{"spec":{"ingressClassName":"attacker"}}' --dry-run=server >/dev/null 2>&1; then
  echo "orchestrator Ingress admission accepted an untrusted class" >&2
  exit 1
fi

psql_value() {
  kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" exec deployment/postgres -- \
    env "PGPASSWORD=${POSTGRES_PASSWORD}" psql --host=127.0.0.1 --username "${POSTGRES_USER}" \
      --dbname "${POSTGRES_DATABASE}" --tuples-only --no-align --command "$1" | tr -d '[:space:]'
}

force_provider_health_check_due() {
  psql_value "WITH scheduled AS (
    UPDATE \"Resource\"
    SET \"updatedAt\" = clock_timestamp() AT TIME ZONE 'UTC' - interval '301 seconds'
    WHERE id = 'live-postgresql' AND status = 'READY'
    RETURNING id
  ) SELECT COUNT(*) FROM scheduled;"
}

migration_count="$(psql_value 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;')"
if [[ ! "${migration_count}" =~ ^[1-9][0-9]*$ ]]; then
  echo "expected the Helm migration hook to apply at least one Prisma migration, got: ${migration_count}" >&2
  exit 1
fi

echo "[live-e2e] provisioning and authenticating a real managed PostgreSQL resource"
kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" exec -i deployment/postgres -- \
  env "PGPASSWORD=${POSTGRES_PASSWORD}" psql --host=127.0.0.1 --username "${POSTGRES_USER}" \
    --dbname "${POSTGRES_DATABASE}" --set ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "Organization" (id, name, slug, "updatedAt")
VALUES ('live-provider-org', 'Live Provider Organization', 'live-provider-org', CURRENT_TIMESTAMP);
INSERT INTO "Project" (id, "organizationId", name, slug, status, "updatedAt")
VALUES ('live-provider-project', 'live-provider-org', 'Live Provider Project', 'live-provider-project', 'ACTIVE', CURRENT_TIMESTAMP);
INSERT INTO "Resource" (id, "projectId", name, slug, type, engine, provider, plan, region, status, "desiredSpec", "desiredState", "updatedAt")
VALUES ('live-postgresql', 'live-provider-project', 'Live PostgreSQL', 'live-postgresql', 'database', 'postgresql', 'raibitserver', 'shared-small', 'local', 'provisioning', '{"databaseName":"live_app","storageGb":1}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP);
SQL

provider_ready=0
provider_status=""
for _ in $(seq 1 180); do
  provider_status="$(psql_value "SELECT status FROM \"Resource\" WHERE id = 'live-postgresql';")"
  if [[ "${provider_status}" == "READY" ]]; then
    provider_ready=1
    break
  fi
  if [[ "${provider_status}" == "FAILED" ]]; then
    break
  fi
  sleep 1
done
if [[ "${provider_ready}" -ne 1 ]]; then
  echo "managed PostgreSQL did not reach READY; last status: ${provider_status}" >&2
  exit 1
fi

PROVIDER_SECRET="$(psql_value "SELECT COALESCE(\"connectionSecretName\", '') FROM \"Resource\" WHERE id = 'live-postgresql';")"
PROVIDER_NAME="${PROVIDER_SECRET%-connection}"
if [[ -z "${PROVIDER_SECRET}" || "${PROVIDER_NAME}" == "${PROVIDER_SECRET}" ]]; then
  echo "managed PostgreSQL READY transition did not persist its Secret identity" >&2
  exit 1
fi
kubectl --context "${KUBE_CONTEXT}" --namespace "${PROVIDER_TENANT_NAMESPACE}" rollout status \
  "statefulset/${PROVIDER_NAME}" --timeout=180s
if [[ "$(kubectl --context "${KUBE_CONTEXT}" --namespace "${PROVIDER_TENANT_NAMESPACE}" get pvc "${PROVIDER_NAME}-data" --output jsonpath='{.spec.resources.requests.storage}')" != "1Gi" ]]; then
  echo "managed PostgreSQL PVC did not preserve desiredSpec.storageGb" >&2
  exit 1
fi
if [[ "$(kubectl --context "${KUBE_CONTEXT}" --namespace "${PROVIDER_TENANT_NAMESPACE}" get secret "${PROVIDER_SECRET}" --output jsonpath='{.immutable}')" != "true" ]]; then
  echo "managed PostgreSQL credential Secret is not immutable" >&2
  exit 1
fi
if [[ "$(kubectl --context "${KUBE_CONTEXT}" --namespace "${PROVIDER_TENANT_NAMESPACE}" get rolebinding "${RELEASE_NAME}-raibitserver-provisioner-tenant-access" --output jsonpath='{.roleRef.name}')" != "${RELEASE_NAME}-raibitserver-provisioner-tenant" ]]; then
  echo "managed namespace does not have the exact provisioner tenant RoleBinding" >&2
  exit 1
fi
if [[ "$(kubectl --context "${KUBE_CONTEXT}" --namespace "${PROVIDER_TENANT_NAMESPACE}" get statefulset "${PROVIDER_NAME}" --output jsonpath='{.spec.template.metadata.annotations.raibitserver\.io/verify-image-signatures}')" != "required" ]]; then
  echo "managed PostgreSQL Pod template did not request external image signature verification" >&2
  exit 1
fi
kubectl --context "${KUBE_CONTEXT}" --namespace "${PROVIDER_TENANT_NAMESPACE}" exec \
	"statefulset/${PROVIDER_NAME}" -- sh -ec \
  'test "$(psql --host=127.0.0.1 --port="$PGPORT" --username="$PGUSER" --dbname="$PGDATABASE" --tuples-only --no-align --command="SELECT 1")" = "1"'

previous_health_checked_at="$(psql_value "SELECT COALESCE(\"desiredState\"->>'healthCheckedAt', '') FROM \"Resource\" WHERE id = 'live-postgresql';")"
if [[ "$(force_provider_health_check_due)" != "1" ]]; then
  echo "managed PostgreSQL was not READY when scheduling authenticated health reconciliation" >&2
  exit 1
fi
health_status=""
health_checked_at=""
for _ in $(seq 1 60); do
  health_observation="$(psql_value "SELECT status || '|' || COALESCE(\"desiredState\"->>'healthCheckedAt', '') FROM \"Resource\" WHERE id = 'live-postgresql';")"
  health_status="${health_observation%%|*}"
  health_checked_at="${health_observation#*|}"
  if [[ "${health_status}" == "READY" && -n "${health_checked_at}" && "${health_checked_at}" != "${previous_health_checked_at}" ]]; then
    break
  fi
  sleep 1
done
if [[ "${health_status}" != "READY" || -z "${health_checked_at}" || "${health_checked_at}" == "${previous_health_checked_at}" ]]; then
  echo "managed PostgreSQL did not complete the scheduled authenticated health reconciliation" >&2
  exit 1
fi

echo "[live-e2e] proving same-name credential replacement is rejected by UID"
PERSISTED_PROVIDER_SECRET_UID="$(psql_value "SELECT COALESCE(\"desiredState\"->>'credentialSecretUID', '') FROM \"Resource\" WHERE id = 'live-postgresql';")"
LIVE_PROVIDER_SECRET_UID="$(kubectl --context "${KUBE_CONTEXT}" --namespace "${PROVIDER_TENANT_NAMESPACE}" get secret "${PROVIDER_SECRET}" --output jsonpath='{.metadata.uid}')"
if [[ -z "${PERSISTED_PROVIDER_SECRET_UID}" || "${PERSISTED_PROVIDER_SECRET_UID}" != "${LIVE_PROVIDER_SECRET_UID}" ]]; then
  echo "managed PostgreSQL did not persist the exact credential Secret UID" >&2
  exit 1
fi

echo "[live-e2e] proving credential Secret crash recovery through metadata-only dry-run PATCH"
PERSISTED_PROVIDER_SECRET_GENERATION="$(psql_value "SELECT COALESCE(\"desiredState\"->>'credentialSecretGeneration', '') FROM \"Resource\" WHERE id = 'live-postgresql';")"
if [[ ! "${PERSISTED_PROVIDER_SECRET_GENERATION}" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
  echo "managed PostgreSQL did not reserve a valid credential Secret generation" >&2
  exit 1
fi
if [[ "$(psql_value "WITH scheduled AS (UPDATE \"Resource\" SET status = 'PROVISIONING', \"desiredState\" = \"desiredState\" - 'credentialSecretUID', \"updatedAt\" = clock_timestamp() AT TIME ZONE 'UTC' WHERE id = 'live-postgresql' AND status = 'READY' RETURNING id) SELECT count(*) FROM scheduled;")" != "1" ]]; then
  echo "managed PostgreSQL was not READY when scheduling credential crash recovery" >&2
  exit 1
fi
recovered_secret_observation=""
for _ in $(seq 1 120); do
  recovered_secret_observation="$(psql_value "SELECT status || '|' || COALESCE(\"desiredState\"->>'credentialSecretUID', '') FROM \"Resource\" WHERE id = 'live-postgresql';")"
  if [[ "${recovered_secret_observation}" == "READY|${LIVE_PROVIDER_SECRET_UID}" ]]; then
    break
  fi
  sleep 1
done
if [[ "${recovered_secret_observation}" != "READY|${LIVE_PROVIDER_SECRET_UID}" ]]; then
  echo "metadata-only credential Secret recovery did not restore the exact UID: ${recovered_secret_observation}" >&2
  exit 1
fi

kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" scale deployment \
  "${PROVISIONER_DEPLOYMENT}" --replicas=0
kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" rollout status \
  "deployment/${PROVISIONER_DEPLOYMENT}" --timeout=180s
if [[ "$(psql_value "SELECT status FROM \"Resource\" WHERE id = 'live-postgresql';")" != "READY" ]]; then
  echo "provisioner scale-down interrupted an active health claim" >&2
  exit 1
fi

cat >"${WORK_DIR}/provider-secret-delete.json" <<EOF
{"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":"${LIVE_PROVIDER_SECRET_UID}"},"propagationPolicy":"Background"}
EOF
wrong_password="wrong-provider-password"
provider_host="${PROVIDER_NAME}.${PROVIDER_TENANT_NAMESPACE}.svc.cluster.local"
b64() { printf '%s' "$1" | base64 | tr -d '\r\n'; }
cat >"${WORK_DIR}/provider-secret-replacement.json" <<EOF
{
  "apiVersion":"v1",
  "kind":"Secret",
  "metadata":{
    "name":"${PROVIDER_SECRET}",
    "namespace":"${PROVIDER_TENANT_NAMESPACE}",
    "labels":{
      "app.kubernetes.io/name":"${PROVIDER_NAME}",
      "app.kubernetes.io/managed-by":"raibitserver",
      "raibitserver.io/managed":"true",
      "raibitserver.io/project-id":"live-provider-project",
      "raibitserver.io/resource-id":"live-postgresql",
      "raibitserver.io/provider":"postgresql"
    },
    "annotations":{
      "raibitserver.io/credential-owner":"raibitserver-provisioner",
      "raibitserver.io/credential-generation":"${PERSISTED_PROVIDER_SECRET_GENERATION}",
      "raibitserver.io/resource-id":"live-postgresql",
      "raibitserver.io/project-id":"live-provider-project"
    }
  },
  "type":"Opaque",
  "immutable":true,
  "data":{
    "DATABASE_URL":"$(b64 "postgresql://replacement:${wrong_password}@${provider_host}:5432/live_app")",
    "POSTGRES_URL":"$(b64 "postgresql://replacement:${wrong_password}@${provider_host}:5432/live_app")",
    "PGHOST":"$(b64 "${provider_host}")",
    "PGPORT":"$(b64 "5432")",
    "PGDATABASE":"$(b64 "live_app")",
    "PGUSER":"$(b64 "replacement")",
    "PGPASSWORD":"$(b64 "${wrong_password}")",
    "POSTGRES_DB":"$(b64 "live_app")",
    "POSTGRES_USER":"$(b64 "replacement")",
    "POSTGRES_PASSWORD":"$(b64 "${wrong_password}")"
  }
}
EOF

kubectl --context "${KUBE_CONTEXT}" proxy --port=18081 >"${WORK_DIR}/kubernetes-api-proxy.log" 2>&1 &
API_PROXY_PID=$!
for _ in $(seq 1 30); do
  if curl --fail --silent --output /dev/null http://127.0.0.1:18081/version; then
    break
  fi
  sleep 1
done
PROVISIONER_USER="system:serviceaccount:${CONTROL_PLANE_NAMESPACE}:${RELEASE_NAME}-raibitserver-provisioner"
curl --fail --silent --show-error --output /dev/null \
  --request DELETE \
  --header "Content-Type: application/json" \
  --header "Impersonate-User: ${PROVISIONER_USER}" \
  --data-binary @"${WORK_DIR}/provider-secret-delete.json" \
  "http://127.0.0.1:18081/api/v1/namespaces/${PROVIDER_TENANT_NAMESPACE}/secrets/${PROVIDER_SECRET}"
kubectl --context "${KUBE_CONTEXT}" --namespace "${PROVIDER_TENANT_NAMESPACE}" wait \
  --for=delete "secret/${PROVIDER_SECRET}" --timeout=60s
curl --fail --silent --show-error --output /dev/null \
  --request POST \
  --header "Content-Type: application/json" \
  --header "Impersonate-User: ${PROVISIONER_USER}" \
  --data-binary @"${WORK_DIR}/provider-secret-replacement.json" \
  "http://127.0.0.1:18081/api/v1/namespaces/${PROVIDER_TENANT_NAMESPACE}/secrets"
REPLACEMENT_PROVIDER_SECRET_UID="$(kubectl --context "${KUBE_CONTEXT}" --namespace "${PROVIDER_TENANT_NAMESPACE}" get secret "${PROVIDER_SECRET}" --output jsonpath='{.metadata.uid}')"
if [[ -z "${REPLACEMENT_PROVIDER_SECRET_UID}" || "${REPLACEMENT_PROVIDER_SECRET_UID}" == "${LIVE_PROVIDER_SECRET_UID}" ]]; then
  echo "credential replacement did not produce a distinct Kubernetes UID" >&2
  exit 1
fi

if [[ "$(force_provider_health_check_due)" != "1" ]]; then
  echo "managed PostgreSQL was not READY when scheduling replacement credential health reconciliation" >&2
  exit 1
fi

kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" scale deployment \
  "${PROVISIONER_DEPLOYMENT}" --replicas=1
kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" rollout status \
  "deployment/${PROVISIONER_DEPLOYMENT}" --timeout=180s
replacement_status=""
for _ in $(seq 1 60); do
  replacement_status="$(psql_value "SELECT status FROM \"Resource\" WHERE id = 'live-postgresql';")"
  if [[ "${replacement_status}" == "FAILED" ]]; then
    break
  fi
  sleep 1
done
if [[ "${replacement_status}" != "FAILED" ]]; then
  replacement_diagnostics="$(psql_value "SELECT json_build_object(
    'healthStatus', COALESCE(\"desiredState\"->>'healthStatus', ''),
    'healthFailureCount', COALESCE(\"desiredState\"->>'healthFailureCount', ''),
    'lastHealthError', COALESCE(\"desiredState\"->>'lastHealthError', ''),
    'updatedAt', \"updatedAt\")::text FROM \"Resource\" WHERE id = 'live-postgresql';")"
  echo "same-name credential replacement was not rejected by the persisted UID fence: status=${replacement_status}; state=${replacement_diagnostics}" >&2
  exit 1
fi

echo "[live-e2e] verifying PostgreSQL controller lease and recovery precision"
kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" port-forward \
  deployment/postgres 15432:5432 >"${WORK_DIR}/postgres-port-forward.log" 2>&1 &
POSTGRES_PORT_FORWARD_PID=$!
postgres_forward_ready=0
for _ in $(seq 1 30); do
  if (exec 3<>/dev/tcp/127.0.0.1/15432) 2>/dev/null; then
    postgres_forward_ready=1
    break
  fi
  if ! kill -0 "${POSTGRES_PORT_FORWARD_PID}" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [[ "${postgres_forward_ready}" -ne 1 ]]; then
  cat "${WORK_DIR}/postgres-port-forward.log" >&2
  echo "PostgreSQL port-forward did not become available" >&2
  exit 1
fi
(
  cd services/orchestrator
  RAIBITSERVER_TEST_POSTGRES_DSN="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:15432/${POSTGRES_DATABASE}?sslmode=disable" \
    go test -count=1 -run '^TestPostgresDeletionLeaseUsesStoredTimestamp$' ./internal/store
)
(
  cd services/builder
  RAIBITSERVER_TEST_POSTGRES_DSN="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:15432/${POSTGRES_DATABASE}?sslmode=disable" \
    go test -count=1 -run '^TestPostgresClaimReapsExpiredExhaustedBuild$' ./internal/controlplane
)
(
  cd services/provisioner
  RAIBITSERVER_TEST_POSTGRES_DSN="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:15432/${POSTGRES_DATABASE}?sslmode=disable" \
    go test -count=1 -run '^TestPostgresReadyProviderReplacementTransitionsToFailed$' ./internal/reconciler
)
kill "${POSTGRES_PORT_FORWARD_PID}" >/dev/null 2>&1 || true
wait "${POSTGRES_PORT_FORWARD_PID}" 2>/dev/null || true
POSTGRES_PORT_FORWARD_PID=""

kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" port-forward \
  "service/${API_SERVICE}" 18080:3000 >"${WORK_DIR}/api-port-forward.log" 2>&1 &
PORT_FORWARD_PID=$!
health_response=""
for _ in $(seq 1 60); do
  if health_response="$(curl --fail --silent --show-error http://127.0.0.1:18080/api/health 2>/dev/null)"; then
    break
  fi
  sleep 1
done
if [[ -z "${health_response}" ]]; then
  cat "${WORK_DIR}/api-port-forward.log" >&2
  echo "API health endpoint did not become available" >&2
  exit 1
fi
echo "[live-e2e] API health: ${health_response}"

echo "[live-e2e] seeding a Kubernetes namespace and its delete-requested DB project"
kubectl --context "${KUBE_CONTEXT}" create namespace "${TENANT_NAMESPACE}"
kubectl --context "${KUBE_CONTEXT}" label namespace "${TENANT_NAMESPACE}" \
  app.kubernetes.io/managed-by=raibitserver \
  raibitserver.io/managed=true \
  raibitserver.io/namespace-kind=application \
  raibitserver.io/project=live-project \
  raibitserver.io/project-id=live-project \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted
kubectl --context "${KUBE_CONTEXT}" --namespace "${TENANT_NAMESPACE}" create configmap live-deletion-sentinel \
  --from-literal=expected=deleted-by-orchestrator
kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" exec -i deployment/postgres -- \
  env "PGPASSWORD=${POSTGRES_PASSWORD}" psql --host=127.0.0.1 --username "${POSTGRES_USER}" \
    --dbname "${POSTGRES_DATABASE}" --set ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "Organization" (id, name, slug, "updatedAt")
VALUES ('live-org', 'Live E2E Organization', 'live-org', CURRENT_TIMESTAMP);
INSERT INTO "Project" (id, "organizationId", name, slug, status, "deletionRequestedAt", "updatedAt")
VALUES ('live-project', 'live-org', 'Live E2E Project', 'live-project', 'DELETE_REQUESTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
SQL

project_count="$(psql_value 'SELECT COUNT(*) FROM "Project" WHERE id = '\''live-project'\'';')"
if [[ "${project_count}" != "1" ]]; then
  echo "expected the delete-requested project seed to exist before worker start" >&2
  exit 1
fi
kubectl --context "${KUBE_CONTEXT}" get namespace "${TENANT_NAMESPACE}" >/dev/null

echo "[live-e2e] starting the real orchestrator execution path"
kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" scale deployment \
  "${ORCHESTRATOR_DEPLOYMENT}" --replicas=1
kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" rollout status \
  "deployment/${ORCHESTRATOR_DEPLOYMENT}" --timeout=180s

transition_complete=0
for _ in $(seq 1 120); do
  project_count="$(psql_value 'SELECT COUNT(*) FROM "Project" WHERE id = '\''live-project'\'';')"
  if [[ "${project_count}" == "0" ]] && \
    ! kubectl --context "${KUBE_CONTEXT}" get namespace "${TENANT_NAMESPACE}" >/dev/null 2>&1; then
    transition_complete=1
    break
  fi
  sleep 1
done
if [[ "${transition_complete}" -ne 1 ]]; then
  echo "orchestrator did not delete both the DB project and Kubernetes namespace" >&2
  exit 1
fi

worker_log_verified=0
orchestrator_logs=""
for _ in $(seq 1 30); do
  orchestrator_logs="$(kubectl --context "${KUBE_CONTEXT}" --namespace "${CONTROL_PLANE_NAMESPACE}" logs \
    "deployment/${ORCHESTRATOR_DEPLOYMENT}" --all-containers 2>/dev/null || true)"
  if grep -F '"reason":"project_deleted"' <<<"${orchestrator_logs}" >/dev/null && \
    grep -F '"dryRun":false' <<<"${orchestrator_logs}" >/dev/null; then
    worker_log_verified=1
    break
  fi
  sleep 1
done
if [[ "${worker_log_verified}" -ne 1 ]]; then
  echo "orchestrator state transition completed without the expected execution log" >&2
  printf '%s\n' "${orchestrator_logs}" >&2
  exit 1
fi

echo "[live-e2e] PASS: kind/Helm reconciliation verified API migration/health, orchestrator admission, managed PostgreSQL, builder exhausted-lease recovery, and orchestrator deletion; tenant BuildKit/registry lifecycle not covered"
