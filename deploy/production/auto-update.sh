#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

log() {
  printf '[raibitserver-auto-update] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

valid_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

valid_digest() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]
}

valid_input_digest() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]]
}

deployment_input_digest() {
  python3 - "$1" "$2" <<'PY'
from pathlib import Path
import hashlib
import sys

base_values = Path(sys.argv[1])
overlay_path = sys.argv[2]
digest = hashlib.sha256()
digest.update(b'production-values\0')
digest.update(base_values.read_bytes())
digest.update(b'workload-registry-values\0')
if overlay_path:
    digest.update(Path(overlay_path).read_bytes())
else:
    digest.update(b'absent')
print(digest.hexdigest())
PY
}

snapshot_registry_values() {
  local source="$1"
  local destination="$2"
  python3 - "$HOME" "$source" "$destination" <<'PY'
import os
from pathlib import Path
import stat
import sys

home = Path(sys.argv[1])
source = Path(sys.argv[2])
destination = Path(sys.argv[3])
euid = os.geteuid()

home_stat = home.lstat()
if not stat.S_ISDIR(home_stat.st_mode) or home.is_symlink():
    raise SystemExit(f'updater home must be a real directory: {home}')
if home_stat.st_uid != euid:
    raise SystemExit(f'updater home is not owned by the updater user: {home}')
if home_stat.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
    raise SystemExit(f'updater home must not be group/world writable: {home}')

if not source.is_absolute():
    raise SystemExit(f'workload registry values path must be absolute: {source}')
try:
    relative = source.relative_to(home)
except ValueError:
    raise SystemExit(f'workload registry values must stay below the updater home: {source}') from None
if not relative.parts or any(part in {'', '.', '..'} for part in relative.parts):
    raise SystemExit(f'workload registry values path must be canonical: {source}')

current = home
for part in relative.parts[:-1]:
    current /= part
    current_stat = current.lstat()
    if not stat.S_ISDIR(current_stat.st_mode) or current.is_symlink():
        raise SystemExit(f'workload registry values parent must be a real directory: {current}')
    if current_stat.st_uid != euid:
        raise SystemExit(f'workload registry values parent is not owned by the updater user: {current}')
    if current_stat.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise SystemExit(f'workload registry values parent must not be group/world writable: {current}')

open_flags = os.O_RDONLY | os.O_CLOEXEC
if hasattr(os, 'O_NOFOLLOW'):
    open_flags |= os.O_NOFOLLOW

source_fd = os.open(source, open_flags)
try:
    source_stat = os.fstat(source_fd)
    if not stat.S_ISREG(source_stat.st_mode):
        raise SystemExit(f'workload registry values must be a regular non-symlink file: {source}')
    if source_stat.st_uid != euid:
        raise SystemExit(f'workload registry values are not owned by the updater user: {source}')
    if source_stat.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise SystemExit(f'workload registry values must not be group/world writable: {source}')

    destination_fd = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
        0o600,
    )
    try:
        copied = 0
        while True:
            chunk = os.read(source_fd, 64 * 1024)
            if not chunk:
                break
            copied += len(chunk)
            if copied > 1024 * 1024:
                raise SystemExit('workload registry values exceed the 1 MiB limit')
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                view = view[written:]
        os.fsync(destination_fd)
    finally:
        os.close(destination_fd)
finally:
    os.close(source_fd)
PY
}

registry_state_digest() {
  local observed_dir="${RUN_DIR}/registry-observed"
  mkdir -p "$observed_dir"

  kubectl -n "$REGISTRY_INFRA_NAMESPACE" get deployment raibit-registry-auth -o json \
    >"${observed_dir}/gateway-deployment.json" || return 1
  kubectl -n "$REGISTRY_INFRA_NAMESPACE" get service raibit-registry-auth -o json \
    >"${observed_dir}/gateway-service.json" || return 1
  kubectl -n "$REGISTRY_INFRA_NAMESPACE" get ingress raibit-registry-auth -o json \
    >"${observed_dir}/gateway-ingress.json" || return 1
  kubectl -n "$REGISTRY_INFRA_NAMESPACE" get networkpolicy raibit-registry-auth-ingress -o json \
    >"${observed_dir}/gateway-network-policy.json" || return 1
  kubectl -n "$REGISTRY_INFRA_NAMESPACE" get networkpolicy raibit-registry-ingress -o json \
    >"${observed_dir}/registry-network-policy.json" || return 1
  kubectl -n "$REGISTRY_INFRA_NAMESPACE" get configmap raibit-registry-config -o json \
    >"${observed_dir}/registry-config.json" || return 1
  kubectl -n "$REGISTRY_INFRA_NAMESPACE" get statefulset raibit-registry -o json \
    >"${observed_dir}/registry-statefulset.json" || return 1
  kubectl -n kube-system get configmap coredns -o json \
    >"${observed_dir}/coredns.json" || return 1

  python3 - "$observed_dir" "$WORKLOAD_REGISTRY_HOST" "$WORKLOAD_REGISTRY_AUTH_HOST" <<'PY'
from pathlib import Path
import hashlib
import ipaddress
import json
import re
import sys

root = Path(sys.argv[1])
registry_host, auth_host = sys.argv[2:]

def load(name):
    return json.loads((root / name).read_text())

deployment = load('gateway-deployment.json')
service = load('gateway-service.json')
ingress = load('gateway-ingress.json')
gateway_policy = load('gateway-network-policy.json')
registry_policy = load('registry-network-policy.json')
registry_config = load('registry-config.json')
registry_statefulset = load('registry-statefulset.json')
coredns = load('coredns.json')

if int(deployment.get('status', {}).get('availableReplicas', 0)) < 1:
    raise SystemExit('registry gateway has no available replica')
if int(registry_statefulset.get('status', {}).get('readyReplicas', 0)) < 1:
    raise SystemExit('workload registry has no ready replica')

broker_images = [
    container.get('image', '')
    for container in deployment.get('spec', {}).get('template', {}).get('spec', {}).get('containers', [])
    if container.get('name') == 'broker'
]
if len(broker_images) != 1 or not re.fullmatch(
    r'ghcr\.io/[a-z0-9][a-z0-9._/-]*/registry-broker@sha256:[0-9a-f]{64}',
    broker_images[0],
):
    raise SystemExit('registry broker image is not an exact GHCR digest')

gateway_ip = service.get('spec', {}).get('clusterIP', '')
try:
    ipaddress.ip_address(gateway_ip)
except ValueError as error:
    raise SystemExit('registry gateway has an invalid ClusterIP') from error

config = registry_config.get('data', {}).get('config.yml')
if not isinstance(config, str):
    raise SystemExit('registry config is missing config.yml')
config_digest = hashlib.sha256(config.encode()).hexdigest()
recorded_digest = (
    registry_statefulset.get('spec', {})
    .get('template', {})
    .get('metadata', {})
    .get('annotations', {})
    .get('raibitserver.io/registry-config-sha256')
)
if recorded_digest != config_digest:
    raise SystemExit('registry config checksum does not match the StatefulSet')

node_hosts = coredns.get('data', {}).get('NodeHosts')
if not isinstance(node_hosts, str):
    raise SystemExit('CoreDNS NodeHosts is missing')
matches = []
for line in node_hosts.splitlines():
    parts = line.split()
    if len(parts) >= 2 and ({registry_host, auth_host} & set(parts[1:])):
        matches.append(parts)
if matches != [[gateway_ip, registry_host, auth_host]]:
    raise SystemExit('CoreDNS registry split DNS is not exact')

state = {
    'gatewayDeployment': deployment.get('spec'),
    'gatewayService': service.get('spec'),
    'gatewayIngress': {
        'entrypoints': ingress.get('metadata', {}).get('annotations', {}).get(
            'traefik.ingress.kubernetes.io/router.entrypoints'
        ),
        'spec': ingress.get('spec'),
    },
    'gatewayNetworkPolicy': gateway_policy.get('spec'),
    'registryNetworkPolicy': registry_policy.get('spec'),
    'registryConfig': config,
    'registryConfigDigest': recorded_digest,
    'splitDNS': matches,
}
encoded = json.dumps(state, sort_keys=True, separators=(',', ':')).encode()
print(hashlib.sha256(encoded).hexdigest())
PY
}

registry_runtime_healthy() {
  [[ -f "$REGISTRY_CHECKER" && ! -L "$REGISTRY_CHECKER" ]] || {
    log "CI-approved registry gateway health checker is missing or unsafe"
    return 1
  }
  git -C "$WORKTREE" diff --quiet "$TARGET_SHA" -- "$REGISTRY_CHECKER_REPOSITORY_PATH" || {
    log "registry gateway health checker differs from the CI-approved commit"
    return 1
  }
  bash -n "$REGISTRY_CHECKER" || {
    log "CI-approved registry gateway health checker has invalid Bash syntax"
    return 1
  }

  RAIBITSERVER_IMAGE_PREFIX="$IMAGE_PREFIX" \
  REGISTRY_HOST="$WORKLOAD_REGISTRY_HOST" \
  AUTH_HOST="$WORKLOAD_REGISTRY_AUTH_HOST" \
  REGISTRY_PREFIX="$WORKLOAD_REGISTRY_PREFIX" \
  REGISTRY_SERVICE="$WORKLOAD_REGISTRY_SERVICE" \
  INFRA_NS="$REGISTRY_INFRA_NAMESPACE" \
  APP_NS="$NAMESPACE" \
  BROKER_TOKEN_SECRET="$REGISTRY_BROKER_TOKEN_SECRET" \
    bash "$REGISTRY_CHECKER"
}

control_plane_database_reachable() {
  local pods_json="${RUN_DIR}/database-preflight-pods.json"
  local api_pod

  if ! kubectl -n "$NAMESPACE" get pods \
    -l app.kubernetes.io/component=api \
    -o json >"$pods_json"; then
    log "could not inspect API Pods for the control-plane database preflight"
    return 1
  fi

  api_pod="$(python3 - "$pods_json" <<'PY'
import json
from pathlib import Path
import sys

pods = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')).get('items', [])
for pod in pods:
    ready = any(
        condition.get('type') == 'Ready' and condition.get('status') == 'True'
        for condition in pod.get('status', {}).get('conditions', [])
    )
    if pod.get('status', {}).get('phase') == 'Running' and ready:
        print(pod.get('metadata', {}).get('name', ''))
        break
PY
)"

  if [[ -z "$api_pod" ]]; then
    log "no ready API Pod exists; deferring the database check to the Helm migration hook"
    return 0
  fi

  if ! kubectl -n "$NAMESPACE" exec "$api_pod" -c api -- node -e '
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing");
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
'; then
    log "control-plane database is not reachable from a ready API Pod"
    log "repair host PostgreSQL safely with: bash deploy/production/configure-host-postgres-access.sh"
    return 1
  fi

  log "control-plane database preflight passed"
}

: "${HOME:?HOME is required}"

REPOSITORY="${RAIBITSERVER_GITHUB_REPOSITORY:-jsk1004ha/RaibitServer}"
REPO_URL="${RAIBITSERVER_REPO_URL:-https://github.com/${REPOSITORY}.git}"
BRANCH="${RAIBITSERVER_DEPLOY_BRANCH:-main}"
DEPLOY_ROOT="${RAIBITSERVER_DEPLOY_ROOT:-${HOME}/.local/share/raibitserver-production}"
WORKTREE="${RAIBITSERVER_DEPLOY_WORKTREE:-${DEPLOY_ROOT}/repository}"
STATE_DIR="${RAIBITSERVER_AUTO_UPDATE_STATE_DIR:-${HOME}/.local/state/raibitserver-auto-update}"
VALUES_FILE="${RAIBITSERVER_VALUES_FILE:-${HOME}/production-values.yaml}"
REGISTRY_VALUES_FILE="${HOME}/.config/raibitserver/workload-registry-values.yaml"
REGISTRY_RECONCILER="${WORKTREE}/deploy/production/reconcile-workload-registry-gateway.sh"
REGISTRY_CHECKER_REPOSITORY_PATH="deploy/production/check-workload-registry-gateway.sh"
REGISTRY_CHECKER="${WORKTREE}/${REGISTRY_CHECKER_REPOSITORY_PATH}"
WORKLOAD_REGISTRY_BASE_DOMAIN="${BASE_DOMAIN:-${RAIBITSERVER_BASE_DOMAIN:-raibit.kr}}"
WORKLOAD_REGISTRY_HOST="${REGISTRY_HOST:-registry.${WORKLOAD_REGISTRY_BASE_DOMAIN}}"
WORKLOAD_REGISTRY_AUTH_HOST="${AUTH_HOST:-registry-auth.${WORKLOAD_REGISTRY_BASE_DOMAIN}}"
WORKLOAD_REGISTRY_PREFIX="${REGISTRY_PREFIX:-raibitserver}"
WORKLOAD_REGISTRY_SERVICE="${REGISTRY_SERVICE:-raibit-registry}"
REGISTRY_BROKER_TOKEN_SECRET="${BROKER_TOKEN_SECRET:-raibitserver-registry-broker-token}"
REGISTRY_INFRA_NAMESPACE="${INFRA_NS:-raibitserver-infra}"
KUBECONFIG="${KUBECONFIG:-${RAIBITSERVER_KUBECONFIG:-${HOME}/.kube/config}}"
HELM_RELEASE="${RAIBITSERVER_HELM_RELEASE:-raibitserver}"
NAMESPACE="${RAIBITSERVER_NAMESPACE:-raibitserver-system}"
BUILDX_BUILDER="${RAIBITSERVER_BUILDX_BUILDER:-raibit-prod-builder}"
PLATFORM="${RAIBITSERVER_BUILD_PLATFORM:-linux/amd64}"
IMAGE_PREFIX="${RAIBITSERVER_IMAGE_PREFIX:-ghcr.io/jsk1004ha/raibitserver}"
COSIGN_KEY="${RAIBITSERVER_COSIGN_KEY:-k8s://raibitserver-system/raibitserver-cosign-signing}"
HELM_TIMEOUT="${RAIBITSERVER_HELM_TIMEOUT:-20m}"
GITHUB_API="${RAIBITSERVER_GITHUB_API:-https://api.github.com}"
UPDATER_LIBEXEC_PATH="${RAIBITSERVER_UPDATER_LIBEXEC_PATH:-${HOME}/.local/libexec/raibitserver-production-auto-update}"

export KUBECONFIG

for command_name in git curl jq docker cosign kubectl helm flock python3 awk mktemp mkdir cp chmod cmp mv bash dirname; do
  require_command "$command_name"
done

[[ "$UPDATER_LIBEXEC_PATH" == /* ]] \
  || fail "updater libexec path must be absolute: $UPDATER_LIBEXEC_PATH"

UPDATER_LIBEXEC_DIR="$(dirname -- "$UPDATER_LIBEXEC_PATH")"
python3 - "$UPDATER_LIBEXEC_DIR" "$UPDATER_LIBEXEC_PATH" <<'PY'
import os
from pathlib import Path
import stat
import sys

directory = Path(sys.argv[1])
target = Path(sys.argv[2])

if not directory.is_dir() or directory.is_symlink():
    raise SystemExit(f'updater libexec directory must be a real directory: {directory}')
if directory.resolve(strict=True) != directory:
    raise SystemExit(f'updater libexec directory must be canonical and contain no symlinks: {directory}')
if target.parent != directory or target.name in {'', '.', '..'}:
    raise SystemExit(f'updater libexec target is not a direct child of its directory: {target}')

directory_stat = directory.stat()
if directory_stat.st_uid != os.geteuid():
    raise SystemExit(f'updater libexec directory is not owned by the updater user: {directory}')
if directory_stat.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
    raise SystemExit(f'updater libexec directory must not be group/world writable: {directory}')

if target.exists() or target.is_symlink():
    target_stat = target.lstat()
    if not stat.S_ISREG(target_stat.st_mode) or target.is_symlink():
        raise SystemExit(f'updater libexec target must be a regular non-symlink file: {target}')
    if target_stat.st_uid != os.geteuid():
        raise SystemExit(f'updater libexec target is not owned by the updater user: {target}')
PY

[[ -r "$KUBECONFIG" ]] || fail "kubeconfig is not readable: $KUBECONFIG"
[[ -r "$VALUES_FILE" ]] || fail "production values file is not readable: $VALUES_FILE"
[[ -w "$VALUES_FILE" ]] || fail "production values file is not writable: $VALUES_FILE"

docker buildx inspect "$BUILDX_BUILDER" >/dev/null 2>&1 \
  || fail "docker buildx builder is unavailable: $BUILDX_BUILDER"

mkdir -p "$DEPLOY_ROOT" "$STATE_DIR"
chmod 700 "$DEPLOY_ROOT" "$STATE_DIR"

exec 9>"${STATE_DIR}/update.lock"
if ! flock -n 9; then
  log "another updater instance is already running"
  exit 0
fi

RUN_DIR="$(mktemp -d "${STATE_DIR}/run.XXXXXX")"
cleanup() {
  if [[ -n "${UPDATER_TMP:-}" ]]; then
    rm -f -- "$UPDATER_TMP"
  fi
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

REGISTRY_VALUES_SOURCE=""
REGISTRY_VALUES_SNAPSHOT=""
if [[ -e "$REGISTRY_VALUES_FILE" || -L "$REGISTRY_VALUES_FILE" ]]; then
  REGISTRY_VALUES_SNAPSHOT="${RUN_DIR}/workload-registry-values.yaml"
  snapshot_registry_values "$REGISTRY_VALUES_FILE" "$REGISTRY_VALUES_SNAPSHOT"
  REGISTRY_VALUES_SOURCE="$REGISTRY_VALUES_SNAPSHOT"
  log "using verified workload registry Helm overlay snapshot"
fi

CURRENT_INPUT_DIGEST="$(deployment_input_digest "$VALUES_FILE" "$REGISTRY_VALUES_SOURCE")"
valid_input_digest "$CURRENT_INPUT_DIGEST" \
  || fail "could not calculate a valid deployment input digest"

if [[ ! -d "$WORKTREE/.git" ]]; then
  [[ ! -e "$WORKTREE" ]] || fail "deploy worktree exists but is not a Git repository: $WORKTREE"
  log "creating dedicated production checkout"
  git clone --no-checkout --origin origin "$REPO_URL" "$WORKTREE"
fi

ACTUAL_ORIGIN="$(git -C "$WORKTREE" remote get-url origin)"
[[ "$ACTUAL_ORIGIN" == "$REPO_URL" ]] \
  || fail "deploy checkout origin mismatch: expected $REPO_URL"

TARGET_SHA="$(git ls-remote "$REPO_URL" "refs/heads/${BRANCH}" | awk 'NR == 1 { print $1 }')"
valid_sha "$TARGET_SHA" || fail "could not resolve a valid ${BRANCH} SHA"

DEPLOYED_SHA="$(cat "${STATE_DIR}/deployed-sha" 2>/dev/null || true)"
DEPLOYED_INPUT_DIGEST="$(cat "${STATE_DIR}/deployed-input-digest" 2>/dev/null || true)"
REGISTRY_RECONCILED_SHA="$(cat "${STATE_DIR}/registry-reconciled-sha" 2>/dev/null || true)"
REGISTRY_RECONCILED_INPUT_DIGEST="$(cat "${STATE_DIR}/registry-reconciled-input-digest" 2>/dev/null || true)"
REGISTRY_RECONCILED_STATE_DIGEST="$(cat "${STATE_DIR}/registry-reconciled-state-digest" 2>/dev/null || true)"

REGISTRY_MANAGED=0
if [[ -n "$REGISTRY_VALUES_SNAPSHOT" \
  || -n "$REGISTRY_RECONCILED_SHA" \
  || -n "$REGISTRY_RECONCILED_INPUT_DIGEST" \
  || -n "$REGISTRY_RECONCILED_STATE_DIGEST" ]]; then
  REGISTRY_MANAGED=1
else
  if ! REGISTRY_STATEFULSET_NAME="$(
    kubectl -n "$REGISTRY_INFRA_NAMESPACE" get statefulset raibit-registry \
      --ignore-not-found -o name
  )"; then
    fail "could not determine whether the workload registry is installed"
  fi
  if [[ -n "$REGISTRY_STATEFULSET_NAME" ]]; then
    REGISTRY_MANAGED=1
  fi
fi

PLATFORM_RECONCILE_REQUIRED=1
if [[ "$TARGET_SHA" == "$DEPLOYED_SHA" && "$CURRENT_INPUT_DIGEST" == "$DEPLOYED_INPUT_DIGEST" ]]; then
  PLATFORM_RECONCILE_REQUIRED=0
fi

REGISTRY_RECONCILE_REQUIRED=0
if [[ "$REGISTRY_MANAGED" == 1 ]]; then
  REGISTRY_RECONCILE_REQUIRED=1
  if [[ -n "$REGISTRY_VALUES_SNAPSHOT" \
    && "$TARGET_SHA" == "$REGISTRY_RECONCILED_SHA" \
    && "$CURRENT_INPUT_DIGEST" == "$REGISTRY_RECONCILED_INPUT_DIGEST" \
    && -n "$REGISTRY_RECONCILED_STATE_DIGEST" ]]; then
    if REGISTRY_OBSERVED_STATE_DIGEST="$(registry_state_digest)" \
      && valid_input_digest "$REGISTRY_OBSERVED_STATE_DIGEST" \
      && [[ "$REGISTRY_OBSERVED_STATE_DIGEST" == "$REGISTRY_RECONCILED_STATE_DIGEST" ]] \
      && registry_runtime_healthy; then
      REGISTRY_RECONCILE_REQUIRED=0
    else
      log "registry gateway desired state, token parity, or live broker probe is unhealthy; scheduling repair"
    fi
  fi
fi

if [[ "$PLATFORM_RECONCILE_REQUIRED" == 0 && "$REGISTRY_RECONCILE_REQUIRED" == 0 ]]; then
  log "already running ${TARGET_SHA}"
  exit 0
fi
if [[ "$PLATFORM_RECONCILE_REQUIRED" == 1 && "$TARGET_SHA" == "$DEPLOYED_SHA" ]]; then
  log "deployment inputs changed for ${TARGET_SHA}; reconciling the existing commit"
fi
if [[ "$REGISTRY_RECONCILE_REQUIRED" == 1 ]]; then
  log "registry gateway state is missing or stale; scheduling an exact gateway reconcile"
fi

REJECTED_SHA="$(cat "${STATE_DIR}/rejected-sha" 2>/dev/null || true)"
if [[ "$TARGET_SHA" == "$REJECTED_SHA" ]]; then
  log "${TARGET_SHA} is blocked because its CI run failed"
  exit 0
fi

log "checking CI for ${TARGET_SHA}"
RUNS_JSON="$(
  curl --fail --silent --show-error \
    --connect-timeout 10 \
    --max-time 30 \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -H 'User-Agent: raibitserver-production-auto-updater' \
    "${GITHUB_API}/repos/${REPOSITORY}/actions/runs?head_sha=${TARGET_SHA}&event=push&per_page=20"
)"

CI_RUN="$(
  jq -c --arg sha "$TARGET_SHA" '
    [
      .workflow_runs[]?
      | select(.head_sha == $sha)
      | select(.path == ".github/workflows/ci.yml" or .name == "CI")
    ]
    | sort_by(.run_number)
    | last // empty
  ' <<<"$RUNS_JSON"
)"

if [[ -z "$CI_RUN" ]]; then
  log "CI run for ${TARGET_SHA} is not available yet; waiting for the next timer run"
  exit 0
fi

CI_STATUS="$(jq -r '.status // ""' <<<"$CI_RUN")"
CI_CONCLUSION="$(jq -r '.conclusion // ""' <<<"$CI_RUN")"
CI_RUN_ID="$(jq -r '.id // ""' <<<"$CI_RUN")"

if [[ "$CI_STATUS" != "completed" ]]; then
  log "CI run ${CI_RUN_ID} is ${CI_STATUS:-unknown}; waiting"
  exit 0
fi

if [[ "$CI_CONCLUSION" != "success" ]]; then
  printf '%s\n' "$TARGET_SHA" >"${STATE_DIR}/rejected-sha.tmp"
  mv "${STATE_DIR}/rejected-sha.tmp" "${STATE_DIR}/rejected-sha"
  log "CI run ${CI_RUN_ID} concluded ${CI_CONCLUSION:-unknown}; production will stay on ${DEPLOYED_SHA:-the current release}"
  exit 0
fi

rm -f "${STATE_DIR}/rejected-sha"

log "fetching CI-approved commit ${TARGET_SHA}"
git -C "$WORKTREE" fetch --force --prune origin "$BRANCH"
FETCHED_SHA="$(git -C "$WORKTREE" rev-parse FETCH_HEAD)"
[[ "$FETCHED_SHA" == "$TARGET_SHA" ]] \
  || fail "branch moved while fetching; refusing to deploy a different commit"

git -C "$WORKTREE" checkout --detach --force "$TARGET_SHA"
git -C "$WORKTREE" reset --hard "$TARGET_SHA" >/dev/null
git -C "$WORKTREE" clean -ffdqx >/dev/null

CHART_DIR="${WORKTREE}/infra/helm/raibitserver"
[[ -f "$CHART_DIR/Chart.yaml" ]] || fail "Helm chart is missing from approved checkout"

if [[ "$PLATFORM_RECONCILE_REQUIRED" == 1 ]]; then
  control_plane_database_reachable || fail "control-plane database preflight failed before image builds"
fi

# key|Dockerfile|GHCR repository suffix. All Dockerfiles use the repository root
# as their build context, which keeps workspace/package COPY contracts intact.
IMAGE_TARGETS=()
if [[ "$PLATFORM_RECONCILE_REQUIRED" == 1 ]]; then
  IMAGE_TARGETS+=(
    'api|apps/api/Dockerfile|api'
    'dashboard|apps/dashboard/Dockerfile|dashboard'
    'orchestrator|services/orchestrator/Dockerfile|orchestrator'
    'builder|services/builder/Dockerfile|builder'
    'provisioner|services/provisioner/Dockerfile|provisioner'
    'logIngester|services/log-ingester/Dockerfile|log-ingester'
    'metricsIngester|services/metrics-ingester/Dockerfile|metrics-ingester'
  )
fi
if [[ "$REGISTRY_RECONCILE_REQUIRED" == 1 ]]; then
  IMAGE_TARGETS+=(
    'registryBroker|services/registry-broker/Dockerfile|registry-broker'
  )
fi

declare -A DIGESTS=()
SHORT_SHA="${TARGET_SHA:0:12}"

for target in "${IMAGE_TARGETS[@]}"; do
  IFS='|' read -r digest_key dockerfile repository_suffix <<<"$target"
  dockerfile_path="${WORKTREE}/${dockerfile}"
  [[ -f "$dockerfile_path" ]] || fail "Dockerfile is missing: $dockerfile"

  image="${IMAGE_PREFIX}/${repository_suffix}:prod-${SHORT_SHA}"
  metadata_file="${RUN_DIR}/${digest_key}.metadata.json"
  build_args=()
  if [[ "$digest_key" == dashboard ]]; then
    build_args+=(
      --build-arg "RAIBITSERVER_GIT_SHA=${TARGET_SHA}"
      --build-arg "RAIBITSERVER_GITHUB_REPOSITORY=${REPOSITORY}"
    )
  fi

  log "building ${digest_key} from ${dockerfile}"
  docker buildx build \
    --builder "$BUILDX_BUILDER" \
    --platform "$PLATFORM" \
    --network host \
    --progress plain \
    --file "$dockerfile_path" \
    --tag "$image" \
    --push \
    "${build_args[@]}" \
    --metadata-file "$metadata_file" \
    "$WORKTREE"

  digest="$(jq -er '."containerimage.digest"' "$metadata_file")"
  valid_digest "$digest" || fail "build did not return a valid digest for ${digest_key}"
  DIGESTS["$digest_key"]="$digest"

  image_ref="${IMAGE_PREFIX}/${repository_suffix}@${digest}"
  log "signing ${image_ref}"
  cosign sign --yes \
    --new-bundle-format=false \
    --use-signing-config=false \
    --registry-referrers-mode=legacy \
    --key "$COSIGN_KEY" \
    "$image_ref"
done

CANDIDATE_VALUES="${RUN_DIR}/production-values.yaml"
if [[ "$PLATFORM_RECONCILE_REQUIRED" == 1 ]]; then
DIGEST_JSON="${RUN_DIR}/digests.json"
jq -n \
  --arg api "${DIGESTS[api]}" \
  --arg dashboard "${DIGESTS[dashboard]}" \
  --arg orchestrator "${DIGESTS[orchestrator]}" \
  --arg builder "${DIGESTS[builder]}" \
  --arg provisioner "${DIGESTS[provisioner]}" \
  --arg logIngester "${DIGESTS[logIngester]}" \
  --arg metricsIngester "${DIGESTS[metricsIngester]}" \
  '{
    api: $api,
    dashboard: $dashboard,
    orchestrator: $orchestrator,
    builder: $builder,
    provisioner: $provisioner,
    logIngester: $logIngester,
    metricsIngester: $metricsIngester
  }' >"$DIGEST_JSON"

python3 - "$VALUES_FILE" "$CANDIDATE_VALUES" "$DIGEST_JSON" "$IMAGE_PREFIX" <<'PY'
from pathlib import Path
import json
import re
import sys

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
digests = json.loads(Path(sys.argv[3]).read_text())
image_prefix = sys.argv[4].rstrip('/')

lines = source.read_text().splitlines()
inside_image = False
inside_digests = False
image_indent = None
digests_indent = None
registry = None
updated = set()

for index, line in enumerate(lines):
    stripped = line.strip()
    indent = len(line) - len(line.lstrip())

    if stripped == 'image:':
        inside_image = True
        inside_digests = False
        image_indent = indent
        continue

    if inside_image and stripped and indent <= image_indent:
        inside_image = False
        inside_digests = False

    if not inside_image:
        continue

    if stripped.startswith('registry:') and registry is None:
        registry = stripped.split(':', 1)[1].strip().strip('"\'')

    if stripped == 'digests:':
        inside_digests = True
        digests_indent = indent
        continue

    if inside_digests and stripped and indent <= digests_indent:
        inside_digests = False

    if not inside_digests:
        continue

    match = re.match(r'^(\s*)([A-Za-z][A-Za-z0-9]*):', line)
    if not match:
        continue
    key = match.group(2)
    if key not in digests:
        continue
    value = digests[key]
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
        raise SystemExit(f'invalid digest for {key}')
    lines[index] = f'{match.group(1)}{key}: "{value}"'
    updated.add(key)

expected = set(digests)
if updated != expected:
    raise SystemExit(f'could not update all image digests: missing={sorted(expected - updated)}')

if not registry:
    raise SystemExit('image.registry was not found in production values')
expected_prefix = registry.rstrip('/') + '/raibitserver'
if expected_prefix != image_prefix:
    raise SystemExit(
        f'image registry mismatch: values render {expected_prefix}/<component>, '
        f'but updater pushes to {image_prefix}/<component>'
    )

destination.write_text('\n'.join(lines) + '\n')
PY
else
  cp -- "$VALUES_FILE" "$CANDIDATE_VALUES"
  chmod 600 "$CANDIDATE_VALUES"
fi

if [[ "$REGISTRY_RECONCILE_REQUIRED" == 1 ]]; then
  [[ -f "$REGISTRY_RECONCILER" && ! -L "$REGISTRY_RECONCILER" ]] \
    || fail "CI-approved registry gateway reconciler must be a regular non-symlink file"
  bash -n "$REGISTRY_RECONCILER" \
    || fail "CI-approved registry gateway reconciler has invalid Bash syntax"

  REGISTRY_BROKER_IMAGE="${IMAGE_PREFIX}/registry-broker@${DIGESTS[registryBroker]}"
  REGISTRY_VALUES_CANDIDATE="${RUN_DIR}/workload-registry-values.candidate.yaml"
  REGISTRY_BROKER_IMAGE="$REGISTRY_BROKER_IMAGE" \
  RAIBITSERVER_IMAGE_PREFIX="$IMAGE_PREFIX" \
  REGISTRY_HOST="$WORKLOAD_REGISTRY_HOST" \
  AUTH_HOST="$WORKLOAD_REGISTRY_AUTH_HOST" \
  REGISTRY_PREFIX="$WORKLOAD_REGISTRY_PREFIX" \
  REGISTRY_SERVICE="$WORKLOAD_REGISTRY_SERVICE" \
  INFRA_NS="$REGISTRY_INFRA_NAMESPACE" \
  APP_NS="$NAMESPACE" \
  BROKER_TOKEN_SECRET="$REGISTRY_BROKER_TOKEN_SECRET" \
  REGISTRY_VALUES_FILE="$REGISTRY_VALUES_FILE" \
    bash "$REGISTRY_RECONCILER" --render-values >"$REGISTRY_VALUES_CANDIDATE"
  chmod 600 "$REGISTRY_VALUES_CANDIDATE"

  log "validating the registry gateway Helm overlay before cluster mutation"
  helm lint "$CHART_DIR" -f "$CANDIDATE_VALUES" -f "$REGISTRY_VALUES_CANDIDATE"
  helm template "$HELM_RELEASE" "$CHART_DIR" \
    --namespace "$NAMESPACE" \
    -f "$CANDIDATE_VALUES" \
    -f "$REGISTRY_VALUES_CANDIDATE" >/dev/null

  log "reconciling the dedicated workload registry gateway"
  REGISTRY_BROKER_IMAGE="$REGISTRY_BROKER_IMAGE" \
  RAIBITSERVER_IMAGE_PREFIX="$IMAGE_PREFIX" \
  REGISTRY_HOST="$WORKLOAD_REGISTRY_HOST" \
  AUTH_HOST="$WORKLOAD_REGISTRY_AUTH_HOST" \
  REGISTRY_PREFIX="$WORKLOAD_REGISTRY_PREFIX" \
  REGISTRY_SERVICE="$WORKLOAD_REGISTRY_SERVICE" \
  INFRA_NS="$REGISTRY_INFRA_NAMESPACE" \
  APP_NS="$NAMESPACE" \
  BROKER_TOKEN_SECRET="$REGISTRY_BROKER_TOKEN_SECRET" \
  REGISTRY_VALUES_FILE="$REGISTRY_VALUES_FILE" \
    bash "$REGISTRY_RECONCILER"

  REGISTRY_VALUES_SNAPSHOT="${RUN_DIR}/workload-registry-values.reconciled.yaml"
  snapshot_registry_values "$REGISTRY_VALUES_FILE" "$REGISTRY_VALUES_SNAPSHOT"
  cmp -s "$REGISTRY_VALUES_CANDIDATE" "$REGISTRY_VALUES_SNAPSHOT" \
    || fail "reconciled registry overlay differs from its validated candidate"
  REGISTRY_VALUES_SOURCE="$REGISTRY_VALUES_SNAPSHOT"
  CURRENT_INPUT_DIGEST="$(deployment_input_digest "$VALUES_FILE" "$REGISTRY_VALUES_SOURCE")"
  valid_input_digest "$CURRENT_INPUT_DIGEST" \
    || fail "could not calculate the reconciled deployment input digest"
fi

HELM_VALUES_ARGS=(-f "$CANDIDATE_VALUES")
if [[ -n "$REGISTRY_VALUES_SNAPSHOT" ]]; then
  HELM_VALUES_ARGS+=(-f "$REGISTRY_VALUES_SNAPSHOT")
fi

log "validating Helm release candidate"
helm lint "$CHART_DIR" "${HELM_VALUES_ARGS[@]}"
helm template "$HELM_RELEASE" "$CHART_DIR" \
  --namespace "$NAMESPACE" \
  "${HELM_VALUES_ARGS[@]}" >/dev/null

HELM_VERSION="$(helm version --template '{{.Version}}')"
if [[ "$HELM_VERSION" =~ ^v?([0-9]+)(\.|$) ]]; then
  HELM_MAJOR="${BASH_REMATCH[1]}"
else
  fail "could not determine Helm major version from: $HELM_VERSION"
fi

case "$HELM_MAJOR" in
  3)
    HELM_SAFETY_FLAGS=(--atomic)
    ;;
  4)
    HELM_SAFETY_FLAGS=(--rollback-on-failure --wait=watcher --wait-for-jobs)
    ;;
  *)
    fail "unsupported Helm major version ${HELM_MAJOR}; only Helm 3 and Helm 4 are approved"
    ;;
esac

log "deploying ${TARGET_SHA} with Helm ${HELM_MAJOR} rollback protection"
helm upgrade --install "$HELM_RELEASE" "$CHART_DIR" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  "${HELM_VALUES_ARGS[@]}" \
  "${HELM_SAFETY_FLAGS[@]}" \
  --timeout "$HELM_TIMEOUT"

# Helm rollback protection has already waited for the release, but keep explicit
# checks for the two user-facing control-plane deployments before recording success.
kubectl -n "$NAMESPACE" rollout status deployment/raibitserver-api --timeout=5m
kubectl -n "$NAMESPACE" rollout status deployment/raibitserver-dashboard --timeout=5m

REGISTRY_APPLIED_STATE_DIGEST=""
if [[ "$REGISTRY_MANAGED" == 1 ]]; then
  registry_runtime_healthy \
    || fail "registry gateway live broker verification failed after deployment"
  REGISTRY_APPLIED_STATE_DIGEST="$(registry_state_digest)" \
    || fail "could not observe the reconciled registry gateway state"
  valid_input_digest "$REGISTRY_APPLIED_STATE_DIGEST" \
    || fail "reconciled registry gateway state digest is invalid"
fi

VALUES_TMP="${VALUES_FILE}.auto-update.$$"
cp "$CANDIDATE_VALUES" "$VALUES_TMP"
if [[ -e "$VALUES_FILE" ]]; then
  chmod --reference="$VALUES_FILE" "$VALUES_TMP" 2>/dev/null || chmod 600 "$VALUES_TMP"
fi
mv "$VALUES_TMP" "$VALUES_FILE"

APPLIED_INPUT_DIGEST="$(deployment_input_digest "$VALUES_FILE" "$REGISTRY_VALUES_SNAPSHOT")"
valid_input_digest "$APPLIED_INPUT_DIGEST" \
  || fail "could not calculate the applied deployment input digest"

UPDATER_SOURCE="${WORKTREE}/deploy/production/auto-update.sh"
[[ -f "$UPDATER_SOURCE" && ! -L "$UPDATER_SOURCE" ]] \
  || fail "approved checkout updater must be a regular non-symlink file"
bash -n "$UPDATER_SOURCE" \
  || fail "approved checkout updater failed Bash syntax validation"

UPDATER_TMP="$(mktemp "${UPDATER_LIBEXEC_DIR}/.raibitserver-production-auto-update.XXXXXX")"
cp -- "$UPDATER_SOURCE" "$UPDATER_TMP"
chmod 0755 "$UPDATER_TMP"
bash -n "$UPDATER_TMP" \
  || fail "copied updater failed Bash syntax validation"
mv -- "$UPDATER_TMP" "$UPDATER_LIBEXEC_PATH"
log "refreshed production updater from ${TARGET_SHA}"

printf '%s\n' "$TARGET_SHA" >"${STATE_DIR}/deployed-sha.tmp"
mv "${STATE_DIR}/deployed-sha.tmp" "${STATE_DIR}/deployed-sha"
printf '%s\n' "$APPLIED_INPUT_DIGEST" >"${STATE_DIR}/deployed-input-digest.tmp"
mv "${STATE_DIR}/deployed-input-digest.tmp" "${STATE_DIR}/deployed-input-digest"
if [[ "$REGISTRY_MANAGED" == 1 ]]; then
  printf '%s\n' "$TARGET_SHA" >"${STATE_DIR}/registry-reconciled-sha.tmp"
  mv "${STATE_DIR}/registry-reconciled-sha.tmp" "${STATE_DIR}/registry-reconciled-sha"
  printf '%s\n' "$APPLIED_INPUT_DIGEST" >"${STATE_DIR}/registry-reconciled-input-digest.tmp"
  mv "${STATE_DIR}/registry-reconciled-input-digest.tmp" "${STATE_DIR}/registry-reconciled-input-digest"
  printf '%s\n' "$REGISTRY_APPLIED_STATE_DIGEST" >"${STATE_DIR}/registry-reconciled-state-digest.tmp"
  mv "${STATE_DIR}/registry-reconciled-state-digest.tmp" "${STATE_DIR}/registry-reconciled-state-digest"
fi

LAST_SUCCESS_REGISTRY_SHA=""
if [[ "$REGISTRY_MANAGED" == 1 ]]; then
  LAST_SUCCESS_REGISTRY_SHA="$TARGET_SHA"
fi
jq -cn \
  --arg sha "$TARGET_SHA" \
  --arg inputDigest "$APPLIED_INPUT_DIGEST" \
  --arg registryReconciledSha "$LAST_SUCCESS_REGISTRY_SHA" \
  --arg registryStateDigest "$REGISTRY_APPLIED_STATE_DIGEST" \
  --arg ciRunId "$CI_RUN_ID" \
  --arg deployedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{sha:$sha,inputDigest:$inputDigest,ciRunId:$ciRunId,deployedAt:$deployedAt}
   + if $registryReconciledSha == "" then {} else {
       registryReconciledSha:$registryReconciledSha,
       registryStateDigest:$registryStateDigest
     } end' >"${STATE_DIR}/last-success.json.tmp"
mv "${STATE_DIR}/last-success.json.tmp" "${STATE_DIR}/last-success.json"

log "production is now running ${TARGET_SHA}"
