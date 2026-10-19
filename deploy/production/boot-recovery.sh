#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[raibitserver-boot-recovery] %s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

for command_name in systemctl kubectl python3 sleep; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command not found: $command_name"
done

: "${KUBECONFIG:?KUBECONFIG is required}"
[[ -r "$KUBECONFIG" ]] || fail "kubeconfig is not readable"

NAMESPACE="${RAIBITSERVER_NAMESPACE:-raibitserver-system}"
HOST_SERVICES="${RAIBITSERVER_BOOT_SERVICES:-docker.service k3s.service}"
read -r -a services <<<"$HOST_SERVICES"
for service in "${services[@]}"; do
  [[ "$service" =~ ^[A-Za-z0-9@_.-]+\.service$ ]] || fail "invalid host service name"
  systemctl is-active --quiet "$service" || fail "$service is not active"
done

# The first check is bounded; systemd retries this oneshot on failure. Kubernetes
# retains the desired workloads and their persistent volumes across a host reboot.
ready=0
for ((attempt = 1; attempt <= 60; attempt++)); do
  if kubectl --request-timeout=5s get --raw=/readyz >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 5
done
[[ "$ready" == 1 ]] || fail "Kubernetes API did not become ready"

kubectl wait --for=condition=Ready node --all --timeout=5m \
  || fail "Kubernetes nodes did not become ready"

kubectl -n "$NAMESPACE" wait --for=condition=Available \
  deployment/raibitserver-api \
  deployment/raibitserver-dashboard \
  deployment/raibitserver-orchestrator \
  deployment/raibitserver-provisioner \
  --timeout=8m || fail "control-plane deployments did not become available"

api_pod="$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=api -o json \
  | python3 -c '
import json
import sys

for pod in json.load(sys.stdin).get("items", []):
    if pod.get("status", {}).get("phase") != "Running":
        continue
    if any(condition.get("type") == "Ready" and condition.get("status") == "True"
           for condition in pod.get("status", {}).get("conditions", [])):
        print(pod.get("metadata", {}).get("name", ""))
        break
')" || fail "could not inspect API Pods"
[[ -n "$api_pod" ]] || fail "no ready API Pod exists"

kubectl -n "$NAMESPACE" exec "$api_pod" -c api -- node -e '
const { PrismaClient } = require("@prisma/client");
const client = new PrismaClient();
const deadline = setTimeout(() => {
  console.error("DB_QUERY_FAILED timeout");
  process.exit(2);
}, 15000);
(async () => {
  try {
    await client.$queryRawUnsafe("SELECT 1");
    console.log("DB_QUERY_OK");
  } catch (error) {
    console.error(`DB_QUERY_FAILED ${error.code || error.name}`);
    process.exitCode = 1;
  } finally {
    await client.$disconnect();
    clearTimeout(deadline);
  }
})();
' || fail "control-plane database is not reachable from the API Pod"

log "host services, Kubernetes workloads, and API database connection recovered"
