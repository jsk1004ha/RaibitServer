#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${HOME:?HOME is required}"

BASE_DOMAIN="${BASE_DOMAIN:-raibit.kr}"
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
REGISTRY_VERSION="${REGISTRY_VERSION:-3.1.1}"
REGISTRY_STORAGE="${REGISTRY_STORAGE:-100Gi}"
CONFIG_DIR="${HOME}/.config/raibitserver"
REGISTRY_ENV_FILE="${CONFIG_DIR}/workload-registry.env"
REGISTRY_VALUES_FILE="${CONFIG_DIR}/workload-registry-values.yaml"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
VERSION="$(git rev-parse --short=12 HEAD)"
BROKER_IMAGE="docker.io/library/raibit-registry-broker:${VERSION}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: required command missing: $1" >&2; exit 1; }
}
for cmd in kubectl docker openssl jq curl awk sed grep base64 sha256sum python3 mktemp chmod mv mkdir; do need "$cmd"; done

python3 - "$REGISTRY_HOST" "$AUTH_HOST" "$REGISTRY_PREFIX" <<'PY'
import re
import sys

host_pattern = re.compile(r'^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$', re.IGNORECASE)
prefix_pattern = re.compile(r'^[a-z0-9]+(?:[._/-][a-z0-9]+)*$', re.IGNORECASE)

for label, value in [('registry host', sys.argv[1]), ('broker host', sys.argv[2])]:
    if not host_pattern.fullmatch(value):
        raise SystemExit(f'ERROR: invalid {label}: {value}')
if not prefix_pattern.fullmatch(sys.argv[3]):
    raise SystemExit(f'ERROR: invalid registry prefix: {sys.argv[3]}')
PY

NODE_IP="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
[ -n "$NODE_IP" ] || { echo "ERROR: unable to resolve Kubernetes node InternalIP" >&2; exit 1; }
NODE_IP="$(python3 - "$NODE_IP" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError as error:
    raise SystemExit(f'ERROR: invalid Kubernetes node InternalIP: {error}') from error

if address.is_unspecified or address.is_loopback or address.is_link_local or address.is_multicast:
    raise SystemExit(f'ERROR: unsafe Kubernetes node InternalIP: {address}')
print(address)
PY
)"

echo "=== RaibitServer workload registry bootstrap ==="
echo "registry:     ${REGISTRY_HOST}/${REGISTRY_PREFIX}"
echo "auth/broker: https://${AUTH_HOST}"
echo "node IP:      ${NODE_IP}"
echo

kubectl get namespace "$INFRA_NS" >/dev/null
kubectl get namespace "$APP_NS" >/dev/null
kubectl -n "$INFRA_NS" get secret "$TLS_SECRET" >/dev/null || {
  echo "ERROR: TLS secret $INFRA_NS/$TLS_SECRET is missing" >&2
  exit 1
}

CERT_SANS="$(kubectl -n "$INFRA_NS" get secret "$TLS_SECRET" -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -ext subjectAltName 2>/dev/null || true)"
grep -Fq "DNS:${REGISTRY_HOST}" <<<"$CERT_SANS" || { echo "ERROR: TLS certificate does not cover $REGISTRY_HOST" >&2; exit 1; }
grep -Fq "DNS:${AUTH_HOST}" <<<"$CERT_SANS" || { echo "ERROR: TLS certificate does not cover $AUTH_HOST" >&2; exit 1; }

echo "=== 1. Build broker image and import into K3s ==="
docker buildx build \
  --builder raibit-prod-builder \
  --platform linux/amd64 \
  --load \
  -f services/registry-broker/Dockerfile \
  -t "$BROKER_IMAGE" \
  .

docker save "$BROKER_IMAGE" | sudo k3s ctr -n k8s.io images import - >/dev/null
sudo k3s ctr -n k8s.io images ls | grep -F "raibit-registry-broker:${VERSION}" >/dev/null

echo "broker image imported: $BROKER_IMAGE"

echo
echo "=== 2. Resolve immutable Distribution image ==="
REGISTRY_DIGEST="$(docker buildx imagetools inspect "registry:${REGISTRY_VERSION}" | awk '$1=="Digest:" {print $2; exit}')"
[[ "$REGISTRY_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "ERROR: failed to resolve registry:${REGISTRY_VERSION} digest" >&2; exit 1; }
REGISTRY_IMAGE="docker.io/library/registry@${REGISTRY_DIGEST}"
echo "registry image: $REGISTRY_IMAGE"

echo
echo "=== 3. Ensure Builder broker token ==="
if ! kubectl -n "$APP_NS" get secret "$BROKER_TOKEN_SECRET" >/dev/null 2>&1; then
  BROKER_TOKEN_NEW="$(openssl rand -hex 32)"
  kubectl -n "$APP_NS" create secret generic "$BROKER_TOKEN_SECRET" \
    --from-literal=token="$BROKER_TOKEN_NEW"
  unset BROKER_TOKEN_NEW
fi
BROKER_TOKEN="$(kubectl -n "$APP_NS" get secret "$BROKER_TOKEN_SECRET" -o jsonpath='{.data.token}' | base64 -d)"
[ -n "$BROKER_TOKEN" ] || { echo "ERROR: broker token is empty" >&2; exit 1; }

echo
echo "=== 4. Create registry token signing key ==="
SIGN_DIR="$HOME/.config/raibitserver/registry-auth"
mkdir -p "$SIGN_DIR"
chmod 700 "$SIGN_DIR"
if [ ! -s "$SIGN_DIR/token.key" ] || [ ! -s "$SIGN_DIR/token.crt" ]; then
  umask 077
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$SIGN_DIR/token.key"
  openssl req -new -x509 -sha256 -days 3650 \
    -key "$SIGN_DIR/token.key" \
    -out "$SIGN_DIR/token.crt" \
    -subj "/CN=raibit-registry-token-signer"
fi
openssl x509 -in "$SIGN_DIR/token.crt" -noout -subject -dates

kubectl -n "$INFRA_NS" create secret generic raibit-registry-token-signer \
  --from-file=token.key="$SIGN_DIR/token.key" \
  --from-file=token.crt="$SIGN_DIR/token.crt" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

if kubectl -n "$INFRA_NS" get secret raibit-registry-broker-runtime >/dev/null 2>&1; then
  SESSION_HMAC_KEY="$(kubectl -n "$INFRA_NS" get secret raibit-registry-broker-runtime -o jsonpath='{.data.session-hmac-key}' | base64 -d)"
else
  SESSION_HMAC_KEY="$(openssl rand -hex 32)"
fi

kubectl -n "$INFRA_NS" create secret generic raibit-registry-broker-runtime \
  --from-literal=broker-token="$BROKER_TOKEN" \
  --from-literal=session-hmac-key="$SESSION_HMAC_KEY" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

if kubectl -n "$INFRA_NS" get secret raibit-registry-runtime >/dev/null 2>&1; then
  REGISTRY_HTTP_SECRET="$(kubectl -n "$INFRA_NS" get secret raibit-registry-runtime -o jsonpath='{.data.http-secret}' | base64 -d)"
else
  REGISTRY_HTTP_SECRET="$(openssl rand -hex 32)"
fi
kubectl -n "$INFRA_NS" create secret generic raibit-registry-runtime \
  --from-literal=http-secret="$REGISTRY_HTTP_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

unset SESSION_HMAC_KEY REGISTRY_HTTP_SECRET

echo
echo "=== 5. Registry configuration ==="
cat > /tmp/raibit-registry-config.yml <<EOF
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
kubectl -n "$INFRA_NS" create configmap raibit-registry-config \
  --from-file=config.yml=/tmp/raibit-registry-config.yml \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
rm -f /tmp/raibit-registry-config.yml

echo
echo "=== 6. Deploy registry + broker + HTTPS ingresses ==="
cat > /tmp/raibit-registry-stack.yaml <<EOF
apiVersion: v1
kind: Service
metadata:
  name: raibit-registry
  namespace: ${INFRA_NS}
spec:
  type: ClusterIP
  selector:
    app: raibit-registry
  ports:
    - name: registry
      port: 5000
      targetPort: 5000
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: raibit-registry
  namespace: ${INFRA_NS}
spec:
  serviceName: raibit-registry
  replicas: 1
  selector:
    matchLabels:
      app: raibit-registry
  template:
    metadata:
      labels:
        app: raibit-registry
    spec:
      securityContext:
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: registry
          image: ${REGISTRY_IMAGE}
          imagePullPolicy: IfNotPresent
          env:
            - name: REGISTRY_HTTP_SECRET
              valueFrom:
                secretKeyRef:
                  name: raibit-registry-runtime
                  key: http-secret
          ports:
            - name: registry
              containerPort: 5000
          readinessProbe:
            tcpSocket:
              port: registry
            initialDelaySeconds: 3
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 12
          livenessProbe:
            tcpSocket:
              port: registry
            initialDelaySeconds: 15
            periodSeconds: 20
            timeoutSeconds: 3
            failureThreshold: 5
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: "2"
              memory: 1Gi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: data
              mountPath: /var/lib/registry
            - name: config
              mountPath: /etc/distribution/config.yml
              subPath: config.yml
              readOnly: true
            - name: token-signer
              mountPath: /etc/distribution/token.crt
              subPath: token.crt
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: raibit-registry-config
        - name: token-signer
          secret:
            secretName: raibit-registry-token-signer
            items:
              - key: token.crt
                path: token.crt
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: local-path
        resources:
          requests:
            storage: ${REGISTRY_STORAGE}
---
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
          image: ${BROKER_IMAGE}
          imagePullPolicy: Never
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
  name: raibit-registry
  namespace: ${INFRA_NS}
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
spec:
  ingressClassName: traefik
  tls:
    - hosts: ["${REGISTRY_HOST}"]
      secretName: ${TLS_SECRET}
  rules:
    - host: ${REGISTRY_HOST}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: raibit-registry
                port:
                  number: 5000
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
              app.kubernetes.io/name: raibit-registry-auth
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
EOF
kubectl apply -f /tmp/raibit-registry-stack.yaml
rm -f /tmp/raibit-registry-stack.yaml

kubectl -n "$INFRA_NS" rollout status statefulset/raibit-registry --timeout=240s
kubectl -n "$INFRA_NS" rollout status deployment/raibit-registry-auth --timeout=180s
GATEWAY_CLUSTER_IP="$(kubectl -n "$INFRA_NS" get service raibit-registry-auth -o jsonpath='{.spec.clusterIP}')"
GATEWAY_CLUSTER_IP="$(python3 - "$GATEWAY_CLUSTER_IP" <<'PY'
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
)"
if [[ "$GATEWAY_CLUSTER_IP" == *:* ]]; then
  GATEWAY_CURL_IP="[${GATEWAY_CLUSTER_IP}]"
else
  GATEWAY_CURL_IP="$GATEWAY_CLUSTER_IP"
fi

echo
echo "=== 7. Internal split DNS ==="
# K3s CoreDNS already uses the hosts plugin against the NodeHosts key. Extend
# that existing file rather than loading a second hosts plugin.
NODEHOSTS="$(kubectl -n kube-system get configmap coredns -o jsonpath='{.data.NodeHosts}')"
NODEHOSTS_FILTERED="$(printf '%s\n' "$NODEHOSTS" | grep -Ev "[[:space:]](${REGISTRY_HOST//./\\.}|${AUTH_HOST//./\\.})([[:space:]]|$)" || true)"
NODEHOSTS_NEW="${NODEHOSTS_FILTERED}"$'\n'"${GATEWAY_CLUSTER_IP} ${REGISTRY_HOST} ${AUTH_HOST}"$'\n'
NODEHOSTS_JSON="$(printf '%s' "$NODEHOSTS_NEW" | jq -Rs .)"
kubectl -n kube-system patch configmap coredns --type=merge \
  -p "{\"data\":{\"NodeHosts\":${NODEHOSTS_JSON}}}" >/dev/null
kubectl -n kube-system rollout restart deployment/coredns >/dev/null
kubectl -n kube-system rollout status deployment/coredns --timeout=120s

sudo cp /etc/hosts "/etc/hosts.raibit.bak.$(date +%s)"
sudo sed -i -E "/[[:space:]](${REGISTRY_HOST//./\\.}|${AUTH_HOST//./\\.})([[:space:]]|$)/d" /etc/hosts
printf '%s %s %s\n' "$NODE_IP" "$REGISTRY_HOST" "$AUTH_HOST" | sudo tee -a /etc/hosts >/dev/null

getent hosts "$REGISTRY_HOST"
getent hosts "$AUTH_HOST"

curl --fail --silent --show-error \
  --resolve "${AUTH_HOST}:443:${GATEWAY_CURL_IP}" \
  "https://${AUTH_HOST}/healthz" >/dev/null
GATEWAY_REGISTRY_STATUS="$(curl --silent --show-error \
  --resolve "${REGISTRY_HOST}:443:${GATEWAY_CURL_IP}" \
  --output /dev/null \
  --write-out '%{http_code}' \
  "https://${REGISTRY_HOST}/v2/")"
[[ "$GATEWAY_REGISTRY_STATUS" == 200 || "$GATEWAY_REGISTRY_STATUS" == 401 ]] \
  || { echo "ERROR: internal registry gateway returned HTTP ${GATEWAY_REGISTRY_STATUS}" >&2; exit 1; }
echo "dedicated in-cluster TLS gateway VERIFIED: ${GATEWAY_CLUSTER_IP}"

echo
echo "=== 8. HTTPS/token/broker smoke tests ==="
curl -fsS "https://${AUTH_HOST}/healthz" >/dev/null
CHALLENGE="$(curl -sSI "https://${REGISTRY_HOST}/v2/" | tr -d '\r' | grep -i '^www-authenticate:' || true)"
grep -Fq "https://${AUTH_HOST}/token" <<<"$CHALLENGE" || { echo "ERROR: registry auth challenge is missing expected token realm" >&2; echo "$CHALLENGE" >&2; exit 1; }

seg() {
  local kind="$1" value="$2"
  printf 'raibitserver-registry-segment-v1\0%s\0%s' "$kind" "$value" | sha256sum | awk '{print substr($1,1,24)}'
}
SMOKE_ORG="registry-smoke-org"
SMOKE_PROJECT="registry-smoke-project"
SMOKE_SERVICE="registry-smoke-service"
SMOKE_JOB="registry-smoke-job-$(date +%s)"
SMOKE_REPO="${REGISTRY_HOST}/${REGISTRY_PREFIX}/org-$(seg org "$SMOKE_ORG")/project-$(seg project "$SMOKE_PROJECT")/service-$(seg service "$SMOKE_SERVICE")"

BROKER_RESPONSE="$(curl -fsS \
  -X POST "https://${AUTH_HOST}/broker" \
  -H "Authorization: Bearer ${BROKER_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<EOF
{"organizationId":"${SMOKE_ORG}","projectId":"${SMOKE_PROJECT}","serviceId":"${SMOKE_SERVICE}","jobId":"${SMOKE_JOB}","repository":"${SMOKE_REPO}","actions":["pull","push"],"minTtlSeconds":840,"maxTtlSeconds":900}
EOF
)"

[ "$(jq -r '.repository' <<<"$BROKER_RESPONSE")" = "$SMOKE_REPO" ] || { echo "ERROR: broker returned wrong repository" >&2; exit 1; }
BROKER_USERNAME="$(jq -r '.username' <<<"$BROKER_RESPONSE")"
BROKER_PASSWORD="$(jq -r '.password' <<<"$BROKER_RESPONSE")"
[ -n "$BROKER_PASSWORD" ] && [ "$BROKER_PASSWORD" != null ] || { echo "ERROR: broker returned no password" >&2; exit 1; }
echo "$BROKER_RESPONSE" | jq '{repository,username,expiresAt,passwordLength:(.password|length)}'

echo "$BROKER_PASSWORD" | docker login "$REGISTRY_HOST" -u "$BROKER_USERNAME" --password-stdin >/dev/null
SMOKE_IMAGE="${SMOKE_REPO}:bootstrap-smoke"
docker tag "$BROKER_IMAGE" "$SMOKE_IMAGE"
docker push "$SMOKE_IMAGE"
docker logout "$REGISTRY_HOST" >/dev/null

docker image rm "$SMOKE_IMAGE" >/dev/null 2>&1 || true
docker pull "$SMOKE_IMAGE" >/dev/null
echo "registry authenticated PUSH + anonymous PULL VERIFIED"

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

REGISTRY_ENV_TMP="$(mktemp "${CONFIG_DIR}/.workload-registry.env.XXXXXX")"
cat > "$REGISTRY_ENV_TMP" <<EOF
REGISTRY_HOST=${REGISTRY_HOST}
REGISTRY_PREFIX=${REGISTRY_PREFIX}
BUILDER_REGISTRY=${REGISTRY_HOST}/${REGISTRY_PREFIX}
REGISTRY_BROKER_URL=https://${AUTH_HOST}/broker
REGISTRY_BROKER_SECRET=${BROKER_TOKEN_SECRET}
REGISTRY_IMAGE=${REGISTRY_IMAGE}
BROKER_BOOTSTRAP_IMAGE=${BROKER_IMAGE}
REGISTRY_GATEWAY_SERVICE=${INFRA_NS}/raibit-registry-auth
REGISTRY_GATEWAY_CLUSTER_IP=${GATEWAY_CLUSTER_IP}
REGISTRY_VALUES_FILE=${REGISTRY_VALUES_FILE}
EOF
chmod 600 "$REGISTRY_ENV_TMP"
mv -f -- "$REGISTRY_ENV_TMP" "$REGISTRY_ENV_FILE"

REGISTRY_VALUES_TMP="$(mktemp "${CONFIG_DIR}/.workload-registry-values.yaml.XXXXXX")"
cat > "$REGISTRY_VALUES_TMP" <<EOF
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
chmod 600 "$REGISTRY_VALUES_TMP"
mv -f -- "$REGISTRY_VALUES_TMP" "$REGISTRY_VALUES_FILE"

unset BROKER_TOKEN BROKER_USERNAME BROKER_PASSWORD BROKER_RESPONSE

echo
echo "=== COMPLETE ==="
echo "builder.registry: ${REGISTRY_HOST}/${REGISTRY_PREFIX}"
echo "broker URL:       https://${AUTH_HOST}/broker"
echo "broker Secret:    ${BROKER_TOKEN_SECRET}"
echo "saved env:        ${REGISTRY_ENV_FILE}"
echo "saved Helm values: ${REGISTRY_VALUES_FILE}"
kubectl -n "$INFRA_NS" get pod,pvc,svc,ingress | grep -E 'NAME|raibit-registry'
