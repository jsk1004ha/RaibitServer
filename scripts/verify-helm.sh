#!/usr/bin/env sh
set -eu

# Git Bash otherwise rewrites Helm --set values that begin with '/' into Windows paths.
case "$(uname -s)" in
  MINGW*|MSYS*) export MSYS2_ARG_CONV_EXCL='security.imageVerification.admissionController.clientConfig.url.path=' ;;
esac

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CHART="$ROOT_DIR/infra/helm/raibitserver"
PRODUCTION_VALUES="$CHART/ci-production-values.yaml"
HELM=${HELM_BIN:-helm}
OUTPUT_DIR=$(mktemp -d)
trap 'rm -rf "$OUTPUT_DIR"' EXIT HUP INT TERM

"$HELM" lint "$CHART"
"$HELM" template raibitserver "$CHART" --namespace raibitserver-system --include-crds >"$OUTPUT_DIR/default.yaml"
"$HELM" lint "$CHART" --values "$PRODUCTION_VALUES"
"$HELM" template raibitserver "$CHART" --namespace raibitserver-system --values "$PRODUCTION_VALUES" --include-crds >"$OUTPUT_DIR/production.yaml"
"$HELM" template secondary "$CHART" --namespace raibitserver-secondary --values "$PRODUCTION_VALUES" >"$OUTPUT_DIR/secondary-release.yaml"
"$HELM" template raibitserver "$CHART" --namespace raibitserver-system --values "$PRODUCTION_VALUES" \
  --set-string ingress.gatewayNamespace=edge-gateway-system \
  --set-string ingress.className=internal.ingress.example.com >"$OUTPUT_DIR/configured-ingress-gateway.yaml"
"$HELM" template raibitserver "$CHART" --namespace raibitserver-system --values "$PRODUCTION_VALUES" \
  --set-string security.imageVerification.admissionController.clientConfig.service.namespace= \
  --set-string security.imageVerification.admissionController.clientConfig.service.name= \
  --set-string security.imageVerification.admissionController.clientConfig.service.path= \
  --set-string security.imageVerification.admissionController.clientConfig.url.host=verifier.policy.example \
  --set-string security.imageVerification.admissionController.clientConfig.url.path=/validate >"$OUTPUT_DIR/production-with-url-verifier.yaml"
"$HELM" template raibitserver "$CHART" --namespace raibitserver-system --values "$PRODUCTION_VALUES" \
  --set-json 'builder.databaseEgress.selectorPeers=[{"namespaceSelector":{"kubernetes.io/metadata.name":"database-system"},"podSelector":{"app.kubernetes.io/name":"postgres"}}]' \
  --set-json 'builder.databaseEgress.cidrs=[]' >"$OUTPUT_DIR/production-with-selector-db-egress.yaml"
"$HELM" template raibitserver "$CHART" --namespace raibitserver-system --values "$PRODUCTION_VALUES" \
  --set builder.registryCredentials.privateGateway.enabled=true \
  --set-string builder.registryCredentials.privateGateway.namespace=raibitserver-infra \
  --set-string builder.registryCredentials.privateGateway.podName=raibit-registry-auth \
  --set builder.registryCredentials.privateGateway.servicePort=443 \
  --set builder.registryCredentials.privateGateway.port=8443 >"$OUTPUT_DIR/production-with-private-registry-gateway.yaml"

grep -q 'helm.sh/hook: pre-install,pre-upgrade' "$OUTPUT_DIR/production.yaml"
grep -q 'kind: ValidatingAdmissionPolicy' "$OUTPUT_DIR/production.yaml"
grep -q 'kind: CustomResourceDefinition' "$OUTPUT_DIR/production.yaml"
grep -q 'app.kubernetes.io/name: raibitserver-dashboard' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_CONSOLE_URL' "$OUTPUT_DIR/production.yaml"
grep -q 'value: "https://console.production.example/console"' "$OUTPUT_DIR/production.yaml"
grep -q 'host: "production.example"' "$OUTPUT_DIR/production.yaml"
if grep -q 'RAIBITSERVER_COOKIE_DOMAIN\|RAIBITSERVER_DASHBOARD_ORIGIN' "$OUTPUT_DIR/production.yaml"; then
  echo "dual-host dashboard must keep host-only cookies and request-derived origins" >&2
  exit 1
fi
grep -q 'kind: CronJob' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-builder-dispatcher' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-builder-executor' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_CONTROL_PLANE_REMOTE_URL' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_DISPATCH_CLIENT_CERT_FILE' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_BUILDER_ISOLATION' "$OUTPUT_DIR/production.yaml"
grep -q 'value: "single-job-pod"' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_RUN_ONCE' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_BUILD_TIMEOUT_SECONDS' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_REGISTRY_CREDENTIAL_MIN_TTL_SECONDS' "$OUTPUT_DIR/production.yaml"
grep -q 'restartPolicy: Never' "$OUTPUT_DIR/production.yaml"
grep -q 'restartPolicy: Always' "$OUTPUT_DIR/production.yaml"
grep -q 'RAIBITSERVER_GENERATED_DOCKERFILE_FRONTEND' "$OUTPUT_DIR/production.yaml"
grep -q 'RAIBITSERVER_GENERATED_NODE_IMAGE' "$OUTPUT_DIR/production.yaml"
grep -q 'RAIBITSERVER_REGISTRY_CREDENTIAL_BROKER_URL' "$OUTPUT_DIR/production.yaml"
grep -q 'RAIBITSERVER_REGISTRY_CREDENTIAL_BROKER_TOKEN_FILE' "$OUTPUT_DIR/production.yaml"
grep -q 'kubernetes.io/metadata.name: "raibitserver-infra"' "$OUTPUT_DIR/production-with-private-registry-gateway.yaml"
grep -q 'app.kubernetes.io/name: "raibit-registry-auth"' "$OUTPUT_DIR/production-with-private-registry-gateway.yaml"
grep -q 'port: 443' "$OUTPUT_DIR/production-with-private-registry-gateway.yaml"
grep -q 'port: 8443' "$OUTPUT_DIR/production-with-private-registry-gateway.yaml"
if grep -q 'name: DOCKER_CONFIG' "$OUTPUT_DIR/production.yaml"; then
  echo "production builder must not mount a shared Docker config" >&2
  exit 1
fi
grep -q 'app.kubernetes.io/name: raibitserver-log-ingester' "$OUTPUT_DIR/production.yaml"
grep -q 'app.kubernetes.io/name: raibitserver-metrics-ingester' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_PROVIDER_POSTGRESQL_IMAGE' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_PROVIDER_NATS_IMAGE' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_PROVISIONER_SERVICE_ACCOUNT_NAME' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_PROVISIONER_SERVICE_ACCOUNT_NAMESPACE' "$OUTPUT_DIR/production.yaml"
grep -q 'name: RAIBITSERVER_PROVISIONER_TENANT_ROLE_NAME' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-orchestrator-namespace-boundary' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-orchestrator-resourcequota-boundary' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-orchestrator-workload-boundary' "$OUTPUT_DIR/production.yaml"
grep -q 'resources: \["resourcequotas"\]' "$OUTPUT_DIR/production.yaml"
grep -q 'variables.target.spec.hard.size() == 21' "$OUTPUT_DIR/production.yaml"
for quota_contract in \
  "'resourcequotas': quantity('1')" \
  "'pods': quantity('100')" \
  "'count/pods': quantity('200')" \
  "'count/deployments.apps': quantity('50')" \
  "'count/replicasets.apps': quantity('200')" \
  "'count/statefulsets.apps': quantity('50')" \
  "'count/jobs.batch': quantity('100')" \
  "'count/cronjobs.batch': quantity('50')" \
  "'services': quantity('100')" \
  "'persistentvolumeclaims': quantity('50')" \
  "'secrets': quantity('200')" \
  "'configmaps': quantity('100')" \
  "'count/ingresses.networking.k8s.io': quantity('100')" \
  "'count/networkpolicies.networking.k8s.io': quantity('200')" \
  "'requests.cpu': quantity('50')" \
  "'requests.memory': quantity('100Gi')" \
  "'requests.ephemeral-storage': quantity('100Gi')" \
  "'limits.cpu': quantity('100')" \
  "'limits.memory': quantity('200Gi')" \
  "'limits.ephemeral-storage': quantity('200Gi')" \
  "'requests.storage': quantity('1Ti')"
do
  grep -Fq "$quota_contract" "$OUTPUT_DIR/production.yaml"
done
grep -q 'name: raibitserver-provisioner-tenant' "$OUTPUT_DIR/production.yaml"
grep -q 'resourceNames:.*raibitserver-provisioner-tenant' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-provisioner-namespace-boundary' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-provisioner-rolebinding-boundary' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-provisioner-provider-ownership' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-provisioner-provider-pvc-ownership' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-provisioner-tenant-namespace-only' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-provisioner-provider-statefulsets' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-provisioner-provider-networkpolicies' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-provisioner-provider-secrets' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-provisioner-provider-pvcs' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-provisioner-provider-services' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-provisioner-provider-deletes' "$OUTPUT_DIR/production.yaml"
grep -q '!has(variables.container.envFrom)' "$OUTPUT_DIR/production.yaml"
grep -q 'env.valueFrom.secretKeyRef.name == variables.connectionSecret' "$OUTPUT_DIR/production.yaml"
grep -q "variables.provider == 'postgresql' && env.name == 'PGDATA'" "$OUTPUT_DIR/production.yaml"
grep -q "env.value == '/var/lib/postgresql/data/pgdata'" "$OUTPUT_DIR/production.yaml"
grep -q 'variables.expectedEnvNames.all(name, variables.container.env.filter' "$OUTPUT_DIR/production.yaml"
grep -q "variables.container.resources.requests\['cpu'\] == '100m'" "$OUTPUT_DIR/production.yaml"
grep -q 'variables.container.startupProbe.exec.command == variables.container.readinessProbe.exec.command' "$OUTPUT_DIR/production.yaml"
grep -q 'variables.container.startupProbe.failureThreshold == 120' "$OUTPUT_DIR/production.yaml"
grep -q 'unset REDISCLI_AUTH VALKEYCLI_AUTH' "$OUTPUT_DIR/production.yaml"
grep -q "oldObject.metadata.name.endsWith('-connection')" "$OUTPUT_DIR/production.yaml"
grep -q 'object.data.all(key, key in variables.expectedSecretKeys)' "$OUTPUT_DIR/production.yaml"
grep -q 'request.options.preconditions.uid == oldObject.metadata.uid' "$OUTPUT_DIR/production.yaml"
grep -q 'variables.policy.egress.size() == 0' "$OUTPUT_DIR/production.yaml"
grep -q 'objectSelector:' "$OUTPUT_DIR/production.yaml"
grep -q 'oldObject.metadata.labels' "$OUTPUT_DIR/production.yaml"
grep -q 'object.spec.resources == oldObject.spec.resources' "$OUTPUT_DIR/production.yaml"
grep -q 'operator: NotIn' "$OUTPUT_DIR/production.yaml"
grep -q 'raibitserver.io/managed' "$OUTPUT_DIR/production.yaml"
if grep -q 'resources: \["pods/exec"\]' "$OUTPUT_DIR/production.yaml"; then
  echo "provisioner RBAC must not grant pod exec" >&2
  exit 1
fi
if ! awk '
  /^---$/ { tenant = 0; secret = 0 }
  /^  name: raibitserver-provisioner-tenant$/ { tenant = 1 }
  tenant && /resources: \["secrets"\]/ { secret = 1 }
  tenant && secret && /verbs:/ { found = 1; if ($0 !~ /verbs: \["create", "patch", "delete"\]/) exit 1; secret = 0 }
  END { if (!found) exit 2 }
' "$OUTPUT_DIR/production.yaml"; then
  echo "provisioner tenant Secret RBAC must grant only create, dry-run metadata patch, and delete" >&2
  exit 1
fi
if ! awk '
  /^---$/ { tenant = 0; network = 0 }
  /^  name: raibitserver-provisioner-tenant$/ { tenant = 1 }
  tenant && /resources: \["networkpolicies"\]/ { network = 1 }
  tenant && network && /verbs:/ { found = 1; if ($0 !~ /"delete"/) exit 1; network = 0 }
  END { if (!found) exit 2 }
' "$OUTPUT_DIR/production.yaml"; then
  echo "provisioner tenant RBAC must delete only admission-constrained provider NetworkPolicies" >&2
  exit 1
fi
grep -q 'registry.example.com/raibitserver/providers/postgresql@sha256:0101010101010101010101010101010101010101010101010101010101010101' "$OUTPUT_DIR/production.yaml"
grep -q 'name: raibitserver-observability-ingesters' "$OUTPUT_DIR/production.yaml"
grep -q 'kind: Ingress' "$OUTPUT_DIR/production.yaml"
grep -q 'secretName: "ci-raibitserver-ingress-tls"' "$OUTPUT_DIR/production.yaml"
grep -q 'app.kubernetes.io/component: database-migration' "$OUTPUT_DIR/production.yaml"
grep -q 'kind: PodDisruptionBudget' "$OUTPUT_DIR/production.yaml"
grep -q 'kind: ValidatingWebhookConfiguration' "$OUTPUT_DIR/production.yaml" || grep -q 'validatingwebhookconfigurations' "$OUTPUT_DIR/production.yaml"
grep -q 'cidr: "10.20.0.0/24"' "$OUTPUT_DIR/production.yaml"
grep -q 'port: 5432' "$OUTPUT_DIR/production.yaml"
grep -q 'value: "url"' "$OUTPUT_DIR/production-with-url-verifier.yaml"
grep -q 'kubernetes.io/metadata.name: database-system' "$OUTPUT_DIR/production-with-selector-db-egress.yaml"
grep -q 'name: secondary-raibitserver-orchestrator' "$OUTPUT_DIR/secondary-release.yaml"
grep -q 'name: secondary-raibitserver-log-ingester' "$OUTPUT_DIR/secondary-release.yaml"
grep -q 'name: secondary-raibitserver-metrics-ingester' "$OUTPUT_DIR/secondary-release.yaml"
grep -q 'name: secondary-raibitserver-image-verification-contract' "$OUTPUT_DIR/secondary-release.yaml"
grep -q 'namespace: raibitserver-secondary' "$OUTPUT_DIR/secondary-release.yaml"
grep -Fq "peer.namespaceSelector.matchLabels['kubernetes.io/metadata.name'] == 'edge-gateway-system'" "$OUTPUT_DIR/configured-ingress-gateway.yaml"
grep -Fq "variables.target.spec.ingressClassName == 'internal.ingress.example.com'" "$OUTPUT_DIR/configured-ingress-gateway.yaml"
grep -Fq 'quantity(variables.target.spec.hard[key]).compareTo(variables.expectedHard[key]) == 0' "$OUTPUT_DIR/production.yaml"
if [ "$(grep -c 'name: RAIBITSERVER_INGRESS_GATEWAY_NAMESPACE' "$OUTPUT_DIR/configured-ingress-gateway.yaml")" -ne 2 ] || \
   [ "$(grep -c 'value: \"edge-gateway-system\"' "$OUTPUT_DIR/configured-ingress-gateway.yaml")" -lt 2 ]; then
  echo "configured ingress gateway namespace must reach both API and orchestrator" >&2
  exit 1
fi
if [ "$(grep -c 'name: RAIBITSERVER_INGRESS_CLASS_NAME' "$OUTPUT_DIR/configured-ingress-gateway.yaml")" -ne 1 ] || \
   ! grep -A1 'name: RAIBITSERVER_INGRESS_CLASS_NAME' "$OUTPUT_DIR/configured-ingress-gateway.yaml" | grep -q 'value: "internal.ingress.example.com"'; then
  echo "configured ingress class must reach the orchestrator and its admission policy" >&2
  exit 1
fi
if grep -q 'raibitserver.io/ingress-gateway' "$OUTPUT_DIR/production.yaml"; then
  echo "tenant ingress must use the reserved namespace identity, not an arbitrary label" >&2
  exit 1
fi
if grep -q 'raibitserver-log-ingester' "$OUTPUT_DIR/default.yaml" || grep -q 'raibitserver-metrics-ingester' "$OUTPUT_DIR/default.yaml"; then
  echo "default chart must not deploy observability ingesters" >&2
  exit 1
fi

expect_render_failure() {
  scenario=$1
  shift
  if "$HELM" template raibitserver "$CHART" --namespace raibitserver-system --values "$PRODUCTION_VALUES" "$@" >"$OUTPUT_DIR/$scenario.out" 2>"$OUTPUT_DIR/$scenario.err"; then
    echo "expected production Helm render to fail: $scenario" >&2
    exit 1
  fi
}

if "$HELM" template raibitserver "$CHART" --namespace raibitserver-system \
  --set builder.registryCredentials.privateGateway.enabled=true \
  --set-string builder.registryCredentials.privateGateway.namespace=INVALID/namespace \
  --set-string builder.registryCredentials.privateGateway.podName=raibit-registry-auth \
  >"$OUTPUT_DIR/invalid-default-registry-gateway.out" 2>"$OUTPUT_DIR/invalid-default-registry-gateway.err"; then
  echo "expected non-production registry gateway validation to fail" >&2
  exit 1
fi

expect_render_failure unsupported-kubernetes-version --kube-version 1.29.9
expect_render_failure invalid-ingress-class --set-string ingress.className=INVALID/class
expect_render_failure missing-verifier --set-string security.imageVerification.admissionController.existingWebhookConfiguration=
expect_render_failure missing-webhook-identity --set-string security.imageVerification.admissionController.webhookName=
expect_render_failure missing-controller-deployment --set-string security.imageVerification.admissionController.deploymentName=
expect_render_failure missing-verifier-service --set-string security.imageVerification.admissionController.serviceName=
expect_render_failure missing-client-target \
  --set-string security.imageVerification.admissionController.clientConfig.service.namespace= \
  --set-string security.imageVerification.admissionController.clientConfig.service.name= \
  --set-string security.imageVerification.admissionController.clientConfig.service.path=
expect_render_failure missing-client-service-namespace --set-string security.imageVerification.admissionController.clientConfig.service.namespace=
expect_render_failure missing-client-service-name --set-string security.imageVerification.admissionController.clientConfig.service.name=
expect_render_failure ambiguous-client-target \
  --set-string security.imageVerification.admissionController.clientConfig.url.host=verifier.policy.example \
  --set-string security.imageVerification.admissionController.clientConfig.url.path=/validate
expect_render_failure mismatched-client-service-name --set-string security.imageVerification.admissionController.clientConfig.service.name=other-verifier-service
expect_render_failure missing-client-url-path \
  --set-string security.imageVerification.admissionController.clientConfig.service.namespace= \
  --set-string security.imageVerification.admissionController.clientConfig.service.name= \
  --set-string security.imageVerification.admissionController.clientConfig.service.path= \
  --set-string security.imageVerification.admissionController.clientConfig.url.host=verifier.policy.example
expect_render_failure missing-client-url-host \
  --set-string security.imageVerification.admissionController.clientConfig.service.namespace= \
  --set-string security.imageVerification.admissionController.clientConfig.service.name= \
  --set-string security.imageVerification.admissionController.clientConfig.service.path= \
  --set-string security.imageVerification.admissionController.clientConfig.url.path=/validate
expect_render_failure missing-trust-root --set-string security.imageVerification.trustRoot.existingSecret=
expect_render_failure missing-trust-root-namespace --set-string security.imageVerification.trustRoot.namespace=
expect_render_failure missing-trust-root-key --set-string security.imageVerification.trustRoot.key=
expect_render_failure missing-platform-digest --set-string image.digests.api=
expect_render_failure missing-dashboard-digest --set-string image.digests.dashboard=
expect_render_failure missing-dashboard-console-url --set-string dashboard.consoleUrl=
expect_render_failure missing-postgresql-provider-image --set-string provisioner.providerImages.postgresql=
expect_render_failure missing-mysql-provider-image --set-string provisioner.providerImages.mysql=
expect_render_failure missing-mariadb-provider-image --set-string provisioner.providerImages.mariadb=
expect_render_failure missing-mongodb-provider-image --set-string provisioner.providerImages.mongodb=
expect_render_failure missing-redis-provider-image --set-string provisioner.providerImages.redis=
expect_render_failure missing-valkey-provider-image --set-string provisioner.providerImages.valkey=
expect_render_failure mutable-redis-provider-image --set-string provisioner.providerImages.redis=docker.io/library/redis:latest
expect_render_failure mutable-plan-only-provider-image --set-string provisioner.providerImages.minio=docker.io/minio/minio:latest
"$HELM" template raibitserver "$CHART" --namespace raibitserver-system --values "$PRODUCTION_VALUES" \
  --set-string provisioner.providerImages.minio= \
  --set-string provisioner.providerImages.qdrant= \
  --set-string provisioner.providerImages.nats= >"$OUTPUT_DIR/production-with-plan-only-providers-disabled.yaml"
expect_render_failure missing-log-ingester-digest --set-string image.digests.logIngester=
expect_render_failure missing-metrics-ingester-digest --set-string image.digests.metricsIngester=
expect_render_failure missing-database-secret --set-string database.existingSecret=
expect_render_failure missing-runtime-secret --set-string runtimeSecrets.existingSecret=
expect_render_failure disabled-migration --set migration.enabled=false
expect_render_failure disabled-orchestrator-execution --set orchestrator.execute=false
expect_render_failure disabled-provisioner-execution --set provisioner.execute=false
expect_render_failure invalid-provisioner-health-interval --set provisioner.healthIntervalSeconds=0
expect_render_failure disabled-tls --set ingress.tls.enabled=false
expect_render_failure missing-tls-secret --set-string ingress.tls.existingSecret=
expect_render_failure missing-public-host --set-string ingress.hosts.public=
expect_render_failure shared-public-dashboard-host --set-string ingress.hosts.public=console.production.example
expect_render_failure mismatched-dashboard-host \
  --set-string ingress.hosts.dashboard=dashboard.production.example \
  --set-string dashboard.consoleUrl=https://dashboard.production.example/console
expect_render_failure mismatched-dashboard-console-url --set-string dashboard.consoleUrl=https://other.production.example/console
expect_render_failure invalid-ingress-gateway-namespace --set-string ingress.gatewayNamespace=INVALID/namespace
expect_render_failure missing-ingress-gateway-namespace --set-string ingress.gatewayNamespace=
expect_render_failure missing-buildkit-digest --set-string builder.buildkitDigest=
expect_render_failure missing-generated-frontend --set-string builder.generatedDockerfile.frontend=
expect_render_failure mutable-generated-frontend --set-string builder.generatedDockerfile.frontend=docker.io/docker/dockerfile:1.7
expect_render_failure missing-generated-node-image --set-string builder.generatedDockerfile.nodeImage=
expect_render_failure mutable-generated-node-image --set-string builder.generatedDockerfile.nodeImage=docker.io/library/node:24-alpine
expect_render_failure unsafe-shared-builder --set-string builder.isolation.mode=shared
expect_render_failure invalid-builder-parallelism --set builder.isolation.parallelism=0
expect_render_failure invalid-builder-completions --set builder.isolation.parallelism=4 --set builder.isolation.completions=2
expect_render_failure missing-checker-digest --set-string security.imageVerification.verificationHook.checkerImage.digest=
expect_render_failure missing-registry-credential-broker --set-string builder.registryCredentials.brokerURL=
expect_render_failure insecure-registry-credential-broker --set-string builder.registryCredentials.brokerURL=http://credential-broker.example/token
expect_render_failure missing-registry-credential-broker-token --set-string builder.registryCredentials.existingSecret=
expect_render_failure invalid-registry-gateway-namespace \
  --set builder.registryCredentials.privateGateway.enabled=true \
  --set-string builder.registryCredentials.privateGateway.namespace=INVALID/namespace \
  --set-string builder.registryCredentials.privateGateway.podName=raibit-registry-auth
expect_render_failure invalid-registry-gateway-pod-name \
  --set builder.registryCredentials.privateGateway.enabled=true \
  --set-string builder.registryCredentials.privateGateway.namespace=raibitserver-infra \
  --set-string builder.registryCredentials.privateGateway.podName=INVALID/name
expect_render_failure invalid-registry-gateway-service-port \
  --set builder.registryCredentials.privateGateway.enabled=true \
  --set-string builder.registryCredentials.privateGateway.namespace=raibitserver-infra \
  --set-string builder.registryCredentials.privateGateway.podName=raibit-registry-auth \
  --set builder.registryCredentials.privateGateway.servicePort=0
expect_render_failure invalid-registry-gateway-port \
  --set builder.registryCredentials.privateGateway.enabled=true \
  --set-string builder.registryCredentials.privateGateway.namespace=raibitserver-infra \
  --set-string builder.registryCredentials.privateGateway.podName=raibit-registry-auth \
  --set builder.registryCredentials.privateGateway.port=0
expect_render_failure missing-builder-dispatch-mtls --set-string builder.dispatch.existingSecret=
expect_render_failure missing-builder-dispatcher --set builder.replicas=0
expect_render_failure build-timeout-exceeds-job-deadline --set builder.buildTimeoutSeconds=781
expect_render_failure credential-ttl-shorter-than-job-deadline --set builder.registryCredentials.minTTLSeconds=839
expect_render_failure dispatch-session-shorter-than-job-deadline --set builder.dispatch.sessionTTLSeconds=839
expect_render_failure missing-db-egress --set-json 'builder.databaseEgress.selectorPeers=[]' --set-json 'builder.databaseEgress.cidrs=[]'
expect_render_failure missing-observability-kubernetes-egress --set-json 'observability.networkPolicy.kubernetesApiEgress.cidrs=[]'
expect_render_failure missing-observability-database-egress --set-json 'observability.networkPolicy.databaseEgress.selectorPeers=[]' --set-json 'observability.networkPolicy.databaseEgress.cidrs=[]'
expect_render_failure missing-storage-bound --set-string builder.ephemeralStorage.builderLimit=
expect_render_failure invalid-storage-bound --set-string builder.ephemeralStorage.builderLimit=0Gi

echo "Helm default/production renders and production fail-closed cases passed"
