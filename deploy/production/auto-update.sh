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

: "${HOME:?HOME is required}"

REPOSITORY="${RAIBITSERVER_GITHUB_REPOSITORY:-jsk1004ha/RaibitServer}"
REPO_URL="${RAIBITSERVER_REPO_URL:-https://github.com/${REPOSITORY}.git}"
BRANCH="${RAIBITSERVER_DEPLOY_BRANCH:-main}"
DEPLOY_ROOT="${RAIBITSERVER_DEPLOY_ROOT:-${HOME}/.local/share/raibitserver-production}"
WORKTREE="${RAIBITSERVER_DEPLOY_WORKTREE:-${DEPLOY_ROOT}/repository}"
STATE_DIR="${RAIBITSERVER_AUTO_UPDATE_STATE_DIR:-${HOME}/.local/state/raibitserver-auto-update}"
VALUES_FILE="${RAIBITSERVER_VALUES_FILE:-${HOME}/production-values.yaml}"
KUBECONFIG="${KUBECONFIG:-${RAIBITSERVER_KUBECONFIG:-${HOME}/.kube/config}}"
HELM_RELEASE="${RAIBITSERVER_HELM_RELEASE:-raibitserver}"
NAMESPACE="${RAIBITSERVER_NAMESPACE:-raibitserver-system}"
BUILDX_BUILDER="${RAIBITSERVER_BUILDX_BUILDER:-raibit-prod-builder}"
PLATFORM="${RAIBITSERVER_BUILD_PLATFORM:-linux/amd64}"
IMAGE_PREFIX="${RAIBITSERVER_IMAGE_PREFIX:-ghcr.io/jsk1004ha/raibitserver}"
COSIGN_KEY="${RAIBITSERVER_COSIGN_KEY:-k8s://raibitserver-system/raibitserver-cosign-signing}"
HELM_TIMEOUT="${RAIBITSERVER_HELM_TIMEOUT:-20m}"
GITHUB_API="${RAIBITSERVER_GITHUB_API:-https://api.github.com}"

export KUBECONFIG

for command_name in git curl jq docker cosign kubectl helm flock python3 awk mktemp; do
  require_command "$command_name"
done

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
if [[ "$TARGET_SHA" == "$DEPLOYED_SHA" ]]; then
  log "already running ${TARGET_SHA}"
  exit 0
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

RUN_DIR="$(mktemp -d "${STATE_DIR}/run.XXXXXX")"
cleanup() {
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

# key|Dockerfile|GHCR repository suffix. All Dockerfiles use the repository root
# as their build context, which keeps workspace/package COPY contracts intact.
IMAGE_TARGETS=(
  'api|apps/api/Dockerfile|api'
  'dashboard|apps/dashboard/Dockerfile|dashboard'
  'orchestrator|services/orchestrator/Dockerfile|orchestrator'
  'builder|services/builder/Dockerfile|builder'
  'provisioner|services/provisioner/Dockerfile|provisioner'
  'logIngester|services/log-ingester/Dockerfile|log-ingester'
  'metricsIngester|services/metrics-ingester/Dockerfile|metrics-ingester'
)

declare -A DIGESTS=()
SHORT_SHA="${TARGET_SHA:0:12}"

for target in "${IMAGE_TARGETS[@]}"; do
  IFS='|' read -r digest_key dockerfile repository_suffix <<<"$target"
  dockerfile_path="${WORKTREE}/${dockerfile}"
  [[ -f "$dockerfile_path" ]] || fail "Dockerfile is missing: $dockerfile"

  image="${IMAGE_PREFIX}/${repository_suffix}:prod-${SHORT_SHA}"
  metadata_file="${RUN_DIR}/${digest_key}.metadata.json"

  log "building ${digest_key} from ${dockerfile}"
  docker buildx build \
    --builder "$BUILDX_BUILDER" \
    --platform "$PLATFORM" \
    --network host \
    --progress plain \
    --file "$dockerfile_path" \
    --tag "$image" \
    --push \
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

CANDIDATE_VALUES="${RUN_DIR}/production-values.yaml"
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

log "validating Helm release candidate"
helm lint "$CHART_DIR" -f "$CANDIDATE_VALUES"
helm template "$HELM_RELEASE" "$CHART_DIR" \
  --namespace "$NAMESPACE" \
  -f "$CANDIDATE_VALUES" >/dev/null

log "deploying ${TARGET_SHA} with Helm --atomic"
helm upgrade --install "$HELM_RELEASE" "$CHART_DIR" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  -f "$CANDIDATE_VALUES" \
  --atomic \
  --timeout "$HELM_TIMEOUT"

# Helm --atomic has already waited for the release, but keep explicit checks for
# the two user-facing control-plane deployments before recording success.
kubectl -n "$NAMESPACE" rollout status deployment/raibitserver-api --timeout=5m
kubectl -n "$NAMESPACE" rollout status deployment/raibitserver-dashboard --timeout=5m

VALUES_TMP="${VALUES_FILE}.auto-update.$$"
cp "$CANDIDATE_VALUES" "$VALUES_TMP"
if [[ -e "$VALUES_FILE" ]]; then
  chmod --reference="$VALUES_FILE" "$VALUES_TMP" 2>/dev/null || chmod 600 "$VALUES_TMP"
fi
mv "$VALUES_TMP" "$VALUES_FILE"

printf '%s\n' "$TARGET_SHA" >"${STATE_DIR}/deployed-sha.tmp"
mv "${STATE_DIR}/deployed-sha.tmp" "${STATE_DIR}/deployed-sha"

cat >"${STATE_DIR}/last-success.json.tmp" <<EOF
{"sha":"${TARGET_SHA}","ciRunId":"${CI_RUN_ID}","deployedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
mv "${STATE_DIR}/last-success.json.tmp" "${STATE_DIR}/last-success.json"

log "production is now running ${TARGET_SHA}"
