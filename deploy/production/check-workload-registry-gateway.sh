#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

log() {
  printf '[raibitserver-registry-check] %s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command missing: $1"
}

[[ "$#" == 0 ]] || fail "unexpected health-check argument"

BASE_DOMAIN="${BASE_DOMAIN:-${RAIBITSERVER_BASE_DOMAIN:-raibit.kr}}"
REGISTRY_HOST="${REGISTRY_HOST:-registry.${BASE_DOMAIN}}"
AUTH_HOST="${AUTH_HOST:-registry-auth.${BASE_DOMAIN}}"
REGISTRY_PREFIX="${REGISTRY_PREFIX:-raibitserver}"
REGISTRY_SERVICE="${REGISTRY_SERVICE:-raibit-registry}"
INFRA_NS="${INFRA_NS:-raibitserver-infra}"
APP_NS="${APP_NS:-raibitserver-system}"
EDGE_NS="${EDGE_NS:-edge-gateway-system}"
BROKER_TOKEN_SECRET="${BROKER_TOKEN_SECRET:-raibitserver-registry-broker-token}"
IMAGE_PREFIX="${RAIBITSERVER_IMAGE_PREFIX:-ghcr.io/jsk1004ha/raibitserver}"

for command in awk base64 chmod curl jq kubectl mktemp python3 rm sha256sum; do
  need "$command"
done

python3 - \
  "$REGISTRY_HOST" "$AUTH_HOST" "$REGISTRY_PREFIX" "$REGISTRY_SERVICE" \
  "$INFRA_NS" "$APP_NS" "$EDGE_NS" "$BROKER_TOKEN_SECRET" "$IMAGE_PREFIX" <<'PY'
import re
import sys

(
    registry_host,
    auth_host,
    registry_prefix,
    registry_service,
    infra_namespace,
    app_namespace,
    edge_namespace,
    broker_token_secret,
    image_prefix,
) = sys.argv[1:]

hostname = re.compile(
    r'^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+'
    r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$',
    re.IGNORECASE,
)
dns_label = re.compile(r'^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$')
prefix = re.compile(r'^[a-z0-9]+(?:[._/-][a-z0-9]+)*$', re.IGNORECASE)
service = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$')
image_prefix_pattern = re.compile(r'^ghcr\.io/[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$')

for label, value in [('registry host', registry_host), ('broker host', auth_host)]:
    if not hostname.fullmatch(value):
        raise SystemExit(f'ERROR: invalid {label}')
for label, value in [
    ('infrastructure namespace', infra_namespace),
    ('application namespace', app_namespace),
    ('edge namespace', edge_namespace),
    ('broker token Secret', broker_token_secret),
]:
    if not dns_label.fullmatch(value):
        raise SystemExit(f'ERROR: invalid {label}')
if not prefix.fullmatch(registry_prefix):
    raise SystemExit('ERROR: invalid registry prefix')
if not service.fullmatch(registry_service):
    raise SystemExit('ERROR: invalid registry service')
if not image_prefix_pattern.fullmatch(image_prefix):
    raise SystemExit('ERROR: registry broker image prefix must be an explicit GHCR path')
PY

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/raibit-registry-check.XXXXXX")"
cleanup() {
  rm -rf -- "$RUN_DIR"
}
trap cleanup EXIT

GATEWAY_DEPLOYMENT="${RUN_DIR}/gateway-deployment.json"
GATEWAY_SERVICE="${RUN_DIR}/gateway-service.json"
GATEWAY_NETWORK_POLICY="${RUN_DIR}/gateway-network-policy.json"
REGISTRY_STATEFULSET="${RUN_DIR}/registry-statefulset.json"
COREDNS="${RUN_DIR}/coredns.json"
COREDNS_CUSTOM="${RUN_DIR}/coredns-custom.json"

kubectl -n "$INFRA_NS" get deployment raibit-registry-auth -o json >"$GATEWAY_DEPLOYMENT" \
  || fail "registry gateway Deployment could not be read"
kubectl -n "$INFRA_NS" get service raibit-registry-auth -o json >"$GATEWAY_SERVICE" \
  || fail "registry gateway Service could not be read"
kubectl -n "$INFRA_NS" get networkpolicy raibit-registry-auth-ingress -o json >"$GATEWAY_NETWORK_POLICY" \
  || fail "registry gateway NetworkPolicy could not be read"
kubectl -n "$INFRA_NS" get statefulset raibit-registry -o json >"$REGISTRY_STATEFULSET" \
  || fail "workload registry StatefulSet could not be read"
kubectl -n kube-system get configmap coredns -o json >"$COREDNS" \
  || fail "CoreDNS ConfigMap could not be read"
kubectl -n kube-system get configmap coredns-custom --ignore-not-found -o json >"$COREDNS_CUSTOM" \
  || fail "optional CoreDNS custom ConfigMap could not be read"

if ! GATEWAY_CLUSTER_IP="$(python3 - \
  "$GATEWAY_DEPLOYMENT" "$GATEWAY_SERVICE" "$GATEWAY_NETWORK_POLICY" "$REGISTRY_STATEFULSET" \
  "$COREDNS" "$COREDNS_CUSTOM" "$APP_NS" "$EDGE_NS" "$IMAGE_PREFIX" "$REGISTRY_HOST" "$AUTH_HOST" <<'PY'
from pathlib import Path
import ipaddress
import json
import re
import sys

(
    deployment_path,
    service_path,
    network_policy_path,
    statefulset_path,
    coredns_path,
    coredns_custom_path,
    app_namespace,
    edge_namespace,
    image_prefix,
    registry_host,
    auth_host,
) = sys.argv[1:]

deployment = json.loads(Path(deployment_path).read_text())
service = json.loads(Path(service_path).read_text())
network_policy = json.loads(Path(network_policy_path).read_text())
statefulset = json.loads(Path(statefulset_path).read_text())
coredns = json.loads(Path(coredns_path).read_text())
coredns_custom_text = Path(coredns_custom_path).read_text().strip()
coredns_custom = json.loads(coredns_custom_text) if coredns_custom_text else {}

if int(deployment.get('status', {}).get('availableReplicas', 0)) < 1:
    raise SystemExit('ERROR: registry gateway has no available replica')
if int(statefulset.get('status', {}).get('readyReplicas', 0)) < 1:
    raise SystemExit('ERROR: workload registry has no ready replica')

broker_images = [
    container.get('image', '')
    for container in deployment.get('spec', {}).get('template', {}).get('spec', {}).get('containers', [])
    if container.get('name') == 'broker'
]
expected_image = re.escape(image_prefix.rstrip('/') + '/registry-broker@sha256:') + r'[0-9a-f]{64}'
if len(broker_images) != 1 or not re.fullmatch(expected_image, broker_images[0]):
    raise SystemExit('ERROR: registry broker is not running the expected immutable GHCR image')

gateway_ip = service.get('spec', {}).get('clusterIP', '')
try:
    address = ipaddress.ip_address(gateway_ip)
except ValueError as error:
    raise SystemExit('ERROR: registry gateway has an invalid ClusterIP') from error
if address.is_unspecified or address.is_loopback or address.is_link_local or address.is_multicast:
    raise SystemExit('ERROR: registry gateway has an unsafe ClusterIP')

ports = {
    (port.get('port'), port.get('targetPort'))
    for port in service.get('spec', {}).get('ports', [])
}
if (443, 8443) not in ports:
    raise SystemExit('ERROR: registry gateway internal TLS service port is missing')

expected_network_policy_spec = {
    'podSelector': {'matchLabels': {'app': 'raibit-registry-auth'}},
    'policyTypes': ['Ingress', 'Egress'],
    'ingress': [
        {
            'from': [
                {
                    'namespaceSelector': {
                        'matchLabels': {'kubernetes.io/metadata.name': edge_namespace},
                    },
                },
            ],
            'ports': [{'protocol': 'TCP', 'port': 8080}],
        },
        {
            'from': [
                {
                    'namespaceSelector': {
                        'matchLabels': {'kubernetes.io/metadata.name': app_namespace},
                    },
                    'podSelector': {
                        'matchLabels': {'app.kubernetes.io/name': 'raibitserver-builder-executor'},
                    },
                },
            ],
            'ports': [
                {'protocol': 'TCP', 'port': 443},
                {'protocol': 'TCP', 'port': 8443},
            ],
        },
    ],
    'egress': [
        {
            'to': [
                {
                    'namespaceSelector': {
                        'matchLabels': {'kubernetes.io/metadata.name': 'kube-system'},
                    },
                    'podSelector': {'matchLabels': {'k8s-app': 'kube-dns'}},
                },
            ],
            'ports': [
                {'protocol': 'UDP', 'port': 53},
                {'protocol': 'TCP', 'port': 53},
            ],
        },
        {
            'to': [
                {'podSelector': {'matchLabels': {'app': 'raibit-registry'}}},
            ],
            'ports': [{'protocol': 'TCP', 'port': 5000}],
        },
    ],
}

def canonical(value):
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        normalized = [canonical(item) for item in value]
        return sorted(
            normalized,
            key=lambda item: json.dumps(item, sort_keys=True, separators=(',', ':')),
        )
    return value

if canonical(network_policy.get('spec', {})) != canonical(expected_network_policy_spec):
    raise SystemExit('ERROR: registry gateway NetworkPolicy must match the least-privilege policy exactly')

node_hosts = coredns.get('data', {}).get('NodeHosts')
if not isinstance(node_hosts, str):
    raise SystemExit('ERROR: CoreDNS NodeHosts is missing')
matches = []
for line in node_hosts.splitlines():
    parts = line.split()
    if len(parts) >= 2 and ({registry_host, auth_host} & set(parts[1:])):
        matches.append(parts)
if matches != [[gateway_ip, registry_host, auth_host]]:
    raise SystemExit('ERROR: CoreDNS registry split DNS is not exact')

legacy_override = coredns_custom.get('data', {}).get('raibit-registry.server')
if legacy_override is not None:
    if not isinstance(legacy_override, str):
        raise SystemExit('ERROR: legacy CoreDNS registry override must be a string')
    legacy_matches = []
    for line in legacy_override.splitlines():
        parts = line.split()
        if len(parts) >= 2 and ({registry_host, auth_host} & set(parts[1:])):
            legacy_matches.append(parts)
    if legacy_matches != [[gateway_ip, registry_host, auth_host]]:
        raise SystemExit('ERROR: legacy CoreDNS registry override bypasses the private gateway')

print(address)
PY
)"; then
  fail "registry gateway structural health check failed"
fi

if [[ "$GATEWAY_CLUSTER_IP" == *:* ]]; then
  GATEWAY_CURL_IP="[${GATEWAY_CLUSTER_IP}]"
else
  GATEWAY_CURL_IP="$GATEWAY_CLUSTER_IP"
fi

APP_BROKER_TOKEN="${RUN_DIR}/app-broker-token"
RUNTIME_BROKER_TOKEN="${RUN_DIR}/runtime-broker-token"
if ! kubectl -n "$APP_NS" get secret "$BROKER_TOKEN_SECRET" -o json \
  | jq -er '.data.token | strings | select(length > 0)' \
  | base64 -d >"$APP_BROKER_TOKEN"; then
  fail "builder broker token Secret could not be read"
fi
if ! kubectl -n "$INFRA_NS" get secret raibit-registry-broker-runtime -o json \
  | jq -er '.data["broker-token"] | strings | select(length > 0)' \
  | base64 -d >"$RUNTIME_BROKER_TOKEN"; then
  fail "registry broker runtime token could not be read"
fi
chmod 600 "$APP_BROKER_TOKEN" "$RUNTIME_BROKER_TOKEN"

APP_BROKER_TOKEN_DIGEST="$(sha256sum "$APP_BROKER_TOKEN" | awk '{print $1}')"
RUNTIME_BROKER_TOKEN_DIGEST="$(sha256sum "$RUNTIME_BROKER_TOKEN" | awk '{print $1}')"
[[ "$APP_BROKER_TOKEN_DIGEST" == "$RUNTIME_BROKER_TOKEN_DIGEST" ]] \
  || fail "builder and broker token Secrets do not match"

BROKER_CURL_CONFIG="${RUN_DIR}/broker-curl.conf"
python3 - "$APP_BROKER_TOKEN" "$BROKER_CURL_CONFIG" <<'PY'
from pathlib import Path
import re
import sys

token = Path(sys.argv[1]).read_text().strip()
if not re.fullmatch(r'[A-Za-z0-9._~+/=-]{16,1024}', token):
    raise SystemExit('ERROR: broker token contains unsafe or invalid characters')
Path(sys.argv[2]).write_text(f'header = "Authorization: Bearer {token}"\n')
PY
chmod 600 "$BROKER_CURL_CONFIG"

curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  --resolve "${AUTH_HOST}:443:${GATEWAY_CURL_IP}" \
  "https://${AUTH_HOST}/healthz" >/dev/null \
  || fail "registry credential broker health endpoint failed"

SMOKE_ORG='registry-reconcile-smoke-org'
SMOKE_PROJECT='registry-reconcile-smoke-project'
SMOKE_SERVICE='registry-reconcile-smoke-service'
SMOKE_JOB='registry-reconcile-smoke-job'
SMOKE_REPOSITORY="$(python3 - \
  "$REGISTRY_HOST" "$REGISTRY_PREFIX" "$SMOKE_ORG" "$SMOKE_PROJECT" "$SMOKE_SERVICE" <<'PY'
import hashlib
import sys

host, prefix, organization, project, service = sys.argv[1:]

def segment(kind, value):
    digest = hashlib.sha256(
        b'raibitserver-registry-segment-v1\x00' + kind.encode() + b'\x00' + value.strip().encode()
    ).hexdigest()[:24]
    return f'{kind}-{digest}'

print('/'.join([
    host,
    prefix,
    segment('org', organization),
    segment('project', project),
    segment('service', service),
]))
PY
)"

BROKER_SMOKE_REQUEST="${RUN_DIR}/broker-smoke-request.json"
BROKER_SMOKE_RESPONSE="${RUN_DIR}/broker-smoke-response.json"
jq -n \
  --arg organizationId "$SMOKE_ORG" \
  --arg projectId "$SMOKE_PROJECT" \
  --arg serviceId "$SMOKE_SERVICE" \
  --arg jobId "$SMOKE_JOB" \
  --arg repository "$SMOKE_REPOSITORY" \
  '{
    organizationId: $organizationId,
    projectId: $projectId,
    serviceId: $serviceId,
    jobId: $jobId,
    repository: $repository,
    actions: ["pull", "push"],
    minTtlSeconds: 60,
    maxTtlSeconds: 120
  }' >"$BROKER_SMOKE_REQUEST" \
  || fail "broker smoke request could not be generated"

curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  --config "$BROKER_CURL_CONFIG" \
  --resolve "${AUTH_HOST}:443:${GATEWAY_CURL_IP}" \
  --header 'Content-Type: application/json' \
  --data-binary "@${BROKER_SMOKE_REQUEST}" \
  --output "$BROKER_SMOKE_RESPONSE" \
  "https://${AUTH_HOST}/broker" \
  || fail "registry credential broker issuance smoke test failed"

jq -e --arg repository "$SMOKE_REPOSITORY" '
  .repository == $repository
  and .username == "raibit-build"
  and ((.password | type) == "string")
  and (.password | startswith("rb1."))
  and ((.password | length) > 32)
  and ((.expiresAt | type) == "string")
  and ((.expiresAt | length) > 0)
' "$BROKER_SMOKE_RESPONSE" >/dev/null \
  || fail "registry credential broker returned an invalid issuance response"

REGISTRY_HEADERS="${RUN_DIR}/registry-response-headers"
if ! REGISTRY_STATUS="$(
  curl --silent --show-error --connect-timeout 5 --max-time 15 \
    --resolve "${REGISTRY_HOST}:443:${GATEWAY_CURL_IP}" \
    --dump-header "$REGISTRY_HEADERS" --output /dev/null --write-out '%{http_code}' \
    "https://${REGISTRY_HOST}/v2/"
)"; then
  fail "internal registry gateway request failed"
fi
[[ "$REGISTRY_STATUS" == 401 ]] \
  || fail "internal registry gateway must enforce token authentication"

python3 - "$REGISTRY_HEADERS" "$AUTH_HOST" "$REGISTRY_SERVICE" <<'PY'
from pathlib import Path
import re
import sys

headers = Path(sys.argv[1]).read_text(errors='replace').splitlines()
challenge_headers = [
    line.split(':', 1)[1].strip()
    for line in headers
    if line.lower().startswith('www-authenticate:')
]
if len(challenge_headers) != 1:
    raise SystemExit('ERROR: registry must return exactly one authentication challenge')

challenge = challenge_headers[0]
scheme = re.fullmatch(r'Bearer[ \t]+(.+)', challenge, re.IGNORECASE)
if not scheme:
    raise SystemExit('ERROR: registry challenge must use the Bearer scheme')

parameter_text = scheme.group(1)
if parameter_text.rstrip().endswith(','):
    raise SystemExit('ERROR: registry challenge has a trailing parameter separator')
parameter_pattern = re.compile(
    r'\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"([^"\\]*)"\s*(?:,|$)'
)
parameters = {}
position = 0
while position < len(parameter_text):
    match = parameter_pattern.match(parameter_text, position)
    if not match:
        raise SystemExit('ERROR: registry challenge parameters are malformed')
    name = match.group(1).lower()
    if name in parameters:
        raise SystemExit('ERROR: registry challenge contains a duplicate parameter')
    parameters[name] = match.group(2)
    position = match.end()

if parameters.get('realm') != f'https://{sys.argv[2]}/token':
    raise SystemExit('ERROR: registry challenge realm is incorrect')
if parameters.get('service') != sys.argv[3]:
    raise SystemExit('ERROR: registry challenge service is incorrect')
PY

log "registry gateway, token parity, challenge, and live broker issuance are healthy"
