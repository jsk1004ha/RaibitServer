#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

log() {
  printf '[raibitserver-registry-reconcile] %s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command missing: $1"
}

require_permission() {
  local verb="$1"
  local resource="$2"
  local namespace="$3"
  local allowed
  allowed="$(kubectl auth can-i "$verb" "$resource" --namespace "$namespace")"
  [[ "$allowed" == yes ]] || fail "updater lacks ${verb} permission for ${resource} in ${namespace}"
}

: "${HOME:?HOME is required}"
: "${REGISTRY_BROKER_IMAGE:?REGISTRY_BROKER_IMAGE is required}"

BASE_DOMAIN="${BASE_DOMAIN:-${RAIBITSERVER_BASE_DOMAIN:-raibit.kr}}"
REGISTRY_HOST="${REGISTRY_HOST:-registry.${BASE_DOMAIN}}"
AUTH_HOST="${AUTH_HOST:-registry-auth.${BASE_DOMAIN}}"
REGISTRY_PREFIX="${REGISTRY_PREFIX:-raibitserver}"
REGISTRY_SERVICE="${REGISTRY_SERVICE:-raibit-registry}"
REGISTRY_ISSUER="${REGISTRY_ISSUER:-raibit-registry-auth}"
INFRA_NS="${INFRA_NS:-raibitserver-infra}"
APP_NS="${APP_NS:-raibitserver-system}"
EDGE_NS="${EDGE_NS:-edge-gateway-system}"
TLS_SECRET="${TLS_SECRET:-raibit-registry-tls}"
BROKER_TOKEN_SECRET="${BROKER_TOKEN_SECRET:-raibitserver-registry-broker-token}"
IMAGE_PREFIX="${RAIBITSERVER_IMAGE_PREFIX:-ghcr.io/jsk1004ha/raibitserver}"
REGISTRY_VALUES_FILE="${REGISTRY_VALUES_FILE:-${HOME}/.config/raibitserver/workload-registry-values.yaml}"

for command in awk base64 chmod cmp curl grep jq kubectl mktemp mv openssl python3 rm sha256sum; do
  need "$command"
done

python3 - \
  "$REGISTRY_HOST" "$AUTH_HOST" "$REGISTRY_PREFIX" \
  "$INFRA_NS" "$APP_NS" "$EDGE_NS" "$TLS_SECRET" "$BROKER_TOKEN_SECRET" \
  "$IMAGE_PREFIX" "$REGISTRY_BROKER_IMAGE" <<'PY'
import re
import sys

(
    registry_host,
    auth_host,
    registry_prefix,
    infra_namespace,
    app_namespace,
    edge_namespace,
    tls_secret,
    broker_token_secret,
    image_prefix,
    broker_image,
) = sys.argv[1:]

hostname = re.compile(
    r'^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+'
    r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$',
    re.IGNORECASE,
)
dns_label = re.compile(r'^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$')
prefix = re.compile(r'^[a-z0-9]+(?:[._/-][a-z0-9]+)*$', re.IGNORECASE)
image_prefix_pattern = re.compile(r'^ghcr\.io/[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$')

for label, value in [('registry host', registry_host), ('broker host', auth_host)]:
    if not hostname.fullmatch(value):
        raise SystemExit(f'ERROR: invalid {label}')
for label, value in [
    ('infrastructure namespace', infra_namespace),
    ('application namespace', app_namespace),
    ('edge namespace', edge_namespace),
    ('TLS Secret', tls_secret),
    ('broker token Secret', broker_token_secret),
]:
    if not dns_label.fullmatch(value):
        raise SystemExit(f'ERROR: invalid {label}')
if not prefix.fullmatch(registry_prefix):
    raise SystemExit('ERROR: invalid registry prefix')
if not image_prefix_pattern.fullmatch(image_prefix):
    raise SystemExit('ERROR: registry broker image prefix must be an explicit GHCR path')
expected = re.escape(image_prefix.rstrip('/') + '/registry-broker@sha256:') + r'[0-9a-f]{64}'
if not re.fullmatch(expected, broker_image):
    raise SystemExit('ERROR: registry broker image must be the expected immutable GHCR digest reference')
PY

EXPECTED_REGISTRY_VALUES_FILE="${HOME}/.config/raibitserver/workload-registry-values.yaml"
[[ "$REGISTRY_VALUES_FILE" == "$EXPECTED_REGISTRY_VALUES_FILE" ]] \
  || fail "registry values path must use the fixed updater-home location"

CONFIG_DIR="${HOME}/.config/raibitserver"
python3 - "$HOME" "$CONFIG_DIR" "$REGISTRY_VALUES_FILE" <<'PY'
import os
from pathlib import Path
import stat
import sys

home = Path(sys.argv[1])
config_dir = Path(sys.argv[2])
values_file = Path(sys.argv[3])
euid = os.geteuid()

for label, path in [('updater home', home), ('registry config directory', config_dir)]:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or path.is_symlink():
        raise SystemExit(f'ERROR: {label} must be a real directory')
    if info.st_uid != euid:
        raise SystemExit(f'ERROR: {label} must be owned by the updater user')
    if info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise SystemExit(f'ERROR: {label} must not be group/world writable')

config_parent = config_dir.parent
parent_info = config_parent.lstat()
if not stat.S_ISDIR(parent_info.st_mode) or config_parent.is_symlink():
    raise SystemExit('ERROR: updater config parent must be a real directory')
if parent_info.st_uid != euid or parent_info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
    raise SystemExit('ERROR: updater config parent ownership or mode is unsafe')
if values_file.exists() or values_file.is_symlink():
    info = values_file.lstat()
    if not stat.S_ISREG(info.st_mode) or values_file.is_symlink():
        raise SystemExit('ERROR: registry values target must be a regular non-symlink file')
    if info.st_uid != euid or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise SystemExit('ERROR: registry values target ownership or mode is unsafe')
PY

render_registry_values() {
  cat <<EOF
builder:
  registry: "${REGISTRY_HOST}/${REGISTRY_PREFIX}"
  registryCredentials:
    brokerURL: "https://${AUTH_HOST}/broker"
    existingSecret: "${BROKER_TOKEN_SECRET}"
    privateGateway:
      enabled: true
      namespace: "${INFRA_NS}"
      podName: "raibit-registry-auth"
      servicePort: 443
      port: 8443
EOF
}

if [[ "${1:-}" == --render-values ]]; then
  [[ "$#" == 1 ]] || fail "--render-values does not accept additional arguments"
  render_registry_values
  exit 0
fi
[[ "$#" == 0 ]] || fail "unexpected reconciler argument"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/raibit-registry-reconcile.XXXXXX")"
cleanup() {
  rm -rf -- "$RUN_DIR"
}
trap cleanup EXIT

log "preflighting Kubernetes identities and permissions"
for namespace in "$INFRA_NS" "$APP_NS" "$EDGE_NS" kube-system; do
  kubectl get namespace "$namespace" >/dev/null \
    || fail "required namespace is missing: $namespace"
  actual_label="$(kubectl get namespace "$namespace" -o jsonpath='{.metadata.labels.kubernetes\.io/metadata\.name}')"
  [[ "$actual_label" == "$namespace" ]] \
    || fail "namespace identity label is missing or incorrect: $namespace"
done

for resource in services deployments.apps ingresses.networking.k8s.io networkpolicies.networking.k8s.io configmaps; do
  for verb in get create patch; do
    require_permission "$verb" "$resource" "$INFRA_NS"
  done
done
for verb in get patch watch; do
  require_permission "$verb" statefulsets.apps "$INFRA_NS"
  require_permission "$verb" deployments.apps "$INFRA_NS"
done
require_permission get secrets "$INFRA_NS"
require_permission get secrets "$APP_NS"
for verb in get patch; do
  require_permission "$verb" configmaps kube-system
  require_permission "$verb" deployments.apps kube-system
done
require_permission watch deployments.apps kube-system

kubectl -n "$INFRA_NS" get service raibit-registry >/dev/null \
  || fail "existing workload registry Service is missing"
REGISTRY_STATEFULSET_PREVIOUS="${RUN_DIR}/registry-statefulset.previous.json"
kubectl -n "$INFRA_NS" get statefulset raibit-registry -o json >"$REGISTRY_STATEFULSET_PREVIOUS" \
  || fail "existing workload registry StatefulSet is missing"
REGISTRY_CONFIG_PREVIOUS="${RUN_DIR}/registry-config.previous.json"
kubectl -n "$INFRA_NS" get configmap raibit-registry-config -o json >"$REGISTRY_CONFIG_PREVIOUS" \
  || fail "existing workload registry ConfigMap is missing"
jq -e '.data["config.yml"] | type == "string" and length > 0' "$REGISTRY_CONFIG_PREVIOUS" >/dev/null \
  || fail "existing workload registry ConfigMap is missing config.yml"

GATEWAY_EXISTED=0
GATEWAY_DEPLOYMENT_PREVIOUS="${RUN_DIR}/gateway-deployment.previous.json"
GATEWAY_DEPLOYMENT_APPLIED="${RUN_DIR}/gateway-deployment.applied.json"
if kubectl -n "$INFRA_NS" get deployment raibit-registry-auth -o json >"$GATEWAY_DEPLOYMENT_PREVIOUS" 2>/dev/null; then
  GATEWAY_EXISTED=1
fi
GATEWAY_SERVICE_PREVIOUS="${RUN_DIR}/gateway-service.previous.json"
GATEWAY_SERVICE_APPLIED="${RUN_DIR}/gateway-service.applied.json"
kubectl -n "$INFRA_NS" get service raibit-registry-auth -o json \
  >"$GATEWAY_SERVICE_PREVIOUS" 2>/dev/null || rm -f -- "$GATEWAY_SERVICE_PREVIOUS"
GATEWAY_INGRESS_PREVIOUS="${RUN_DIR}/gateway-ingress.previous.json"
GATEWAY_INGRESS_APPLIED="${RUN_DIR}/gateway-ingress.applied.json"
kubectl -n "$INFRA_NS" get ingress raibit-registry-auth -o json \
  >"$GATEWAY_INGRESS_PREVIOUS" 2>/dev/null || rm -f -- "$GATEWAY_INGRESS_PREVIOUS"
GATEWAY_POLICY_PREVIOUS="${RUN_DIR}/gateway-policy.previous.json"
GATEWAY_POLICY_APPLIED="${RUN_DIR}/gateway-policy.applied.json"
kubectl -n "$INFRA_NS" get networkpolicy raibit-registry-auth-ingress -o json \
  >"$GATEWAY_POLICY_PREVIOUS" 2>/dev/null || rm -f -- "$GATEWAY_POLICY_PREVIOUS"
REGISTRY_POLICY_PREVIOUS="${RUN_DIR}/registry-policy.previous.json"
REGISTRY_POLICY_APPLIED="${RUN_DIR}/registry-policy.applied.json"
kubectl -n "$INFRA_NS" get networkpolicy raibit-registry-ingress -o json \
  >"$REGISTRY_POLICY_PREVIOUS" 2>/dev/null || rm -f -- "$REGISTRY_POLICY_PREVIOUS"

kubectl -n "$APP_NS" get secret "$BROKER_TOKEN_SECRET" -o json \
  | jq -e '.data.token | type == "string" and length > 0' >/dev/null \
  || fail "builder broker token Secret is missing its token key"
kubectl -n "$INFRA_NS" get secret raibit-registry-broker-runtime -o json \
  | jq -e '.data["broker-token"] | type == "string" and length > 0' >/dev/null \
  || fail "registry broker runtime Secret is missing broker-token"
kubectl -n "$INFRA_NS" get secret raibit-registry-broker-runtime -o json \
  | jq -e '.data["session-hmac-key"] | type == "string" and length > 0' >/dev/null \
  || fail "registry broker runtime Secret is missing session-hmac-key"
kubectl -n "$INFRA_NS" get secret raibit-registry-token-signer -o json \
  | jq -e '.data["token.key"] and .data["token.crt"]' >/dev/null \
  || fail "registry token signer Secret is incomplete"
kubectl -n "$INFRA_NS" get secret "$TLS_SECRET" -o json \
  | jq -e '.data["tls.crt"] and .data["tls.key"]' >/dev/null \
  || fail "registry TLS Secret is incomplete"

CERT_SANS="$(
  kubectl -n "$INFRA_NS" get secret "$TLS_SECRET" -o jsonpath='{.data.tls\.crt}' \
    | base64 -d \
    | openssl x509 -noout -ext subjectAltName 2>/dev/null
)"
grep -Fq "DNS:${REGISTRY_HOST}" <<<"$CERT_SANS" \
  || fail "registry TLS certificate does not cover the registry host"
grep -Fq "DNS:${AUTH_HOST}" <<<"$CERT_SANS" \
  || fail "registry TLS certificate does not cover the broker host"

COREDNS_JSON="${RUN_DIR}/coredns.json"
kubectl -n kube-system get configmap coredns -o json >"$COREDNS_JSON"
jq -e '.data | has("NodeHosts")' "$COREDNS_JSON" >/dev/null \
  || fail "CoreDNS ConfigMap does not expose the managed NodeHosts key"
COREDNS_CUSTOM_JSON="${RUN_DIR}/coredns-custom.json"
kubectl -n kube-system get configmap coredns-custom --ignore-not-found -o json >"$COREDNS_CUSTOM_JSON" \
  || fail "optional CoreDNS custom ConfigMap could not be read"
kubectl -n kube-system get deployment coredns >/dev/null \
  || fail "CoreDNS Deployment is missing"
[[ -n "$(kubectl -n kube-system get pods -l k8s-app=kube-dns -o name)" ]] \
  || fail "CoreDNS Pod identity selector did not match any Pods"

REGISTRY_CONFIG="${RUN_DIR}/registry-config.yml"
cat >"$REGISTRY_CONFIG" <<EOF
version: 0.1
log:
  level: info
storage:
  filesystem:
    rootdirectory: /var/lib/registry
  delete:
    enabled: true
  maintenance:
    uploadpurging:
      enabled: true
      age: 168h
      interval: 24h
      dryrun: false
http:
  addr: :5000
  relativeurls: true
  headers:
    X-Content-Type-Options: [nosniff]
auth:
  token:
    realm: https://${AUTH_HOST}/token
    service: ${REGISTRY_SERVICE}
    issuer: ${REGISTRY_ISSUER}
    rootcertbundle: /etc/distribution/token.crt
    signingalgorithms:
      - RS256
EOF

GATEWAY_MANIFEST="${RUN_DIR}/gateway.yaml"
cat >"$GATEWAY_MANIFEST" <<EOF
apiVersion: v1
kind: Service
metadata:
  name: raibit-registry-auth
  namespace: ${INFRA_NS}
spec:
  type: ClusterIP
  selector:
    app: raibit-registry-auth
  ports:
    - name: http
      port: 8080
      targetPort: 8080
    - name: internal-tls
      port: 443
      targetPort: 8443
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: raibit-registry-ingress
  namespace: ${INFRA_NS}
spec:
  podSelector:
    matchLabels:
      app: raibit-registry
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${EDGE_NS}
      ports:
        - { protocol: TCP, port: 5000 }
    - from:
        - podSelector:
            matchLabels:
              app: raibit-registry-auth
      ports:
        - { protocol: TCP, port: 5000 }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: raibit-registry-auth-ingress
  namespace: ${INFRA_NS}
spec:
  podSelector:
    matchLabels:
      app: raibit-registry-auth
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${EDGE_NS}
      ports:
        - { protocol: TCP, port: 8080 }
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${APP_NS}
          podSelector:
            matchLabels:
              app.kubernetes.io/name: raibitserver-builder-executor
      ports:
        - { protocol: TCP, port: 8443 }
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
    - to:
        - podSelector:
            matchLabels:
              app: raibit-registry
      ports:
        - { protocol: TCP, port: 5000 }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: raibit-registry-auth
  namespace: ${INFRA_NS}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: raibit-registry-auth
  template:
    metadata:
      labels:
        app: raibit-registry-auth
        app.kubernetes.io/name: raibit-registry-auth
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        fsGroup: 65532
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: broker
          image: ${REGISTRY_BROKER_IMAGE}
          imagePullPolicy: IfNotPresent
          env:
            - { name: PORT, value: "8080" }
            - { name: REGISTRY_HOST, value: "${REGISTRY_HOST}" }
            - { name: BROKER_HOST, value: "${AUTH_HOST}" }
            - { name: REGISTRY_PREFIX, value: "${REGISTRY_PREFIX}" }
            - { name: REGISTRY_SERVICE, value: "${REGISTRY_SERVICE}" }
            - { name: REGISTRY_ISSUER, value: "${REGISTRY_ISSUER}" }
            - { name: INTERNAL_TLS_PORT, value: "8443" }
            - { name: INTERNAL_TLS_CERT_FILE, value: "/var/run/secrets/raibit/tls/tls.crt" }
            - { name: INTERNAL_TLS_KEY_FILE, value: "/var/run/secrets/raibit/tls/tls.key" }
            - { name: REGISTRY_UPSTREAM_URL, value: "http://raibit-registry:5000" }
            - { name: BROKER_TOKEN_FILE, value: "/var/run/secrets/raibit/broker-token" }
            - { name: SESSION_HMAC_KEY_FILE, value: "/var/run/secrets/raibit/session-hmac-key" }
            - { name: TOKEN_PRIVATE_KEY_FILE, value: "/var/run/secrets/raibit/signer/token.key" }
            - { name: TOKEN_CERT_FILE, value: "/var/run/secrets/raibit/signer/token.crt" }
          ports:
            - name: http
              containerPort: 8080
            - name: internal-tls
              containerPort: 8443
          readinessProbe:
            tcpSocket: { port: internal-tls }
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 6
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            initialDelaySeconds: 10
            periodSeconds: 20
            timeoutSeconds: 3
            failureThreshold: 3
          resources:
            requests: { cpu: 25m, memory: 32Mi }
            limits: { cpu: 250m, memory: 128Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: broker-runtime
              mountPath: /var/run/secrets/raibit/broker-token
              subPath: broker-token
              readOnly: true
            - name: broker-runtime
              mountPath: /var/run/secrets/raibit/session-hmac-key
              subPath: session-hmac-key
              readOnly: true
            - name: signer
              mountPath: /var/run/secrets/raibit/signer
              readOnly: true
            - name: tls
              mountPath: /var/run/secrets/raibit/tls
              readOnly: true
      volumes:
        - name: broker-runtime
          secret:
            secretName: raibit-registry-broker-runtime
        - name: signer
          secret:
            secretName: raibit-registry-token-signer
        - name: tls
          secret:
            secretName: ${TLS_SECRET}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: raibit-registry-auth
  namespace: ${INFRA_NS}
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
spec:
  ingressClassName: traefik
  tls:
    - hosts: ["${AUTH_HOST}"]
      secretName: ${TLS_SECRET}
  rules:
    - host: ${AUTH_HOST}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: raibit-registry-auth
                port:
                  number: 8080
EOF

capture_gateway_applied_state() {
  local capture_failed=0

  kubectl -n "$INFRA_NS" get deployment raibit-registry-auth -o json >"$GATEWAY_DEPLOYMENT_APPLIED" \
    || capture_failed=1
  kubectl -n "$INFRA_NS" get service raibit-registry-auth -o json >"$GATEWAY_SERVICE_APPLIED" \
    || capture_failed=1
  kubectl -n "$INFRA_NS" get ingress raibit-registry-auth -o json >"$GATEWAY_INGRESS_APPLIED" \
    || capture_failed=1
  kubectl -n "$INFRA_NS" get networkpolicy raibit-registry-auth-ingress -o json >"$GATEWAY_POLICY_APPLIED" \
    || capture_failed=1
  kubectl -n "$INFRA_NS" get networkpolicy raibit-registry-ingress -o json >"$REGISTRY_POLICY_APPLIED" \
    || capture_failed=1

  [[ "$capture_failed" == 0 ]]
}

restore_gateway_spec() {
  local kind="$1"
  local name="$2"
  local previous="$3"
  local applied="$4"
  local label="$5"
  local patch

  [[ -f "$previous" ]] || {
    log "ERROR: ${label} did not previously exist; UID-preconditioned deletion requires manual recovery" >&2
    return 1
  }
  if [[ ! -f "$applied" ]]; then
    log "ERROR: ${label} applied snapshot is missing; exact rollback was refused" >&2
    return 1
  fi
  patch="$(
    jq -cn --slurpfile applied "$applied" --slurpfile previous "$previous" '
      [
        {"op":"test","path":"/metadata/uid","value":$applied[0].metadata.uid},
        {"op":"test","path":"/spec","value":$applied[0].spec},
        {"op":"replace","path":"/spec","value":$previous[0].spec}
      ]
    '
  )"
  if ! kubectl -n "$INFRA_NS" patch "$kind" "$name" --type=json -p "$patch" >/dev/null; then
    log "ERROR: ${label} changed concurrently; exact rollback was refused" >&2
    return 1
  fi
}

rollback_gateway_resources() {
  local rollback_failed=0
  restore_gateway_spec deployment raibit-registry-auth "$GATEWAY_DEPLOYMENT_PREVIOUS" "$GATEWAY_DEPLOYMENT_APPLIED" "gateway Deployment" \
    || rollback_failed=1
  restore_gateway_spec service raibit-registry-auth "$GATEWAY_SERVICE_PREVIOUS" "$GATEWAY_SERVICE_APPLIED" "gateway Service" \
    || rollback_failed=1
  restore_gateway_spec ingress raibit-registry-auth "$GATEWAY_INGRESS_PREVIOUS" "$GATEWAY_INGRESS_APPLIED" "gateway Ingress" \
    || rollback_failed=1
  restore_gateway_spec networkpolicy raibit-registry-auth-ingress "$GATEWAY_POLICY_PREVIOUS" "$GATEWAY_POLICY_APPLIED" "gateway NetworkPolicy" \
    || rollback_failed=1
  restore_gateway_spec networkpolicy raibit-registry-ingress "$REGISTRY_POLICY_PREVIOUS" "$REGISTRY_POLICY_APPLIED" "registry NetworkPolicy" \
    || rollback_failed=1

  if [[ "$GATEWAY_EXISTED" == 1 && "$rollback_failed" == 0 ]]; then
    kubectl -n "$INFRA_NS" rollout status deployment/raibit-registry-auth --timeout=180s \
      || rollback_failed=1
  fi
  [[ "$rollback_failed" == 0 ]]
}

REGISTRY_CONFIG_CHANGED=0
REGISTRY_TEMPLATE_CHANGED=0
REGISTRY_STATEFULSET_APPLIED="${RUN_DIR}/registry-statefulset.applied.json"
rollback_registry_state() {
  local config_safe=1
  local patch

  if [[ "$REGISTRY_CONFIG_CHANGED" == 1 ]]; then
    patch="$(
      jq -cn --rawfile expected "$REGISTRY_CONFIG" --slurpfile previous "$REGISTRY_CONFIG_PREVIOUS" '
        [
          {"op":"test","path":"/data/config.yml","value":$expected},
          {"op":"replace","path":"/data/config.yml","value":$previous[0].data["config.yml"]}
        ]
      '
    )"
    if ! kubectl -n "$INFRA_NS" patch configmap raibit-registry-config --type=json -p "$patch" >/dev/null; then
      log "ERROR: registry ConfigMap changed concurrently; exact rollback was refused" >&2
      config_safe=0
    fi
  fi

  if [[ "$REGISTRY_TEMPLATE_CHANGED" == 1 && "$config_safe" == 1 ]]; then
    if [[ ! -f "$REGISTRY_STATEFULSET_APPLIED" ]]; then
      log "ERROR: registry StatefulSet applied snapshot is missing; exact rollback was refused" >&2
      return 1
    fi
    patch="$(
      jq -cn --slurpfile applied "$REGISTRY_STATEFULSET_APPLIED" --slurpfile previous "$REGISTRY_STATEFULSET_PREVIOUS" '
        [
          {"op":"test","path":"/metadata/uid","value":$applied[0].metadata.uid},
          {"op":"test","path":"/spec/template","value":$applied[0].spec.template},
          {"op":"replace","path":"/spec/template","value":$previous[0].spec.template}
        ]
      '
    )"
    if ! kubectl -n "$INFRA_NS" patch statefulset raibit-registry --type=json -p "$patch" >/dev/null; then
      log "ERROR: registry StatefulSet changed concurrently; exact rollback was refused" >&2
      return 1
    fi
    kubectl -n "$INFRA_NS" rollout status statefulset/raibit-registry --timeout=240s
  fi
}

rollback_registry_and_gateway() {
  local rollback_failed=0
  rollback_registry_state || rollback_failed=1
  rollback_gateway_resources || rollback_failed=1
  [[ "$rollback_failed" == 0 ]]
}

log "validating registry gateway manifests against the live API"
kubectl -n "$INFRA_NS" create configmap raibit-registry-config \
  --from-file=config.yml="$REGISTRY_CONFIG" \
  --dry-run=client -o yaml \
  | kubectl apply --dry-run=server -f - >/dev/null
kubectl apply --dry-run=server -f "$GATEWAY_MANIFEST" >/dev/null

log "applying and verifying the dedicated TLS gateway"
if ! kubectl apply -f "$GATEWAY_MANIFEST" >/dev/null; then
  capture_gateway_applied_state || true
  rollback_gateway_resources \
    || fail "registry gateway apply failed and exact gateway rollback also failed"
  fail "registry gateway resources could not be applied"
fi
if ! capture_gateway_applied_state; then
  rollback_gateway_resources \
    || fail "registry gateway readback failed and exact gateway rollback also failed"
  fail "registry gateway applied state could not be captured safely"
fi
if ! kubectl -n "$INFRA_NS" rollout status deployment/raibit-registry-auth --timeout=180s; then
  rollback_gateway_resources \
    || fail "registry gateway rollout failed and exact gateway rollback also failed"
  fail "registry gateway rollout failed"
fi

if ! GATEWAY_CLUSTER_IP_RAW="$(kubectl -n "$INFRA_NS" get service raibit-registry-auth -o jsonpath='{.spec.clusterIP}')"; then
  rollback_gateway_resources \
    || fail "gateway address lookup failed and exact gateway rollback also failed"
  fail "registry gateway ClusterIP could not be read"
fi
if ! GATEWAY_CLUSTER_IP="$(python3 - "$GATEWAY_CLUSTER_IP_RAW" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError as error:
    raise SystemExit(f'ERROR: invalid registry gateway ClusterIP: {error}') from error
if address.is_unspecified or address.is_loopback or address.is_link_local or address.is_multicast:
    raise SystemExit(f'ERROR: unsafe registry gateway ClusterIP: {address}')
print(address)
PY
)"; then
  rollback_gateway_resources \
    || fail "invalid gateway address and exact gateway rollback also failed"
  fail "registry gateway ClusterIP is invalid"
fi
if [[ "$GATEWAY_CLUSTER_IP" == *:* ]]; then
  GATEWAY_CURL_IP="[${GATEWAY_CLUSTER_IP}]"
else
  GATEWAY_CURL_IP="$GATEWAY_CLUSTER_IP"
fi

BROKER_HEALTHY=0
for attempt in $(seq 1 15); do
  if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    --resolve "${AUTH_HOST}:443:${GATEWAY_CURL_IP}" \
    "https://${AUTH_HOST}/healthz" >/dev/null; then
    BROKER_HEALTHY=1
    break
  fi
  [[ "$attempt" == 15 ]] || sleep 2
done
if [[ "$BROKER_HEALTHY" != 1 ]]; then
  rollback_gateway_resources \
    || fail "broker health check failed and exact gateway rollback also failed"
  fail "registry credential broker health check failed"
fi

APP_BROKER_TOKEN="${RUN_DIR}/app-broker-token"
RUNTIME_BROKER_TOKEN="${RUN_DIR}/runtime-broker-token"
if ! kubectl -n "$APP_NS" get secret "$BROKER_TOKEN_SECRET" -o jsonpath='{.data.token}' \
  | base64 -d >"$APP_BROKER_TOKEN"; then
  rollback_gateway_resources \
    || fail "builder token read failed and exact gateway rollback also failed"
  fail "builder broker token Secret could not be read"
fi
if ! kubectl -n "$INFRA_NS" get secret raibit-registry-broker-runtime -o json \
  | jq -r '.data["broker-token"]' \
  | base64 -d >"$RUNTIME_BROKER_TOKEN"; then
  rollback_gateway_resources \
    || fail "runtime token read failed and exact gateway rollback also failed"
  fail "registry broker runtime token could not be read"
fi
chmod 600 "$APP_BROKER_TOKEN" "$RUNTIME_BROKER_TOKEN"
APP_BROKER_TOKEN_DIGEST="$(sha256sum "$APP_BROKER_TOKEN" | awk '{print $1}')"
RUNTIME_BROKER_TOKEN_DIGEST="$(sha256sum "$RUNTIME_BROKER_TOKEN" | awk '{print $1}')"
[[ "$APP_BROKER_TOKEN_DIGEST" == "$RUNTIME_BROKER_TOKEN_DIGEST" ]] \
  || {
    rollback_gateway_resources \
      || fail "broker token mismatch and exact gateway rollback also failed"
    fail "builder and broker token Secrets do not match"
  }

BROKER_CURL_CONFIG="${RUN_DIR}/broker-curl.conf"
if ! python3 - "$APP_BROKER_TOKEN" "$BROKER_CURL_CONFIG" <<'PY'
from pathlib import Path
import re
import sys

token = Path(sys.argv[1]).read_text().strip()
if not re.fullmatch(r'[A-Za-z0-9._~+/=-]{16,1024}', token):
    raise SystemExit('ERROR: broker token contains unsafe or invalid characters')
Path(sys.argv[2]).write_text(f'header = "Authorization: Bearer {token}"\n')
PY
then
  rollback_gateway_resources \
    || fail "broker token validation failed and exact gateway rollback also failed"
  fail "broker token could not be validated safely"
fi
chmod 600 "$BROKER_CURL_CONFIG"

SMOKE_ORG='registry-reconcile-smoke-org'
SMOKE_PROJECT='registry-reconcile-smoke-project'
SMOKE_SERVICE='registry-reconcile-smoke-service'
SMOKE_JOB='registry-reconcile-smoke-job'
if ! SMOKE_REPOSITORY="$(python3 - "$REGISTRY_HOST" "$REGISTRY_PREFIX" "$SMOKE_ORG" "$SMOKE_PROJECT" "$SMOKE_SERVICE" <<'PY'
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
)"; then
  rollback_gateway_resources \
    || fail "broker smoke identity generation failed and exact gateway rollback also failed"
  fail "broker smoke identity could not be generated"
fi
BROKER_SMOKE_REQUEST="${RUN_DIR}/broker-smoke-request.json"
BROKER_SMOKE_RESPONSE="${RUN_DIR}/broker-smoke-response.json"
if ! jq -n \
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
  }' >"$BROKER_SMOKE_REQUEST"; then
  rollback_gateway_resources \
    || fail "broker smoke request generation failed and exact gateway rollback also failed"
  fail "broker smoke request could not be generated"
fi
if ! curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  --config "$BROKER_CURL_CONFIG" \
  --resolve "${AUTH_HOST}:443:${GATEWAY_CURL_IP}" \
  --header 'Content-Type: application/json' \
  --data-binary "@${BROKER_SMOKE_REQUEST}" \
  --output "$BROKER_SMOKE_RESPONSE" \
  "https://${AUTH_HOST}/broker"; then
  rollback_gateway_resources \
    || fail "broker issuance failed and exact gateway rollback also failed"
  fail "registry credential broker issuance smoke test failed"
fi
jq -e --arg repository "$SMOKE_REPOSITORY" '
  .repository == $repository
  and .username == "raibit-build"
  and ((.password | type) == "string")
  and (.password | startswith("rb1."))
  and ((.password | length) > 32)
  and ((.expiresAt | type) == "string")
  and ((.expiresAt | length) > 0)
' "$BROKER_SMOKE_RESPONSE" >/dev/null \
  || {
    rollback_gateway_resources \
      || fail "invalid broker response and exact gateway rollback also failed"
    fail "registry credential broker returned an invalid issuance response"
  }

log "applying relative registry URLs"
if ! jq -e --rawfile desired "$REGISTRY_CONFIG" '.data["config.yml"] == $desired' \
  "$REGISTRY_CONFIG_PREVIOUS" >/dev/null; then
  REGISTRY_CONFIG_PATCH="$(
    jq -cn --rawfile desired "$REGISTRY_CONFIG" --slurpfile previous "$REGISTRY_CONFIG_PREVIOUS" '
      [
        {"op":"test","path":"/data/config.yml","value":$previous[0].data["config.yml"]},
        {"op":"replace","path":"/data/config.yml","value":$desired}
      ]
    '
  )"
  if ! kubectl -n "$INFRA_NS" patch configmap raibit-registry-config \
    --type=json -p "$REGISTRY_CONFIG_PATCH" >/dev/null; then
    rollback_gateway_resources \
      || fail "registry ConfigMap conflict occurred and exact gateway rollback also failed"
    fail "registry ConfigMap changed concurrently; refusing to overwrite it"
  fi
  REGISTRY_CONFIG_CHANGED=1
fi

CONFIG_DIGEST="$(sha256sum "$REGISTRY_CONFIG" | awk '{print $1}')"
if ! kubectl -n "$INFRA_NS" get statefulset raibit-registry -o json >"$REGISTRY_STATEFULSET_PREVIOUS"; then
  rollback_registry_and_gateway \
    || fail "registry StatefulSet refresh failed and exact registry rollback also failed"
  fail "registry StatefulSet could not be refreshed before mutation"
fi
if ! jq -e --arg digest "$CONFIG_DIGEST" \
  '.spec.template.metadata.annotations["raibitserver.io/registry-config-sha256"] == $digest' \
  "$REGISTRY_STATEFULSET_PREVIOUS" >/dev/null; then
  REGISTRY_STATEFULSET_DESIRED="${RUN_DIR}/registry-statefulset.desired.json"
  if ! jq --arg digest "$CONFIG_DIGEST" '
    .spec.template.metadata.annotations = (.spec.template.metadata.annotations // {})
    | .spec.template.metadata.annotations["raibitserver.io/registry-config-sha256"] = $digest
  ' "$REGISTRY_STATEFULSET_PREVIOUS" >"$REGISTRY_STATEFULSET_DESIRED"; then
    rollback_registry_and_gateway \
      || fail "registry StatefulSet candidate generation failed and exact registry rollback also failed"
    fail "registry StatefulSet candidate could not be generated"
  fi
  if ! CONFIG_PATCH="$(
    jq -cn \
      --slurpfile previous "$REGISTRY_STATEFULSET_PREVIOUS" \
      --slurpfile desired "$REGISTRY_STATEFULSET_DESIRED" '
        [
          {"op":"test","path":"/metadata/uid","value":$previous[0].metadata.uid},
          {"op":"test","path":"/spec/template","value":$previous[0].spec.template},
          {"op":"replace","path":"/spec/template","value":$desired[0].spec.template}
        ]
      '
  )"; then
    rollback_registry_and_gateway \
      || fail "registry StatefulSet patch generation failed and exact registry rollback also failed"
    fail "registry StatefulSet patch could not be generated"
  fi
  if ! kubectl -n "$INFRA_NS" patch statefulset raibit-registry --type=json -p "$CONFIG_PATCH" >/dev/null; then
    rollback_registry_and_gateway \
      || fail "registry StatefulSet patch failed and exact registry rollback also failed"
    fail "registry StatefulSet changed concurrently; refusing to overwrite it"
  fi
  REGISTRY_TEMPLATE_CHANGED=1
elif [[ "$REGISTRY_CONFIG_CHANGED" == 1 ]]; then
  if ! REGISTRY_RESTART_NONCE="$(python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).isoformat(timespec='microseconds'))
PY
)"; then
    rollback_registry_and_gateway \
      || fail "registry restart nonce generation failed and exact registry rollback also failed"
    fail "registry restart nonce could not be generated"
  fi
  REGISTRY_STATEFULSET_DESIRED="${RUN_DIR}/registry-statefulset.desired.json"
  if ! jq --arg nonce "$REGISTRY_RESTART_NONCE" '
    .spec.template.metadata.annotations = (.spec.template.metadata.annotations // {})
    | .spec.template.metadata.annotations["raibitserver.io/registry-restarted-at"] = $nonce
  ' "$REGISTRY_STATEFULSET_PREVIOUS" >"$REGISTRY_STATEFULSET_DESIRED"; then
    rollback_registry_and_gateway \
      || fail "registry restart candidate generation failed and exact registry rollback also failed"
    fail "registry restart candidate could not be generated"
  fi
  if ! CONFIG_PATCH="$(
    jq -cn \
      --slurpfile previous "$REGISTRY_STATEFULSET_PREVIOUS" \
      --slurpfile desired "$REGISTRY_STATEFULSET_DESIRED" '
        [
          {"op":"test","path":"/metadata/uid","value":$previous[0].metadata.uid},
          {"op":"test","path":"/spec/template","value":$previous[0].spec.template},
          {"op":"replace","path":"/spec/template","value":$desired[0].spec.template}
        ]
      '
  )"; then
    rollback_registry_and_gateway \
      || fail "registry restart patch generation failed and exact registry rollback also failed"
    fail "registry restart patch could not be generated"
  fi
  if ! kubectl -n "$INFRA_NS" patch statefulset raibit-registry --type=json -p "$CONFIG_PATCH" >/dev/null; then
    rollback_registry_and_gateway \
      || fail "registry restart failed and exact registry rollback also failed"
    fail "registry StatefulSet changed concurrently; refusing to restart over it"
  fi
  REGISTRY_TEMPLATE_CHANGED=1
fi
if [[ "$REGISTRY_TEMPLATE_CHANGED" == 1 ]]; then
  REGISTRY_STATEFULSET_APPLIED="$REGISTRY_STATEFULSET_DESIRED"
  REGISTRY_STATEFULSET_READBACK="${RUN_DIR}/registry-statefulset.readback.json"
  if ! kubectl -n "$INFRA_NS" get statefulset raibit-registry -o json >"$REGISTRY_STATEFULSET_READBACK"; then
    rollback_registry_and_gateway \
      || fail "registry StatefulSet readback failed and exact registry rollback also failed"
    fail "registry StatefulSet applied state could not be read safely"
  fi
  if ! jq -e --slurpfile expected "$REGISTRY_STATEFULSET_APPLIED" '
    .metadata.uid == $expected[0].metadata.uid
    and .spec.template == $expected[0].spec.template
  ' "$REGISTRY_STATEFULSET_READBACK" >/dev/null; then
    rollback_registry_and_gateway \
      || fail "registry StatefulSet readback drifted and exact registry rollback was refused"
    fail "registry StatefulSet changed concurrently after the guarded patch"
  fi
fi
if ! kubectl -n "$INFRA_NS" rollout status statefulset/raibit-registry --timeout=240s; then
  rollback_registry_and_gateway \
    || fail "registry rollout failed and exact registry rollback also failed"
  fail "registry rollout failed"
fi

REGISTRY_HEADERS="${RUN_DIR}/registry-response-headers"
REGISTRY_STATUS=""
REGISTRY_REQUEST_OK=0
for attempt in $(seq 1 15); do
  if REGISTRY_STATUS="$(
    curl --silent --show-error --connect-timeout 5 --max-time 15 \
      --resolve "${REGISTRY_HOST}:443:${GATEWAY_CURL_IP}" \
      --dump-header "$REGISTRY_HEADERS" --output /dev/null --write-out '%{http_code}' \
      "https://${REGISTRY_HOST}/v2/"
  )"; then
    REGISTRY_REQUEST_OK=1
    [[ "$REGISTRY_STATUS" == 401 ]] && break
  else
    REGISTRY_REQUEST_OK=0
  fi
  [[ "$attempt" == 15 ]] || sleep 2
done
if [[ "$REGISTRY_STATUS" != 401 ]]; then
  rollback_registry_and_gateway \
    || fail "registry authentication check failed and exact registry rollback also failed"
  if [[ "$REGISTRY_REQUEST_OK" != 1 ]]; then
    fail "internal registry gateway request failed"
  fi
  fail "internal registry gateway must enforce token authentication"
fi
if ! python3 - "$REGISTRY_HEADERS" "$AUTH_HOST" "$REGISTRY_SERVICE" <<'PY'
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
then
  rollback_registry_and_gateway \
    || fail "registry challenge validation failed and exact registry rollback also failed"
  fail "internal registry authentication challenge is invalid"
fi

NODEHOSTS_CURRENT_FILE="${RUN_DIR}/NodeHosts.current"
NODEHOSTS_NEW_FILE="${RUN_DIR}/NodeHosts.new"
if ! python3 - "$COREDNS_JSON" "$NODEHOSTS_CURRENT_FILE" <<'PY'
import json
from pathlib import Path
import sys

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
data = json.loads(source.read_text())
node_hosts = data.get('data', {}).get('NodeHosts')
if not isinstance(node_hosts, str):
    raise SystemExit('ERROR: CoreDNS NodeHosts must be a string')
destination.write_text(node_hosts)
PY
then
  rollback_registry_and_gateway \
    || fail "CoreDNS input validation failed and exact registry rollback also failed"
  fail "CoreDNS NodeHosts could not be read safely"
fi
if ! python3 - "$NODEHOSTS_CURRENT_FILE" "$NODEHOSTS_NEW_FILE" \
  "$GATEWAY_CLUSTER_IP" "$REGISTRY_HOST" "$AUTH_HOST" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
gateway_ip, registry_host, auth_host = sys.argv[3:]
blocked = {registry_host, auth_host}
output = []

for raw_line in source.read_text().splitlines():
    stripped = raw_line.strip()
    if not stripped or stripped.startswith('#'):
        output.append(raw_line)
        continue
    parts = stripped.split()
    if len(parts) < 2:
        output.append(raw_line)
        continue
    remaining = [host for host in parts[1:] if host not in blocked]
    if remaining:
        output.append(' '.join([parts[0], *remaining]))

while output and not output[-1].strip():
    output.pop()
output.append(f'{gateway_ip} {registry_host} {auth_host}')
destination.write_text('\n'.join(output) + '\n')
PY
then
  rollback_registry_and_gateway \
    || fail "CoreDNS transform failed and exact registry rollback also failed"
  fail "CoreDNS split-DNS candidate could not be generated"
fi

LEGACY_OVERRIDE_CURRENT_FILE="${RUN_DIR}/legacy-registry-override.current"
LEGACY_OVERRIDE_NEW_FILE="${RUN_DIR}/legacy-registry-override.new"
if ! python3 - "$COREDNS_CUSTOM_JSON" \
  "$LEGACY_OVERRIDE_CURRENT_FILE" "$LEGACY_OVERRIDE_NEW_FILE" \
  "$BASE_DOMAIN" "$GATEWAY_CLUSTER_IP" "$REGISTRY_HOST" "$AUTH_HOST" <<'PY'
import json
from pathlib import Path
import sys

source = Path(sys.argv[1])
current = Path(sys.argv[2])
replacement = Path(sys.argv[3])
base_domain, gateway_ip, registry_host, auth_host = sys.argv[4:]
text = source.read_text().strip()
if not text:
    raise SystemExit(0)
data = json.loads(text)
legacy = data.get('data', {}).get('raibit-registry.server')
if legacy is None:
    raise SystemExit(0)
if not isinstance(legacy, str):
    raise SystemExit('ERROR: legacy CoreDNS registry override must be a string')
current.write_text(legacy)
replacement.write_text(
    f'{base_domain}:53 {{\n'
    '  hosts {\n'
    f'    {gateway_ip} {registry_host} {auth_host}\n'
    '    fallthrough\n'
    '  }\n'
    '  forward . /etc/resolv.conf\n'
    '  cache 30\n'
    '}'
)
PY
then
  rollback_registry_and_gateway \
    || fail "legacy CoreDNS input validation failed and exact registry rollback also failed"
  fail "legacy CoreDNS registry override could not be read safely"
fi

rollback_coredns_nodehosts() {
  local patch
  patch="$(
    jq -cn --rawfile expected "$NODEHOSTS_NEW_FILE" --rawfile previous "$NODEHOSTS_CURRENT_FILE" \
      '[{"op":"test","path":"/data/NodeHosts","value":$expected},{"op":"replace","path":"/data/NodeHosts","value":$previous}]'
  )"
  if ! kubectl -n kube-system patch configmap coredns --type=json -p "$patch" >/dev/null; then
    log "ERROR: CoreDNS NodeHosts changed concurrently; exact rollback was refused" >&2
    return 1
  fi
}

rollback_coredns_legacy_override() {
  local patch
  patch="$(
    jq -cn --rawfile expected "$LEGACY_OVERRIDE_NEW_FILE" --rawfile previous "$LEGACY_OVERRIDE_CURRENT_FILE" \
      '[{"op":"test","path":"/data/raibit-registry.server","value":$expected},{"op":"replace","path":"/data/raibit-registry.server","value":$previous}]'
  )"
  if ! kubectl -n kube-system patch configmap coredns-custom --type=json -p "$patch" >/dev/null; then
    log "ERROR: legacy CoreDNS registry override changed concurrently; exact rollback was refused" >&2
    return 1
  fi
}

rollback_coredns_configuration() {
  local rollback_failed=0
  local restart_required=0
  if [[ "$COREDNS_CHANGED" == 1 ]]; then
    rollback_coredns_nodehosts || rollback_failed=1
    restart_required=1
  fi
  if [[ "$COREDNS_LEGACY_CHANGED" == 1 ]]; then
    rollback_coredns_legacy_override || rollback_failed=1
    restart_required=1
  fi
  if [[ "$restart_required" == 1 ]]; then
    kubectl -n kube-system rollout restart deployment/coredns >/dev/null || rollback_failed=1
    kubectl -n kube-system rollout status deployment/coredns --timeout=120s || rollback_failed=1
  fi
  [[ "$rollback_failed" == 0 ]]
}

rollback_coredns_registry_and_gateway() {
  local rollback_failed=0
  rollback_coredns_configuration || rollback_failed=1
  rollback_registry_and_gateway || rollback_failed=1
  [[ "$rollback_failed" == 0 ]]
}

COREDNS_CHANGED=0
COREDNS_LEGACY_CHANGED=0
if [[ -f "$LEGACY_OVERRIDE_CURRENT_FILE" ]] \
  && ! cmp -s "$LEGACY_OVERRIDE_NEW_FILE" "$LEGACY_OVERRIDE_CURRENT_FILE"; then
  LEGACY_OVERRIDE_PATCH="$(
    jq -cn --rawfile old "$LEGACY_OVERRIDE_CURRENT_FILE" --rawfile new "$LEGACY_OVERRIDE_NEW_FILE" \
      '[{"op":"test","path":"/data/raibit-registry.server","value":$old},{"op":"replace","path":"/data/raibit-registry.server","value":$new}]'
  )"
  if ! kubectl -n kube-system patch configmap coredns-custom --type=json -p "$LEGACY_OVERRIDE_PATCH" >/dev/null; then
    rollback_registry_and_gateway \
      || fail "legacy CoreDNS conflict occurred and exact registry rollback also failed"
    fail "legacy CoreDNS registry override changed concurrently; refusing to overwrite it"
  fi
  COREDNS_LEGACY_CHANGED=1
fi
if ! cmp -s "$NODEHOSTS_NEW_FILE" "$NODEHOSTS_CURRENT_FILE"; then
  COREDNS_PATCH="$(
    jq -cn --rawfile old "$NODEHOSTS_CURRENT_FILE" --rawfile new "$NODEHOSTS_NEW_FILE" \
      '[{"op":"test","path":"/data/NodeHosts","value":$old},{"op":"replace","path":"/data/NodeHosts","value":$new}]'
  )"
  if ! kubectl -n kube-system patch configmap coredns --type=json -p "$COREDNS_PATCH" >/dev/null; then
    rollback_coredns_registry_and_gateway \
      || fail "CoreDNS conflict occurred and exact registry rollback also failed"
    fail "CoreDNS NodeHosts changed concurrently; refusing to overwrite it"
  fi
  COREDNS_CHANGED=1
fi
if [[ "$COREDNS_CHANGED" == 1 || "$COREDNS_LEGACY_CHANGED" == 1 ]]; then
  if ! kubectl -n kube-system rollout restart deployment/coredns >/dev/null; then
    rollback_coredns_registry_and_gateway \
      || fail "CoreDNS restart failed and exact full rollback also failed"
    fail "CoreDNS restart failed; the previous registry state was restored"
  fi
  if ! kubectl -n kube-system rollout status deployment/coredns --timeout=120s; then
    rollback_coredns_registry_and_gateway \
      || fail "CoreDNS rollout failed and exact full rollback also failed"
    fail "CoreDNS rollout failed; the previous registry state was restored"
  fi
fi

NODEHOSTS_APPLIED_FILE="${RUN_DIR}/NodeHosts.applied"
if ! kubectl -n kube-system get configmap coredns -o jsonpath='{.data.NodeHosts}' >"$NODEHOSTS_APPLIED_FILE"; then
  rollback_coredns_registry_and_gateway \
    || fail "CoreDNS readback failed and exact full rollback also failed"
  fail "CoreDNS NodeHosts could not be read back"
fi
if ! cmp -s "$NODEHOSTS_APPLIED_FILE" "$NODEHOSTS_NEW_FILE"; then
  rollback_coredns_registry_and_gateway \
    || fail "CoreDNS verification failed and exact full rollback also failed"
  fail "CoreDNS NodeHosts verification failed"
fi
if ! python3 - "$NODEHOSTS_APPLIED_FILE" "$GATEWAY_CLUSTER_IP" "$REGISTRY_HOST" "$AUTH_HOST" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
gateway_ip, registry_host, auth_host = sys.argv[2:]
matches = []
for line in path.read_text().splitlines():
    parts = line.split()
    if len(parts) >= 2 and ({registry_host, auth_host} & set(parts[1:])):
        matches.append(parts)
if matches != [[gateway_ip, registry_host, auth_host]]:
    raise SystemExit('ERROR: registry hostnames must resolve exactly once to the dedicated gateway')
PY
then
  rollback_coredns_registry_and_gateway \
    || fail "CoreDNS identity verification failed and exact full rollback also failed"
  fail "CoreDNS registry host identity verification failed"
fi

COREDNS_CUSTOM_APPLIED="${RUN_DIR}/coredns-custom.applied.json"
if ! kubectl -n kube-system get configmap coredns-custom --ignore-not-found -o json >"$COREDNS_CUSTOM_APPLIED"; then
  rollback_coredns_registry_and_gateway \
    || fail "legacy CoreDNS readback failed and exact full rollback also failed"
  fail "optional CoreDNS custom ConfigMap could not be read back"
fi
if ! python3 - "$COREDNS_CUSTOM_APPLIED" \
  "$GATEWAY_CLUSTER_IP" "$REGISTRY_HOST" "$AUTH_HOST" <<'PY'
import json
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text().strip()
if not text:
    raise SystemExit(0)
data = json.loads(text)
gateway_ip, registry_host, auth_host = sys.argv[2:]
legacy = data.get('data', {}).get('raibit-registry.server')
if legacy is None:
    raise SystemExit(0)
if not isinstance(legacy, str):
    raise SystemExit('ERROR: legacy CoreDNS registry override must be a string')
matches = []
for line in legacy.splitlines():
    parts = line.split()
    if len(parts) >= 2 and ({registry_host, auth_host} & set(parts[1:])):
        matches.append(parts)
if matches != [[gateway_ip, registry_host, auth_host]]:
    raise SystemExit('ERROR: legacy CoreDNS registry override bypasses the private gateway')
PY
then
  rollback_coredns_registry_and_gateway \
    || fail "legacy CoreDNS verification failed and exact full rollback also failed"
  fail "legacy CoreDNS registry override verification failed"
fi

VALUES_TMP=""
if ! VALUES_TMP="$(mktemp "${CONFIG_DIR}/.workload-registry-values.yaml.XXXXXX")"; then
  rollback_coredns_registry_and_gateway \
    || fail "registry overlay staging failed and exact full rollback also failed"
  fail "registry overlay staging file could not be created"
fi
if ! render_registry_values >"$VALUES_TMP"; then
  rm -f -- "$VALUES_TMP"
  rollback_coredns_registry_and_gateway \
    || fail "registry overlay rendering failed and exact full rollback also failed"
  fail "registry overlay could not be rendered"
fi
if ! chmod 600 "$VALUES_TMP"; then
  rm -f -- "$VALUES_TMP"
  rollback_coredns_registry_and_gateway \
    || fail "registry overlay permission update failed and exact full rollback also failed"
  fail "registry overlay permissions could not be secured"
fi
if ! mv -f -- "$VALUES_TMP" "$REGISTRY_VALUES_FILE"; then
  rm -f -- "$VALUES_TMP"
  rollback_coredns_registry_and_gateway \
    || fail "registry overlay installation failed and exact full rollback also failed"
  fail "registry overlay could not be installed"
fi

log "registry gateway reconciled with an immutable image and exact split DNS"
