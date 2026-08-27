import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const deploymentTemplates = [
  'infra/helm/raibitserver/templates/api-deployment.yaml',
  'infra/helm/raibitserver/templates/orchestrator-deployment.yaml',
];

test('Helm control-plane workloads keep non-root filesystem and resource hardening', async () => {
  for (const templatePath of deploymentTemplates) {
    const template = await fs.readFile(templatePath, 'utf8');
    assert.match(template, /securityContext:\s*\n(?:.*\n){0,4}\s*runAsNonRoot: true/, `${templatePath} must set pod/container non-root security context`);
    assert.match(template, /seccompProfile:\s*\n\s*type: RuntimeDefault/, `${templatePath} must use RuntimeDefault seccomp`);
    assert.match(template, /readOnlyRootFilesystem: true/, `${templatePath} must mount root filesystem read-only`);
    assert.match(template, /runAsUser: 10001/, `${templatePath} must use an explicit non-root UID`);
    assert.match(template, /allowPrivilegeEscalation: false/, `${templatePath} must block privilege escalation`);
    assert.match(template, /drop: \["ALL"\]/, `${templatePath} must drop Linux capabilities`);
    assert.match(template, /resources:\s*\n\s*requests:/, `${templatePath} must include resource requests`);
    assert.match(template, /limits:/, `${templatePath} must include resource limits`);
    assert.match(template, /volumeMounts:\s*\n\s*- name: tmp\s*\n\s*mountPath: \/tmp/, `${templatePath} must provide writable tmp for read-only rootfs`);
  }
});

test('tenant build executors require a dedicated rootless BuildKit node pool', async () => {
  const [builder, values] = await Promise.all([
    fs.readFile('infra/helm/raibitserver/templates/builder-deployment.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/values.yaml', 'utf8'),
  ]);
  assert.match(builder, /moby\/buildkit|buildkitImage/);
  assert.match(builder, /automountServiceAccountToken: false/);
  assert.match(builder, /nodeSelector:/);
  assert.match(builder, /tolerations:/);
  assert.doesNotMatch(builder, /docker\.sock|privileged:\s*true/);
  assert.match(
    builder,
    /--oci-worker-no-process-sandbox/,
    'rootless BuildKit under the isolated executor runtime requires the no-process-sandbox mode',
  );
  assert.match(values, /raibitserver\.io\/workload:\s*build/);
});

test('production builder chart fails closed around registry and supply-chain settings', async () => {
  const [builder, values, admission, fixture] = await Promise.all([
    fs.readFile('infra/helm/raibitserver/templates/builder-deployment.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/values.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/templates/signature-admission.yaml', 'utf8').catch(() => ''),
    fs.readFile('infra/helm/raibitserver/ci-production-values.yaml', 'utf8'),
  ]);
  assert.match(values, /^production:\s*false/m, 'local values must render deterministically without production credentials');
  assert.match(values, /builder:\s*[\s\S]*replicas:\s*0/, 'local installs must not start external build infrastructure implicitly');
  assert.match(fixture, /builder:\s*[\s\S]*replicas:\s*1/, 'production verification must enable exactly one trusted dispatcher');
  assert.match(values, /builder:\s*[\s\S]*registry:\s*registry\./, 'builder registry must be explicit');
  assert.doesNotMatch(values, /localhost:5000/, 'chart must not imply a localhost registry');
  assert.match(values, /push:\s*true/);
  assert.match(values, /scan:\s*[\s\S]*enabled:\s*true/);
  assert.match(values, /signing:\s*[\s\S]*enabled:\s*true/);
  assert.doesNotMatch(values, /gitCredentials:/, 'shared cross-tenant Git credentials must not be configured');
  assert.match(values, /registryCredentials:\s*[\s\S]*brokerURL:[\s\S]*existingSecret:[\s\S]*tokenKey:[\s\S]*privateGateway:[\s\S]*enabled:\s*false[\s\S]*namespace:[\s\S]*podName:[\s\S]*servicePort:\s*443[\s\S]*port:\s*8443/);
  assert.match(values, /buildTimeoutSeconds:\s*600/);
  assert.match(values, /registryCredentials:\s*[\s\S]*minTTLSeconds:\s*840[\s\S]*maxTTLSeconds:\s*900/);
  assert.match(values, /runtimeClassName:/);
  assert.match(values, /imageVerification:\s*[\s\S]*enabled:\s*true[\s\S]*admissionController:[\s\S]*name:[\s\S]*trustRoot:[\s\S]*existingSecret:/, 'production admission verification contract must name an external controller and trust root');
  assert.match(values, /ephemeralStorage:\s*[\s\S]*builderRequest:[\s\S]*builderLimit:[\s\S]*buildkitRequest:[\s\S]*buildkitLimit:/);
  assert.match(values, /builderTmpSizeLimit:\s*4Gi/, 'Trivy cache and scanner scratch space must exceed the observed 1Gi eviction boundary');
  assert.match(values, /generatedDockerfile:\s*[\s\S]*frontend:\s*["']?[\s\S]*nodeImage:/, 'generated Dockerfile inputs must be configurable');
  assert.match(values, /isolation:\s*[\s\S]*mode:\s*single-job-pod[\s\S]*schedule:[\s\S]*parallelism:\s*4[\s\S]*completions:\s*4/, 'builder must schedule an explicit bounded batch of disposable executors');
  assert.match(values, /dispatch:\s*[\s\S]*existingSecret:[\s\S]*caKey:[\s\S]*clientCertificateKey:[\s\S]*clientKeyKey:/, 'executor-to-dispatcher mTLS must be secret-backed');

  for (const envName of ['RAIBITSERVER_REGISTRY', 'RAIBITSERVER_PUSH', 'RAIBITSERVER_SCAN', 'RAIBITSERVER_SIGN', 'RAIBITSERVER_GENERATED_DOCKERFILE_FRONTEND', 'RAIBITSERVER_GENERATED_NODE_IMAGE', 'RAIBITSERVER_RUN_ONCE', 'RAIBITSERVER_BUILDER_ISOLATION', 'RAIBITSERVER_BUILD_TIMEOUT_SECONDS', 'RAIBITSERVER_REGISTRY_CREDENTIAL_MIN_TTL_SECONDS']) {
    assert.match(builder, new RegExp(`name: ${envName}`), `${envName} must be wired into the builder`);
  }
  assert.doesNotMatch(builder, /GIT_ASKPASS|RAIBITSERVER_GIT_TOKEN_FILE|git-credentials/, 'builder pods must not mount a shared repository credential');
  assert.match(builder, /RAIBITSERVER_ALLOW_ANONYMOUS_GIT/);
  assert.doesNotMatch(builder, /name:\s*DOCKER_CONFIG|registry-auth/, 'shared Docker config must never enter tenant build pods');
  assert.match(builder, /RAIBITSERVER_REGISTRY_CREDENTIAL_BROKER_URL/);
  assert.match(builder, /RAIBITSERVER_REGISTRY_CREDENTIAL_BROKER_TOKEN_FILE/);
  assert.match(builder, /registry-broker-token[\s\S]*readOnly:\s*true/);
  assert.match(builder, /secretKeyRef:|secret:\s*\n\s*secretName:/);
  assert.match(builder, /runtimeClassName:/);
  assert.match(builder, /RAIBITSERVER_WORKSPACE/);
  assert.match(builder, /RAIBITSERVER_BUILD_METADATA_DIR/);
  assert.match(builder, /emptyDir:/);
  for (const volume of ['buildkit-cert-work', 'buildkit-server-tls', 'buildkit-client-tls', 'buildkit-state', 'buildkit-tmp', 'builder-tmp', 'workspace', 'metadata']) {
    assert.match(builder, new RegExp(`name: ${volume}[\\s\\S]{0,120}sizeLimit:`), `${volume} must have an explicit sizeLimit`);
  }
  assert.match(builder, /name: builder-tmp[\s\S]{0,120}sizeLimit: \{\{ \.Values\.builder\.ephemeralStorage\.builderTmpSizeLimit \| quote \}\}/);
  assert.ok((builder.match(/ephemeral-storage/g) || []).length >= 4, 'builder and buildkit must have ephemeral-storage requests and limits');
  assert.match(builder, /production registry credential broker URL must use https/i);
  assert.match(builder, /production registry credential broker token secret is required/i);
  assert.match(builder, /private gateway namespace must be a valid exact Kubernetes namespace/i);
  assert.match(builder, /private gateway pod name must be a valid exact label value/i);
  assert.match(builder, /private gateway service port must be between 1 and 65535/i);
  assert.match(builder, /private gateway port must be between 1 and 65535/i);
  assert.match(builder, /credential minimum TTL.*job deadline/i);
  assert.match(builder, /generated Dockerfile frontend.*sha256 digest/i);
  assert.match(builder, /generated Dockerfile node image.*sha256 digest/i);
  assert.match(builder, /production builder isolation mode must be single-job-pod/i);
  assert.match(builder, /builder isolation parallelism must be between 1 and 32/i);
  assert.match(builder, /builder isolation completions must be at least parallelism and no greater than 64/i);
  assert.match(builder, /ephemeral storage.*valid Kubernetes quantity/i);
  assert.match(builder, /fail .*digest|digest.*fail/i, 'production rendering must reject missing platform/buildkit digests');
  assert.match(builder, /verify-image-signatures|image-verification/i, 'pod must opt into the admission verification contract');
  assert.doesNotMatch(builder, /--(?:password|token|secret|key)[=, ]/i, 'secrets must not be exposed in container arguments');

  assert.match(builder, /kind:\s*Deployment[\s\S]*builder-dispatcher/, 'the DB-connected dispatcher must be isolated from tenant build execution');
  assert.match(builder, /kind:\s*CronJob/, 'executor scheduling must create disposable jobs');
  assert.match(builder, /concurrencyPolicy:\s*Forbid/, 'overlapping CronJob batches must not exceed the configured executor bound');
  assert.match(builder, /parallelism:\s*\{\{\s*\.Values\.builder\.isolation\.parallelism\s*\}\}/);
  assert.match(builder, /completions:\s*\{\{\s*\.Values\.builder\.isolation\.completions\s*\}\}/);
  assert.match(builder, /backoffLimit:\s*0/);
  assert.match(builder, /restartPolicy:\s*Never/);
  assert.match(builder, /initContainers:[\s\S]*name:\s*buildkitd[\s\S]*restartPolicy:\s*Always/, 'BuildKit must be a native sidecar scoped to one job pod');
  assert.match(builder, /name:\s*buildkit-tls[\s\S]*openssl genrsa[\s\S]*extendedKeyUsage=serverAuth[\s\S]*extendedKeyUsage=clientAuth/, 'each build pod must generate an ephemeral mTLS identity');
  assert.match(builder, /--addr["', ]+tcp:\/\/127\.0\.0\.1:1234[\s\S]*--tlscacert[\s\S]*--tlscert[\s\S]*--tlskey/, 'BuildKit loopback TCP must require mTLS');
  assert.match(builder, /RAIBITSERVER_BUILDKIT_ADDRESS[\s\S]*tcp:\/\/127\.0\.0\.1:1234[\s\S]*RAIBITSERVER_BUILDKIT_TLS_DIRECTORY[\s\S]*RAIBITSERVER_BUILDKIT_TLS_SERVER_NAME/, 'the executor must use the authenticated loopback endpoint');
  assert.doesNotMatch(builder, /unix:\/\/\/run\/buildkit\/buildkitd\.sock/, 'gVisor-separated containers cannot share the BuildKit Unix socket');
  assert.match(builder, /RAIBITSERVER_BUILDER_ROLE[\s\S]*dispatcher/);
  assert.match(builder, /RAIBITSERVER_BUILDER_ROLE[\s\S]*executor/);
  const dispatcherDocument = builder.split(/^---$/m).find((document) => /kind:\s*Deployment/.test(document) && /builder-dispatcher/.test(document)) ?? '';
  const executorDocument = builder.split(/^---$/m).find((document) => /kind:\s*CronJob/.test(document)) ?? '';
  assert.match(dispatcherDocument, /DATABASE_URL[\s\S]*secretKeyRef:/, 'only the trusted dispatcher may receive the control-plane DSN');
  assert.doesNotMatch(dispatcherDocument, /buildkitd|BUILDKIT_HOST|registry-broker-token|signing-key/, 'dispatcher must not execute tenant builds or receive build credentials');
  assert.doesNotMatch(executorDocument, /DATABASE_URL|CONTROL_PLANE_DATABASE_URL/, 'untrusted executor Pod must not receive any database credential');
  assert.match(executorDocument, /RAIBITSERVER_CONTROL_PLANE_REMOTE_URL/);
  assert.match(executorDocument, /dispatch-mtls[\s\S]*readOnly:\s*true/);

  assert.match(admission, /kind:\s*ValidatingAdmissionPolicy/);
  assert.match(admission, /kind:\s*ValidatingAdmissionPolicyBinding/);
  assert.match(admission, /failurePolicy:\s*Fail/);
  assert.match(admission, /validationActions:\s*\["Deny"\]/);
  assert.match(admission, /@sha256:\[a-f0-9\]\{64\}/);
  assert.match(admission, /raibitserver\.io\/verify-image-signatures/);
  assert.match(admission, /admissionController[\s\S]*trustRoot|signature-verification-controller[\s\S]*signature-trust-root/i);
  assert.doesNotMatch(admission, /cryptographically verified by (?:CEL|ValidatingAdmissionPolicy)/i);
});

test('tenant Dockerfile processes cannot reach the BuildKit client identity', async () => {
  const builder = await fs.readFile('infra/helm/raibitserver/templates/builder-deployment.yaml', 'utf8');
  const sidecarStart = builder.indexOf('            - name: buildkitd');
  const executorStart = builder.indexOf('          containers:', sidecarStart);
  const executorEnd = builder.indexOf('          restartPolicy: Never', executorStart);
  const buildkitSidecar = builder.slice(sidecarStart, executorStart);
  const executor = builder.slice(executorStart, executorEnd);

  assert.ok(sidecarStart >= 0 && executorStart > sidecarStart && executorEnd > executorStart);
  assert.match(buildkitSidecar, /name: buildkit-server-tls/);
  assert.match(buildkitSidecar, /name: buildkit-tmp/);
  assert.doesNotMatch(buildkitSidecar, /buildkit-client-tls|builder-tmp|\/var\/run\/secrets\/raibitserver\/buildkit/);
  assert.match(executor, /name: buildkit-client-tls/);
  assert.match(executor, /name: builder-tmp/);
  assert.doesNotMatch(executor, /name: buildkit-server-tls|buildkit-tmp|mountPath: \/server-certs/);
  assert.match(buildkitSidecar, /awk[^\n]*0100007F:04D2[^\n]*\/proc\/net\/tcp/);
  assert.doesNotMatch(buildkitSidecar, /startupProbe:[\s\S]*buildctl/);
});

test('production Helm uses a chart-managed live verification hook with least-privilege access', async () => {
  const [hook, values, fixture, verifier, ci] = await Promise.all([
    fs.readFile('infra/helm/raibitserver/templates/image-verification-preflight.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/values.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/ci-production-values.yaml', 'utf8'),
    fs.readFile('scripts/verify-helm.sh', 'utf8'),
    fs.readFile('.github/workflows/ci.yml', 'utf8'),
  ]);

  assert.match(values, /verificationHook:\s*[\s\S]*enabled:\s*false[\s\S]*checkerImage:[\s\S]*repository:[\s\S]*digest:/);
  assert.match(values, /admissionController:[\s\S]*existingWebhookConfiguration:[\s\S]*webhookName:[\s\S]*clientConfig:[\s\S]*service:[\s\S]*namespace:[\s\S]*name:[\s\S]*path:[\s\S]*url:[\s\S]*host:[\s\S]*path:/);
  assert.match(values, /trustRoot:[\s\S]*namespace:[\s\S]*existingSecret:[\s\S]*key:/);
  assert.match(hook, /helm\.sh\/hook:\s*pre-install,pre-upgrade/);
  assert.match(hook, /checkerImage\.repository[\s\S]*@[\s\S]*checkerImage\.digest/);
  assert.match(hook, /kind:\s*ValidatingWebhookConfiguration|validatingwebhookconfigurations/);
  assert.match(hook, /WEBHOOK_NAME[\s\S]*failurePolicy[\s\S]*Fail/);
  for (const clientConfigField of ['clientConfig.service.namespace', 'clientConfig.service.name', 'clientConfig.service.path', 'clientConfig.url']) {
    assert.ok(hook.includes(clientConfigField), `preflight must inspect exact webhook ${clientConfigField}`);
  }
  assert.match(hook, /CLIENT_CONFIG_MODE[\s\S]*EXPECTED_CLIENT_SERVICE_NAMESPACE[\s\S]*EXPECTED_CLIENT_SERVICE_NAME/);
  assert.match(hook, /EXPECTED_CLIENT_URL_HOST[\s\S]*EXPECTED_CLIENT_URL_PATH/);
  assert.match(
    hook,
    /webhook_json[\s\S]*jq -c --arg name[\s\S]*\.webhooks\[\][\s\S]*select\(\.name == \$name\)/,
    'preflight must select the configured webhook as structured JSON',
  );
  assert.ok(hook.includes('.rules[]?'), 'preflight must semantically inspect every webhook rule');
  for (const field of ['.scope', '.apiGroups', '.apiVersions', '.operations', '.resources']) {
    assert.ok(hook.includes(field), `preflight must semantically inspect webhook rule field ${field}`);
  }
  for (const workloadRuleValue of ['Namespaced', 'v1', 'CREATE', 'UPDATE', 'pods']) {
    assert.match(hook, new RegExp(workloadRuleValue), `preflight must require webhook rule value ${workloadRuleValue}`);
  }
  assert.ok(
    hook.includes('.namespaceSelector | safe_selector'),
    'preflight must semantically validate namespaceSelector',
  );
  assert.ok(
    hook.includes('.objectSelector | safe_selector'),
    'preflight must semantically validate objectSelector',
  );
  assert.match(
    hook,
    /matchLabels[\s\S]*raibitserver\.io\/managed[\s\S]*true/,
    'selector validation must retain the managed-namespace label contract',
  );
  assert.match(hook, /raibitserver\.io\/managed[\s\S]*true/);
  assert.match(hook, /TRUST_ROOT_NAMESPACE[\s\S]*TRUST_ROOT_SECRET[\s\S]*TRUST_ROOT_KEY/);
  assert.match(hook, /jsonpath=\{\.data\['\$\{TRUST_ROOT_JSONPATH_KEY\}'\]\}/, 'trust-root lookup must query the configured data key exactly');
  assert.match(hook, /TRUST_ROOT_JSONPATH_KEY[\s\S]*replace\s+"\."\s+"\\\\\."/, 'dots in Secret data keys must be escaped for Kubernetes JSONPath');
  assert.match(hook, /trust_root_value[\s\S]*-z/, 'trust-root key must contain non-empty data');
  assert.doesNotMatch(hook, /get secret[^\n]*--output json\s*\|\s*grep/i, 'annotations or unrelated Secret fields must not satisfy trust-root lookup');
  assert.match(hook, /CONTROLLER_DEPLOYMENT/);
  assert.match(hook, /CONTROLLER_SERVICE/);
  assert.doesNotMatch(hook, /if \[ -n "\$\{CONTROLLER_(?:DEPLOYMENT|SERVICE)\}" \]/, 'configured verifier Deployment and Service checks are mandatory');
  assert.match(hook, /resourceNames:/, 'hook RBAC must scope reads to configured resource names');
  assert.match(hook, /verbs:\s*\["get"\]/);
  assert.doesNotMatch(hook, /verbs:\s*\[[^\]]*(?:list|watch|create|update|patch|delete|\*)/i);
  assert.doesNotMatch(hook, /resources:\s*\["\*"\]/);
  assert.match(hook, /backoffLimit:\s*0/);
  assert.match(hook, /activeDeadlineSeconds:/);

  assert.match(fixture, /^production:\s*true/m);
  assert.match(fixture, /verificationHook:[\s\S]*enabled:\s*true[\s\S]*digest:\s*sha256:[a-f0-9]{64}/);
  assert.match(fixture, /clientConfig:[\s\S]*service:[\s\S]*namespace:\s*policy-system[\s\S]*name:\s*policy-controller-webhook[\s\S]*path:\s*\/validate/);
  for (const scenario of [
    'missing-verifier',
    'missing-controller-deployment',
    'missing-verifier-service',
    'missing-client-target',
    'missing-client-service-namespace',
    'missing-client-service-name',
    'ambiguous-client-target',
    'mismatched-client-service-name',
    'missing-client-url-path',
    'missing-client-url-host',
    'missing-trust-root',
    'missing-platform-digest',
    'missing-checker-digest',
    'missing-registry-credential-broker',
    'insecure-registry-credential-broker',
    'missing-registry-credential-broker-token',
    'invalid-registry-gateway-namespace',
    'invalid-registry-gateway-pod-name',
    'invalid-registry-gateway-service-port',
    'invalid-registry-gateway-port',
    'missing-builder-dispatch-mtls',
    'missing-builder-dispatcher',
    'build-timeout-exceeds-job-deadline',
    'credential-ttl-shorter-than-job-deadline',
    'dispatch-session-shorter-than-job-deadline',
    'missing-storage-bound',
    'invalid-storage-bound',
  ]) {
    assert.match(verifier, new RegExp(scenario));
  }
  assert.match(verifier, /helm\s+lint|"\$HELM"\s+lint/);
  assert.match(verifier, /helm\s+template|"\$HELM"\s+template/);
  assert.match(verifier, /invalid-default-registry-gateway/);
  assert.doesNotMatch(ci, /if command -v helm/);
  assert.match(ci, /setup-helm/);
  assert.match(ci, /scripts\/verify-helm\.sh/);
});

test('builder NetworkPolicies give database egress only to the trusted dispatcher', async () => {
  const [networkPolicy, values, fixture, verifier] = await Promise.all([
    fs.readFile('infra/helm/raibitserver/templates/worker-security.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/values.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/ci-production-values.yaml', 'utf8'),
    fs.readFile('scripts/verify-helm.sh', 'utf8'),
  ]);

  assert.match(values, /builder:[\s\S]*databaseEgress:[\s\S]*port:[\s\S]*selectorPeers:[\s\S]*cidrs:/);
  assert.match(networkPolicy, /databaseEgress/);
  assert.match(networkPolicy, /selectorPeers/);
  assert.match(networkPolicy, /namespaceSelector:/);
  assert.match(networkPolicy, /podSelector:/);
  assert.match(networkPolicy, /ipBlock:[\s\S]*cidr:/);
  assert.match(networkPolicy, /protocol:\s*TCP[\s\S]*\.port/);
  assert.match(networkPolicy, /production builder database egress/i);
  const dispatcherPolicy = networkPolicy.split(/^---$/m).find((document) => /kind:\s*NetworkPolicy/.test(document) && /metadata:\s*\n\s*name:[^\n]*-builder-dispatcher\s*\n/.test(document)) ?? '';
  const executorPolicy = networkPolicy.split(/^---$/m).find((document) => /kind:\s*NetworkPolicy/.test(document) && /metadata:\s*\n\s*name:[^\n]*-builder-executor\s*\n/.test(document)) ?? '';
  assert.match(dispatcherPolicy, /databaseEgress|\.port/);
  assert.doesNotMatch(executorPolicy, /\.Values\.builder\.databaseEgress|port:\s*5432/, 'tenant Dockerfile traffic must not have a database egress rule');
  assert.match(executorPolicy, /builder-dispatcher[\s\S]*port:/, 'executor may reach only the authenticated dispatcher control endpoint in-cluster');
  assert.match(executorPolicy, /privateGateway\.enabled[\s\S]*namespaceSelector:[\s\S]*podSelector:[\s\S]*privateGateway\.servicePort[\s\S]*privateGateway\.port/, 'executor may reach only the dedicated split-DNS registry gateway identity on its service and target ports');
  assert.doesNotMatch(executorPolicy, /registryCredentials\.egressCIDRs/, 'registry access must never use a private CIDR exception');
  assert.match(executorPolicy, /except:[\s\S]*range \$cidr := \$databaseEgress\.cidrs/, 'public database CIDRs must also be excluded from executor internet egress');
  assert.match(fixture, /databaseEgress:[\s\S]*port:\s*5432[\s\S]*selectorPeers:\s*\[\][\s\S]*cidrs:[\s\S]*10\./);
  assert.match(verifier, /missing-db-egress/);
});
