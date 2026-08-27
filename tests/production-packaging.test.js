import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const readText = async (path) => (await fs.readFile(path, 'utf8')).replace(/\r\n/g, '\n');

const dockerfiles = [
  'apps/api/Dockerfile',
  'apps/dashboard/Dockerfile',
  'apps/cli/Dockerfile',
  'services/builder/Dockerfile',
  'services/orchestrator/Dockerfile',
  'services/provisioner/Dockerfile',
  'services/log-ingester/Dockerfile',
  'services/metrics-ingester/Dockerfile',
];

test('production images are reproducible, non-root, and exclude local state', async () => {
  const dockerignore = await fs.readFile('.dockerignore', 'utf8');
  for (const ignored of ['.git', '.env', 'node_modules', '.omx', '**/*.exe']) {
    assert.match(dockerignore, new RegExp(escapeRegExp(ignored)), `.dockerignore must exclude ${ignored}`);
  }

  for (const dockerfilePath of dockerfiles) {
    const dockerfile = await fs.readFile(dockerfilePath, 'utf8');
    const fromLines = dockerfile.split(/\r?\n/).filter((line) => /^FROM\s+/i.test(line));
    assert.ok(fromLines.length >= 2, `${dockerfilePath} must use a build/runtime multi-stage image`);
    for (const fromLine of fromLines) {
      assert.match(fromLine, /@sha256:[a-f0-9]{64}/, `${dockerfilePath} base images must be immutable`);
      assert.doesNotMatch(fromLine, /:latest(?:@|\s|$)/, `${dockerfilePath} must not use latest tags`);
    }
    assert.match(dockerfile, /^USER\s+(?!0\b|root\b).+/m, `${dockerfilePath} runtime must be non-root`);
  }
});

test('runtime images contain only the executables their production entrypoints require', async () => {
  const [api, dashboard, cli, builder, orchestrator, provisioner, logIngester, metricsIngester] = await Promise.all(
    dockerfiles.map((file) => fs.readFile(file, 'utf8')),
  );

  assert.match(api, /tsconfig\.build\.json/);
  assert.match(api, /prisma\s+generate/);
  assert.ok((api.match(/apt-get install[\s\S]{0,160}\bopenssl\b/g) || []).length >= 2, 'API build and runtime stages must provide OpenSSL for Prisma');
  const deployIndex = api.indexOf('pnpm --filter @raibitserver/api deploy');
  const runtimeClientGenerateIndex = api.indexOf('cd /opt/raibitserver/api');
  assert.ok(deployIndex >= 0 && runtimeClientGenerateIndex > deployIndex, 'Prisma Client must be generated inside the deployed API tree');
  assert.match(api, /packages\/core\/tsconfig\.json[\s\S]*core-runtime/);
  assert.match(api, /pkg\.exports=[\s\S]*dist\/index\.js/);
  assert.match(
    api,
    /COPY --from=build --chown=10001:10001 \/opt\/raibitserver\/api \.\//,
    'API runtime files must be owned by the same non-root UID used by the API and migration workloads',
  );
  assert.match(api, /^USER 10001:10001$/m, 'API image default user must match the Helm workload UID');
  assert.match(api, /node["',\s]+dist\/main\.js/);
  assert.match(dashboard, /\.next\/standalone/);
  assert.match(
    dashboard,
    /COPY --from=build --chown=node:node \/workspace\/apps\/dashboard\/public \.\/apps\/dashboard\/public/,
    'dashboard runtime image must contain public assets such as raibit-logo.jpg',
  );
  assert.match(dashboard, /server\.js/);
  assert.match(cli, /exec tsc --ignoreConfig \.\.\/\.\.\/packages\/api-client\/src\/index\.ts[\s\S]*api-client-runtime/);
  assert.match(cli, /dist\/index\.js/);
  const cliInstall = cli.indexOf('RUN pnpm install --frozen-lockfile');
  const cliCompile = cli.indexOf('RUN pnpm --filter @raibitserver/cli exec tsc -p tsconfig.json');
  const cliConfigManifest = cli.indexOf('COPY packages/config/package.json packages/config/package.json');
  const cliConfigSource = cli.indexOf('COPY packages/config packages/config');
  assert.ok(cliConfigManifest >= 0 && cliConfigManifest < cliInstall, 'CLI image must copy the shared config manifest before install');
  assert.ok(cliConfigSource > cliInstall && cliConfigSource < cliCompile, 'CLI image must copy the shared tsconfig before compilation');

  assert.match(builder, /\b(?:apt-get|apk)\b[\s\S]{0,300}\bgit\b/i, 'builder image must install git');
  for (const executable of ['buildctl', 'trivy', 'cosign']) {
    assert.match(builder, new RegExp(`COPY[^\\n]*${executable}`, 'i'), `builder image must include ${executable}`);
  }
  assert.match(orchestrator, /kubectl/);
  assert.match(provisioner, /kubectl/);
  assert.match(logIngester, /cmd\/log-ingester/);
  assert.match(metricsIngester, /cmd\/metrics-ingester/);
});

test('API and dashboard builds emit runnable production artifacts and health endpoints', async () => {
  const [apiPackage, apiBuildConfig, dashboardConfig, dashboardHealth] = await Promise.all([
    fs.readFile('apps/api/package.json', 'utf8'),
    fs.readFile('apps/api/tsconfig.build.json', 'utf8'),
    fs.readFile('apps/dashboard/next.config.mjs', 'utf8'),
    fs.readFile('apps/dashboard/app/api/health/route.ts', 'utf8'),
  ]);

  assert.match(apiPackage, /"build"\s*:\s*"tsc -p tsconfig\.build\.json"/);
  assert.match(apiBuildConfig, /"noEmit"\s*:\s*false/);
  assert.match(apiBuildConfig, /"outDir"\s*:\s*"\.\/dist"/);
  assert.match(dashboardConfig, /output:\s*['"]standalone['"]/);
  assert.match(dashboardConfig, /outputFileTracingRoot/);
  assert.match(dashboardHealth, /status:\s*['"]ok['"]/);
});

test('Helm exposes both control-plane web surfaces through fail-closed production wiring', async () => {
  const files = await Promise.all([
    '_helpers.tpl',
    'dashboard-deployment.yaml',
    'services.yaml',
    'ingress.yaml',
    'migration-job.yaml',
    'availability.yaml',
  ].map((name) => fs.readFile(`infra/helm/raibitserver/templates/${name}`, 'utf8')));
  const [helpers, dashboard, services, ingress, migration, availability] = files;
  const [api, values, fixture] = await Promise.all([
    fs.readFile('infra/helm/raibitserver/templates/api-deployment.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/values.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/ci-production-values.yaml', 'utf8'),
  ]);

  assert.match(helpers, /define\s+"raibitserver\.fullname"/);
  assert.match(api, /include\s+"raibitserver\.fullname"/);
  assert.match(dashboard, /kind:\s*Deployment/);
  assert.match(dashboard, /NODE_ENV[\s\S]*production/);
  assert.match(dashboard, /RAIBITSERVER_CONSOLE_URL[\s\S]*\.Values\.dashboard\.consoleUrl/);
  assert.doesNotMatch(dashboard, /RAIBITSERVER_(?:COOKIE_DOMAIN|DASHBOARD_ORIGIN)/);
  assert.match(dashboard, /readinessProbe:[\s\S]*livenessProbe:/);
  assert.match(api, /NODE_ENV[\s\S]*production/);
  assert.match(api, /readinessProbe:[\s\S]*livenessProbe:/);

  assert.ok((services.match(/kind:\s*Service/g) || []).length >= 2, 'API and dashboard need Services');
  assert.match(ingress, /tls:[\s\S]*secretName:/);
  assert.match(ingress, /\.Values\.ingress\.hosts\.public[\s\S]*-dashboard/);
  assert.match(ingress, /backend:[\s\S]*service:/);
  assert.match(migration, /kind:\s*Job/);
  assert.match(migration, /helm\.sh\/hook:\s*pre-install,pre-upgrade/);
  assert.match(migration, /migrate["',\s]+deploy/);
  assert.match(migration, /backoffLimit:/);

  assert.match(availability, /kind:\s*PodDisruptionBudget/);
  assert.match(availability, /kind:\s*HorizontalPodAutoscaler/);
  assert.match(values, /runtimeSecrets:[\s\S]*existingSecret:/);
  assert.match(values, /dashboard:[\s\S]*replicas:/);
  assert.match(values, /dashboard:[\s\S]*consoleUrl:\s*["']{2}/);
  assert.match(values, /ingress:[\s\S]*hosts:[\s\S]*public:\s*raibitserver\.app/);
  assert.match(values, /ingress:[\s\S]*tls:[\s\S]*existingSecret:/);
  assert.match(fixture, /dashboard:\s*[\s\S]*host:/);
  assert.match(fixture, /dashboard:[\s\S]*consoleUrl:\s*https:\/\/console\.production\.example\/console/);
  assert.match(fixture, /hosts:[\s\S]*public:\s*production\.example/);
  assert.match(fixture, /runtimeSecrets:[\s\S]*existingSecret:\s*ci-/);

  const chartTemplates = await Promise.all((await fs.readdir('infra/helm/raibitserver/templates')).map(async (name) => [name, await fs.readFile(`infra/helm/raibitserver/templates/${name}`, 'utf8')]));
  for (const [name, template] of chartTemplates) {
    assert.doesNotMatch(template, /^kind:\s*Secret\s*$/m, `${name} must not generate application credentials`);
  }
});

test('Helm installs platform CRDs and scopes cluster RBAC names per release', async () => {
  const [workerSecurity, crdNames, chart] = await Promise.all([
    readText('infra/helm/raibitserver/templates/worker-security.yaml'),
    fs.readdir('infra/helm/raibitserver/crds'),
    fs.readFile('infra/helm/raibitserver/Chart.yaml', 'utf8'),
  ]);

  assert.match(chart, /kubeVersion:\s*["']>=1\.30\.0-0["']/);
  assert.ok(crdNames.some((name) => name.includes('appservice')));
  assert.ok(crdNames.some((name) => name.includes('manageddatabase')));
  assert.ok(crdNames.some((name) => name.includes('managedresources')));
  assert.match(workerSecurity, /kind:\s*ClusterRole[\s\S]*include\s+"raibitserver\.fullname"/);
  assert.match(workerSecurity, /kind:\s*ClusterRoleBinding[\s\S]*include\s+"raibitserver\.fullname"/);
  assert.doesNotMatch(workerSecurity, /metadata:\s*\n\s*name:\s*raibitserver-(?:orchestrator|provisioner|builder)\s*$/m);
});

test('non-production Helm worker defaults remain dry-run', async () => {
  const [orchestrator, provisioner, values] = await Promise.all([
    fs.readFile('infra/helm/raibitserver/templates/orchestrator-deployment.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/templates/provisioner-deployment.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/values.yaml', 'utf8'),
  ]);

  for (const [name, worker] of [['orchestrator', orchestrator], ['provisioner', provisioner]]) {
    assert.match(values, new RegExp(`${name}:[\\s\\S]{0,80}execute:\\s*false`));
    assert.match(worker, new RegExp(`RAIBITSERVER_DRY_RUN[\\s\\S]{0,160}ternary\\s+"0"\\s+"1"\\s+\\.Values\\.${name}\\.execute`));
    assert.match(worker, new RegExp(`RAIBITSERVER_EXECUTE[\\s\\S]{0,160}ternary\\s+"1"\\s+"0"\\s+\\.Values\\.${name}\\.execute`));
  }
});

test('production provisioner wires digest-pinned providers behind tenant-scoped RBAC', async () => {
  const [deployment, values, fixture, verifier, workerSecurity, validation] = await Promise.all([
    fs.readFile('infra/helm/raibitserver/templates/provisioner-deployment.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/values.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/ci-production-values.yaml', 'utf8'),
    fs.readFile('scripts/verify-helm.sh', 'utf8'),
    readText('infra/helm/raibitserver/templates/worker-security.yaml'),
    fs.readFile('infra/helm/raibitserver/templates/validate.yaml', 'utf8'),
  ]);
  const providers = [
    ['postgresql', 'POSTGRESQL'],
    ['mysql', 'MYSQL'],
    ['mariadb', 'MARIADB'],
    ['mongodb', 'MONGODB'],
    ['redis', 'REDIS'],
    ['valkey', 'VALKEY'],
    ['minio', 'MINIO'],
    ['qdrant', 'QDRANT'],
    ['nats', 'NATS'],
  ];
  const liveProviders = new Set(['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey']);

  assert.match(values, /provisioner:[\s\S]*providerImages:/);
  assert.match(values, /provisioner:[\s\S]*healthIntervalSeconds:\s*300/);
  assert.match(validation, /provisioner\.healthIntervalSeconds must be a positive integer/);
  assert.match(validation, /regexMatch "\^\[0-9\]\*\[1-9\]\[0-9\]\*\$" \(toString \.Values\.provisioner\.healthIntervalSeconds\)/);
  assert.match(deployment, /regexMatch\s+"\^\[A-Za-z0-9\]/);
  assert.match(deployment, /production provider image .*valid sha256 digest/);
  for (const [key, envSuffix] of providers) {
    assert.match(values, new RegExp(`\\n\\s{4}${key}:\\s*""`), `default provider image ${key} must stay empty`);
    assert.match(deployment, new RegExp(`RAIBITSERVER_PROVIDER_${envSuffix}_IMAGE`));
    assert.match(deployment, new RegExp(`providerImages\\.${key}`));
    assert.match(fixture, new RegExp(`\\n\\s{4}${key}:\\s*[^\\s]+@sha256:[a-f0-9]{64}`), `production fixture must pin ${key}`);
    if (liveProviders.has(key)) {
      assert.match(verifier, new RegExp(`missing-${key}-provider-image`), `Helm verifier must reject missing live provider ${key}`);
    } else {
      assert.doesNotMatch(verifier, new RegExp(`missing-${key}-provider-image`), `plan-only provider ${key} may stay disabled`);
    }
  }
  assert.match(verifier, /mutable-redis-provider-image/);

  const bootstrapRoleStart = workerSecurity.indexOf('kind: ClusterRole\nmetadata:\n  name: {{ include "raibitserver.fullname" . }}-provisioner\nrules:');
  const bootstrapRoleEnd = workerSecurity.indexOf('\n---', bootstrapRoleStart);
  assert.ok(bootstrapRoleStart >= 0 && bootstrapRoleEnd > bootstrapRoleStart, 'provisioner bootstrap ClusterRole must exist');
  const bootstrapRole = workerSecurity.slice(bootstrapRoleStart, bootstrapRoleEnd);
  assert.match(bootstrapRole, /resources: \["namespaces"\][\s\S]*verbs: \["get", "create", "patch", "update"\]/);
  assert.match(bootstrapRole, /resources: \["rolebindings"\][\s\S]*verbs: \["get", "create", "patch", "update"\]/);
  assert.match(bootstrapRole, /resources: \["clusterroles"\][\s\S]*resourceNames: \[{{ include "raibitserver\.fullname" \. }}-provisioner-tenant\][\s\S]*verbs: \["bind"\]/);
  for (const resource of ['secrets', 'persistentvolumeclaims', 'services', 'pods', 'pods/exec', 'statefulsets', 'networkpolicies']) {
    assert.doesNotMatch(bootstrapRole, new RegExp(`"${resource.replace('/', '\\/')}"`), `cluster-wide provisioner RBAC must not include ${resource}`);
  }

  const tenantRoleStart = workerSecurity.indexOf('kind: ClusterRole\nmetadata:\n  name: {{ include "raibitserver.fullname" . }}-provisioner-tenant\nrules:');
  const tenantRoleEnd = workerSecurity.indexOf('\n---', tenantRoleStart);
  assert.ok(tenantRoleStart >= 0 && tenantRoleEnd > tenantRoleStart, 'unbound provisioner tenant ClusterRole must exist');
  const tenantRole = workerSecurity.slice(tenantRoleStart, tenantRoleEnd);
  const tenantSecretRule = tenantRole.match(/resources: \["secrets"\][\s\S]{0,240}?verbs: \[([^\]]+)\]/)?.[1] ?? '';
  assert.ok(tenantSecretRule, 'tenant Secret RBAC rule must exist');
  assert.match(tenantSecretRule, /^"create", "patch", "delete"$/, 'credential Secret crash recovery needs dry-run metadata patch plus create/delete');
  for (const forbiddenVerb of ['get', 'list', 'watch', 'update']) {
    assert.doesNotMatch(tenantSecretRule, new RegExp(`"${forbiddenVerb}"`), `tenant Secret RBAC must not grant ${forbiddenVerb}`);
  }
  assert.match(tenantRole, /resources: \["persistentvolumeclaims", "services"\][\s\S]*verbs: \["get", "create", "patch", "update", "delete"\]/);
  assert.match(tenantRole, /resources: \["statefulsets"\][\s\S]*verbs: \["get", "watch", "create", "patch", "update", "delete"\]/);
  assert.match(tenantRole, /resources: \["networkpolicies"\][\s\S]*verbs: \["get", "watch", "create", "patch", "update", "delete"\]/);
  assert.doesNotMatch(tenantRole, /"pods(?:\/exec)?"/);
  assert.doesNotMatch(tenantRole, /manageddatabases/, 'legacy CRD permissions must not replace real provider workload permissions');

  const clusterBindings = workerSecurity.match(/kind: ClusterRoleBinding[\s\S]*?(?=\n---|$)/g) ?? [];
  assert.ok(clusterBindings.length > 0);
  assert.ok(clusterBindings.every((binding) => !binding.includes('-provisioner-tenant')), 'tenant ClusterRole must never be cluster-bound');
  for (const envName of [
    'RAIBITSERVER_PROVISIONER_SERVICE_ACCOUNT_NAME',
    'RAIBITSERVER_PROVISIONER_SERVICE_ACCOUNT_NAMESPACE',
    'RAIBITSERVER_PROVISIONER_TENANT_ROLE_NAME',
  ]) {
    assert.match(deployment, new RegExp(`name: ${envName}`), `${envName} must be passed to the provisioner`);
  }

  assert.match(workerSecurity, /kind:\s*ValidatingAdmissionPolicy/g);
  assert.match(workerSecurity, /kind:\s*ValidatingAdmissionPolicyBinding/g);
  assert.match(workerSecurity, /failurePolicy:\s*Fail/g);
  assert.match(workerSecurity, /validationActions:\s*\["Deny"\]/g);
  assert.match(workerSecurity, /request\.userInfo\.username/);
  assert.match(workerSecurity, /raibitserver\.io\/managed/);
  assert.match(workerSecurity, /oldObject[\s\S]*raibitserver\.io\/managed/, 'an unmanaged existing namespace must not be relabeled as managed');
  assert.match(workerSecurity, /pod-security\.kubernetes\.io\/enforce[\s\S]*restricted/);
  assert.match(workerSecurity, /pod-security\.kubernetes\.io\/audit[\s\S]*restricted/);
  assert.match(workerSecurity, /pod-security\.kubernetes\.io\/warn[\s\S]*restricted/);
  assert.match(workerSecurity, /roleRef[\s\S]*provisioner-tenant/);
  assert.match(workerSecurity, /subjects[\s\S]*ServiceAccount/);
  assert.match(workerSecurity, /operator:\s*NotIn[\s\S]*values:\s*\["true"\]/, 'provisioner mutations must be denied in unmanaged namespaces');
  for (const label of ['app.kubernetes.io/managed-by', 'raibitserver.io/managed', 'raibitserver.io/resource-id', 'raibitserver.io/provider']) {
    assert.match(workerSecurity, new RegExp(label.replace(/[./]/g, '\\$&')), `provider mutation admission must require ${label}`);
  }
  for (const renderedContract of [
    'RAIBITSERVER_PROVISIONER_TENANT_ROLE_NAME',
    'provisioner-namespace-boundary',
    'provisioner-rolebinding-boundary',
    'provisioner-provider-ownership',
    'provisioner-tenant-namespace-only',
  ]) {
    assert.match(verifier, new RegExp(renderedContract), `Helm verifier must inspect ${renderedContract}`);
  }
  assert.match(verifier, /provisioner RBAC must not grant pod exec/);
  assert.match(verifier, /provisioner tenant Secret RBAC must grant only create, dry-run metadata patch, and delete/);
});

test('orchestrator cluster authority is admission-confined to compiler-owned application tenants', async () => {
  const [workerSecurity, providerCompiler, verifier, values, orchestratorDeployment, apiDeployment] = await Promise.all([
    readText('infra/helm/raibitserver/templates/worker-security.yaml'),
    fs.readFile('services/provisioner/internal/provider/compiler.go', 'utf8'),
    fs.readFile('scripts/verify-helm.sh', 'utf8'),
    fs.readFile('infra/helm/raibitserver/values.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/templates/orchestrator-deployment.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/templates/api-deployment.yaml', 'utf8'),
  ]);
  for (const policy of ['orchestrator-namespace-boundary', 'orchestrator-resourcequota-boundary', 'orchestrator-workload-boundary']) {
    assert.match(workerSecurity, new RegExp(`name: \\{\\{ include "raibitserver\\.fullname" \\. \\}\\}-${policy}`));
    assert.match(verifier, new RegExp(policy), `Helm verifier must render ${policy}`);
  }
  assert.match(workerSecurity, /request\.userInfo\.username == 'system:serviceaccount:%s:%s-orchestrator'/);
  assert.match(workerSecurity, /raibitserver\.io\/namespace-kind[\s\S]*application/);
  assert.match(workerSecurity, /pod-security\.kubernetes\.io\/enforce[\s\S]*restricted/);
  assert.match(workerSecurity, /oldObject == null[\s\S]*raibitserver\.io\/managed/);
  assert.match(workerSecurity, /object\.metadata\.labels\.all\(key,[\s\S]*kubernetes\.io\/metadata\.name[\s\S]*raibitserver\.io\/namespace-kind/);
  assert.match(workerSecurity, /!\('raibitserver\.io\/namespace-kind' in oldObject\.metadata\.labels\)[\s\S]*application/);
  assert.doesNotMatch(workerSecurity.match(/orchestrator-namespace-boundary[\s\S]*?(?=kind: ValidatingAdmissionPolicyBinding)/)?.[0] ?? '', /raibitserver\.io\/ingress-gateway/);
  assert.match(values, /gatewayNamespace:\s*ingress-nginx/);
  assert.match(values, /className:\s*nginx/);
  assert.match(orchestratorDeployment, /name: RAIBITSERVER_INGRESS_GATEWAY_NAMESPACE[\s\S]*\.Values\.ingress\.gatewayNamespace/);
  assert.match(orchestratorDeployment, /name: RAIBITSERVER_INGRESS_CLASS_NAME[\s\S]*\.Values\.ingress\.className/);
  assert.match(apiDeployment, /name: RAIBITSERVER_INGRESS_GATEWAY_NAMESPACE[\s\S]*\.Values\.ingress\.gatewayNamespace/);
  assert.match(workerSecurity, /peer\.namespaceSelector\.matchLabels\['kubernetes\.io\/metadata\.name'\] == \{\{ \.Values\.ingress\.gatewayNamespace \| squote \}\}/);
  assert.doesNotMatch(workerSecurity, /peer\.namespaceSelector\.matchLabels\['raibitserver\.io\/ingress-gateway'\]/);
  assert.match(verifier, /configured-ingress-gateway/);
  assert.match(verifier, /invalid-ingress-gateway-namespace/);
  assert.match(workerSecurity, /namespaceObject\.metadata\.labels[\s\S]*raibitserver\.io\/namespace-kind/);
  assert.match(workerSecurity, /variables\.target\.metadata\.labels\['raibitserver\.io\/project-id'\] == namespaceObject\.metadata\.labels\['raibitserver\.io\/project-id'\]/);
  assert.match(workerSecurity, /resources: \["deployments", "jobs", "cronjobs", "services", "ingresses", "networkpolicies"\]/);
  const quotaRoleRule = workerSecurity.match(/resources: \["resourcequotas"\]\s*\n\s*verbs: \[([^\]]+)\]/)?.[1] ?? '';
  assert.match(quotaRoleRule, /"get"/);
  assert.match(quotaRoleRule, /"create"/);
  assert.match(quotaRoleRule, /"patch"/);
  assert.match(quotaRoleRule, /"update"/);
  assert.doesNotMatch(quotaRoleRule, /"delete"/, 'the orchestrator never needs to delete a project quota directly');
  const quotaPolicyStart = workerSecurity.indexOf('kind: ValidatingAdmissionPolicy\nmetadata:\n  name: {{ include "raibitserver.fullname" . }}-orchestrator-resourcequota-boundary');
  const quotaPolicyEnd = workerSecurity.indexOf('\n---\napiVersion: admissionregistration.k8s.io/v1\nkind: ValidatingAdmissionPolicyBinding', quotaPolicyStart);
  assert.ok(quotaPolicyStart >= 0 && quotaPolicyEnd > quotaPolicyStart, 'orchestrator ResourceQuota admission policy must exist');
  const quotaPolicy = workerSecurity.slice(quotaPolicyStart, quotaPolicyEnd);
  assert.match(quotaPolicy, /operations: \["CREATE", "UPDATE"\]/);
  assert.doesNotMatch(quotaPolicy, /operations: \[[^\]]*"DELETE"/);
  assert.match(quotaPolicy, /resources: \["resourcequotas"\]/);
  assert.match(quotaPolicy, /variables\.target\.metadata\.name == 'tenant-resource-budget'/);
  assert.match(quotaPolicy, /variables\.target\.metadata\.labels\.size\(\) == 6/);
  assert.match(quotaPolicy, /variables\.target\.metadata\.labels\['raibitserver\.io\/project-id'\] == namespaceObject\.metadata\.labels\['raibitserver\.io\/project-id'\]/);
  assert.match(quotaPolicy, /variables\.target\.spec\.hard\.size\(\) == 21/);
  assert.match(quotaPolicy, /variables\.expectedHard\.all\(key,[\s\S]*quantity\(variables\.target\.spec\.hard\[key\]\)\.compareTo\(variables\.expectedHard\[key\]\) == 0/);
  assert.doesNotMatch(quotaPolicy, /variables\.target\.spec\.hard\[key\]\.compareTo/);
  assert.match(quotaPolicy, /!has\(variables\.target\.spec\.scopes\)[\s\S]*!has\(variables\.target\.spec\.scopeSelector\)/);
  for (const [resource, quantity] of Object.entries({
    resourcequotas: '1',
    pods: '100',
    'count/pods': '200',
    'count/deployments.apps': '50',
    'count/replicasets.apps': '200',
    'count/statefulsets.apps': '50',
    'count/jobs.batch': '100',
    'count/cronjobs.batch': '50',
    services: '100',
    persistentvolumeclaims: '50',
    secrets: '200',
    configmaps: '100',
    'count/ingresses.networking.k8s.io': '100',
    'count/networkpolicies.networking.k8s.io': '200',
    'requests.cpu': '50',
    'requests.memory': '100Gi',
    'requests.ephemeral-storage': '100Gi',
    'limits.cpu': '100',
    'limits.memory': '200Gi',
    'limits.ephemeral-storage': '200Gi',
    'requests.storage': '1Ti',
  })) {
    const escapedResource = resource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(quotaPolicy, new RegExp(`'${escapedResource}': quantity\\('${quantity}'\\)`), `quota policy must pin ${resource}`);
  }
  assert.match(workerSecurity, /request\.operation == 'DELETE' \? oldObject : object/);
  assert.match(workerSecurity, /raibitserver\.io\/verify-image-signatures[\s\S]*required/);
  assert.match(workerSecurity, /automountServiceAccountToken[\s\S]*false/);
  assert.match(workerSecurity, /allowPrivilegeEscalation[\s\S]*false/);
  assert.match(workerSecurity, /readOnlyRootFilesystem[\s\S]*true/);
  assert.match(workerSecurity, /seccompProfile[\s\S]*RuntimeDefault/);
  assert.match(workerSecurity, /resources\.requests\.size\(\) == 3[\s\S]*requests\['ephemeral-storage'\] == '64Mi'/);
  assert.match(workerSecurity, /resources\.limits\.size\(\) == 3[\s\S]*limits\['ephemeral-storage'\] == '256Mi'/);
  assert.match(workerSecurity, /emptyDir\.sizeLimit == '128Mi'[\s\S]*!has\(variables\.podSpec\.volumes\[0\]\.emptyDir\.medium\)/);
  assert.match(workerSecurity, /@sha256:\[a-f0-9\]\{64\}/);
  assert.match(workerSecurity, /variables\.target\.kind != 'Ingress'[\s\S]*!variables\.ingressHost\.startsWith\('\*\.'\)/);
  assert.match(workerSecurity, /variables\.target\.spec\.ingressClassName == \{\{ \$ingressClassName \| squote \}\}/);
  assert.match(workerSecurity, /variables\.target\.kind != 'NetworkPolicy'[\s\S]*podSelector\.matchLabels\['app\.kubernetes\.io\/name'\]/);
  assert.match(workerSecurity, /has\(rule\.from\)[\s\S]*has\(peer\.namespaceSelector\)[\s\S]*!has\(peer\.ipBlock\)/);
  assert.match(workerSecurity, /has\(rule\.to\)[\s\S]*has\(peer\.ipBlock\)[\s\S]*0\.0\.0\.0\/0[\s\S]*10\.0\.0\.0\/8/);
  assert.match(workerSecurity, /policyTypes\.size\(\) == 2[\s\S]*'Ingress' in variables\.target\.spec\.policyTypes[\s\S]*!has\(peer\.ipBlock\)/);
  assert.match(workerSecurity, /policyTypes\.size\(\) == 1[\s\S]*peer\.ipBlock\.cidr == '0\.0\.0\.0\/0'[\s\S]*peer\.ipBlock\.cidr == '::\/0'/);
  assert.match(providerCompiler, /"raibitserver\.io\/namespace-kind":\s+"application"/);
});

test('provider tenant admission accepts only compiler-shaped resources and preserves ownership', async () => {
  const [workerSecurity, verifier, providerCompiler] = await Promise.all([
    readText('infra/helm/raibitserver/templates/worker-security.yaml'),
    fs.readFile('scripts/verify-helm.sh', 'utf8'),
    fs.readFile('services/provisioner/internal/provider/compiler.go', 'utf8'),
  ]);

  for (const policy of [
    'provider-ownership',
    'provider-pvc-ownership',
    'provider-statefulsets',
    'provider-networkpolicies',
    'provider-secrets',
    'provider-pvcs',
    'provider-services',
    'provider-deletes',
  ]) {
    assert.match(workerSecurity, new RegExp(`provisioner-${policy}`), `missing ${policy} admission policy`);
    assert.match(verifier, new RegExp(`provisioner-${policy}`), `Helm verifier must render ${policy} policy`);
  }

  assert.match(workerSecurity, /objectSelector:[\s\S]*app\.kubernetes\.io\/managed-by:[\s\S]*raibitserver\.io\/managed:/);
  assert.match(workerSecurity, /objectSelector:[\s\S]*key:\s*raibitserver\.io\/provider[\s\S]*operator:\s*Exists[\s\S]*key:\s*raibitserver\.io\/resource-id[\s\S]*operator:\s*Exists/);
  assert.match(workerSecurity, /oldObject\.metadata\.labels/);
  assert.match(workerSecurity, /request\.userInfo\.username == 'system:serviceaccount:/);
  assert.match(workerSecurity, /isStorageController[\s\S]*system:kube-controller-manager/);
  assert.match(workerSecurity, /object\.spec\.resources == oldObject\.spec\.resources/);
  assert.match(workerSecurity, /storage controllers may update only binding fields and controller-owned metadata/);

  for (const statefulSetBoundary of [
    /object\.metadata\.name == variables\.providerName/,
    /automountServiceAccountToken == false/,
    /seccompProfile\.type == 'RuntimeDefault'/,
    /allowPrivilegeEscalation == false/,
    /capabilities\.drop[\s\S]*'ALL'/,
    /!has\(variables\.container\.envFrom\)/,
    /secretKeyRef\.name == variables\.connectionSecret/,
    /variables\.provider == 'postgresql' && env\.name == 'PGDATA'/,
    /env\.value == '\/var\/lib\/postgresql\/data\/pgdata'/,
    /variables\.expectedEnvNames\.all\(name, variables\.container\.env\.filter/,
    /raibitserver\.io\/verify-image-signatures[\s\S]*required/,
    /@sha256:\[a-f0-9\]\{64\}/,
    /expectedEnvNames/,
    /expectedArgs/,
    /resources\.requests\['cpu'\] == '100m'/,
    /resources\.requests\.size\(\) == 3[\s\S]*resources\.requests\['ephemeral-storage'\] == '256Mi'/,
    /resources\.limits\['memory'\] == '1Gi'/,
    /resources\.limits\.size\(\) == 3[\s\S]*resources\.limits\['ephemeral-storage'\] == '1Gi'/,
    /startupProbe\.exec\.command == variables\.container\.readinessProbe\.exec\.command/,
    /startupProbe\.failureThreshold == 120/,
    /unset REDISCLI_AUTH VALKEYCLI_AUTH[\s\S]*--raw AUTH/,
    /probeScript[\s\S]*(?:psql|mariadb|mongosh|redis-cli|valkey-cli)/,
    /!has\(variables\.container\.command\)/,
    /!has\(variables\.container\.lifecycle\)/,
  ]) {
    assert.match(workerSecurity, statefulSetBoundary);
  }
  for (const compilerBoundary of [
    /"startupProbe":\s+startupProbe/,
    /"failureThreshold": 120/,
    /unset REDISCLI_AUTH VALKEYCLI_AUTH/,
    /--raw AUTH/,
    /"resources":\s+map\[string\]any\{"requests"/,
    /"ephemeral-storage": "256Mi"[\s\S]*"ephemeral-storage": "1Gi"/,
    /case "postgresql":[\s\S]*FixedEnvironment:\s*map\[string\]string\{"PGDATA": "\/var\/lib\/postgresql\/data\/pgdata"\}/,
    /for _, key := range fixedKeys[\s\S]*map\[string\]any\{"name": key, "value": contract\.FixedEnvironment\[key\]\}/,
  ]) {
    assert.match(providerCompiler, compilerBoundary, 'admission contract must remain synchronized with the provider compiler');
  }
  assert.equal((providerCompiler.match(/"PGDATA"/g) ?? []).length, 1, 'only the PostgreSQL contract may define PGDATA');

  const secretPolicyStart = workerSecurity.indexOf('kind: ValidatingAdmissionPolicy\nmetadata:\n  name: {{ include "raibitserver.fullname" . }}-provisioner-provider-secrets');
  const secretPolicyEnd = workerSecurity.indexOf('\n---\napiVersion: admissionregistration.k8s.io/v1\nkind: ValidatingAdmissionPolicyBinding', secretPolicyStart);
  assert.ok(secretPolicyStart >= 0 && secretPolicyEnd > secretPolicyStart, 'provider Secret admission policy must exist');
  const secretPolicy = workerSecurity.slice(secretPolicyStart, secretPolicyEnd);

  assert.match(workerSecurity, /object\.metadata\.name == variables\.providerName \+ '-provider'/);
  assert.match(workerSecurity, /variables\.policy\.egress\.size\(\) == 0/);
  assert.match(workerSecurity, /policyTypes[\s\S]*'Ingress'[\s\S]*'Egress'/);
  assert.match(workerSecurity, /namespaceObject\.metadata\.name/);
  assert.match(workerSecurity, /podSelector\.matchLabels\['app\.kubernetes\.io\/name'\] == variables\.providerName/);

  assert.match(secretPolicy, /variables\.target\.metadata\.name == variables\.providerName \+ '-connection'/);
  assert.match(secretPolicy, /provisioner-service-account-or-connection-reservation/);
  assert.match(secretPolicy, /request\.userInfo\.username == [^\n]+-provisioner[^\n]+\|\|/);
  assert.match(secretPolicy, /request\.operation == 'DELETE' \? oldObject : object/);
  assert.match(secretPolicy, /variables\.target\.metadata\.labels\['raibitserver\.io\/project-id'\] == namespaceObject\.metadata\.labels\['raibitserver\.io\/project-id'\]/);
  assert.match(secretPolicy, /oldObject\.metadata\.name\.endsWith\('-connection'\)/, 'connection Secret names must stay reserved even without managed labels');
  assert.match(workerSecurity, /policyName:[^\n]*provisioner-provider-secrets[\s\S]*namespaceSelector:[\s\S]*raibitserver\.io\/managed: "true"/, 'connection suffix reservation must not affect unrelated cluster namespaces');
  assert.match(secretPolicy, /expectedSecretKeys[\s\S]*'nats\.conf'/, 'connection Secret keys must use a finite per-engine contract');
  assert.match(secretPolicy, /object\.data\.all\(key, key in variables\.expectedSecretKeys\)/);
  assert.match(secretPolicy, /request\.operation != 'CREATE' \|\|/, 'exact Secret shape must be checked on create');
  assert.match(secretPolicy, /object\.type == 'Opaque'/);
  assert.match(secretPolicy, /object\.metadata\.labels == oldObject\.metadata\.labels/);
  assert.match(secretPolicy, /raibitserver\.io\/credential-generation[^\n]+matches\('\^\[A-Za-z0-9_-\]\{43\}\$'\)/);
  assert.match(secretPolicy, /object\.metadata\.annotations == oldObject\.metadata\.annotations/);
  assert.match(secretPolicy, /request\.operation != 'UPDATE' \|\| \(has\(request\.dryRun\) && request\.dryRun == true\)/, 'provider Secret patch permission must be restricted to dry-run metadata inspection');
  assert.match(secretPolicy, /request\.options\.preconditions\.uid == oldObject\.metadata\.uid/, 'connection Secret deletion must be UID-preconditioned');
  const deletePolicyStart = workerSecurity.indexOf('kind: ValidatingAdmissionPolicy\nmetadata:\n  name: {{ include "raibitserver.fullname" . }}-provisioner-provider-deletes');
  const deletePolicyEnd = workerSecurity.indexOf('\n---\napiVersion: admissionregistration.k8s.io/v1\nkind: ValidatingAdmissionPolicyBinding', deletePolicyStart);
  assert.ok(deletePolicyStart >= 0 && deletePolicyEnd > deletePolicyStart, 'provider destructive operations need a catch-all delete boundary');
  const deletePolicy = workerSecurity.slice(deletePolicyStart, deletePolicyEnd);
  assert.match(deletePolicy, /operations: \["DELETE"\]/);
  assert.match(deletePolicy, /resources: \["persistentvolumeclaims", "services"\]/);
  assert.match(deletePolicy, /resources: \["statefulsets"\]/);
  assert.match(deletePolicy, /resources: \["networkpolicies"\]/);
  assert.match(deletePolicy, /request\.operation == 'DELETE' \? oldObject : object/);
  assert.match(deletePolicy, /variables\.target\.metadata\.labels\['raibitserver\.io\/project-id'\] == namespaceObject\.metadata\.labels\['raibitserver\.io\/project-id'\]/);
  assert.match(deletePolicy, /request\.options\.preconditions\.uid == oldObject\.metadata\.uid/);
  assert.match(workerSecurity, /object\.metadata\.name == variables\.providerName \+ '-data'/);
  assert.match(workerSecurity, /object\.spec\.clusterIP == 'None'/);
  assert.match(workerSecurity, /object\.spec\.selector\['app\.kubernetes\.io\/name'\] == variables\.providerName/);

  const tenantNetworkPolicyRule = workerSecurity.match(/resources: \["networkpolicies"\]\s*\n\s*verbs: \[([^\]]+)\]/)?.[1] ?? '';
  assert.ok(tenantNetworkPolicyRule, 'tenant NetworkPolicy RBAC rule must exist');
  assert.match(tenantNetworkPolicyRule, /"delete"/, 'provider deletion must be able to remove its exact managed NetworkPolicy tombstone');
});

test('provider NetworkPolicy admission accepts API-normalized deny-all egress', async () => {
  const workerSecurity = await fs.readFile('infra/helm/raibitserver/templates/worker-security.yaml', 'utf8');
  const policy = workerSecurity.match(
    /name: \{\{ include "raibitserver\.fullname" \. \}\}-provisioner-provider-networkpolicies[\s\S]*?message: "provider NetworkPolicies must select only the provider pod and deny all egress"/,
  )?.[0] ?? '';

  assert.ok(policy, 'provider NetworkPolicy admission validation must be present');
  assert.match(
    policy,
    /\(!has\(variables\.policy\.egress\) \|\| variables\.policy\.egress\.size\(\) == 0\)/,
    'Kubernetes may normalize an explicit empty egress list to an absent field; both forms must retain deny-all semantics',
  );
});

test('production observability ingesters use bounded config, least privilege, and explicit egress', async () => {
  const [deployments, security, values, fixture] = await Promise.all([
    fs.readFile('infra/helm/raibitserver/templates/observability-deployments.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/templates/observability-security.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/values.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/ci-production-values.yaml', 'utf8'),
  ]);

  assert.ok((deployments.match(/kind:\s*Deployment/g) || []).length >= 2);
  assert.match(deployments, /\.Values\.production/);
  assert.match(deployments, /\$logs\.enabled/);
  assert.match(deployments, /\$metrics\.enabled/);
  assert.match(deployments, /DATABASE_URL[\s\S]*secretKeyRef:/);
  for (const name of [
    'RAIBITSERVER_DB_MAX_OPEN_CONNS',
    'RAIBITSERVER_INGEST_MAX_PODS',
    'RAIBITSERVER_INGEST_MAX_DURATION',
    'RAIBITSERVER_INGEST_INTERVAL',
  ]) assert.match(deployments, new RegExp(name));
  assert.match(deployments, /readOnlyRootFilesystem:\s*true/);
  assert.match(deployments, /runAsUser:\s*65532/);
  assert.match(deployments, /resources:\s*\n\s*\{\{- toYaml \$logs\.resources/);
  assert.match(deployments, /resources:\s*\n\s*\{\{- toYaml \$metrics\.resources/);

  assert.match(security, /resources:\s*\["pods"\][\s\S]*verbs:\s*\["get",\s*"list",\s*"watch"\]/);
  assert.match(security, /resources:\s*\["pods\/log"\][\s\S]*verbs:\s*\["get"\]/);
  assert.match(security, /apiGroups:\s*\["metrics\.k8s\.io"\][\s\S]*resources:\s*\["pods"\][\s\S]*verbs:\s*\["get",\s*"list",\s*"watch"\]/);
  assert.doesNotMatch(security, /verbs:\s*\[[^\]]*"(?:create|update|patch|delete)"/);
  assert.match(security, /kind:\s*NetworkPolicy/);
  assert.match(security, /kubernetesApiEgress[\s\S]*databaseEgress/);

  assert.match(values, /logIngester:[\s\S]*enabled:\s*false/);
  assert.match(values, /metricsIngester:[\s\S]*enabled:\s*false/);
  assert.match(values, /logIngester:[\s\S]*resources:[\s\S]*requests:[\s\S]*limits:/);
  assert.match(values, /metricsIngester:[\s\S]*resources:[\s\S]*requests:[\s\S]*limits:/);
  assert.match(values, /kubernetesApiEgress:[\s\S]*cidrs:\s*\[\]/);
  assert.match(fixture, /logIngester:[\s\S]*enabled:\s*true/);
  assert.match(fixture, /metricsIngester:[\s\S]*enabled:\s*true/);
  assert.match(fixture, /logIngester:\s*sha256:[a-f0-9]{64}/);
  assert.match(fixture, /metricsIngester:\s*sha256:[a-f0-9]{64}/);
});

test('production Helm verification exercises packaging fail-closed boundaries', async () => {
  const verifier = await fs.readFile('scripts/verify-helm.sh', 'utf8');
  for (const scenario of [
    'missing-dashboard-digest',
    'missing-dashboard-console-url',
    'missing-database-secret',
    'missing-runtime-secret',
    'disabled-migration',
    'disabled-orchestrator-execution',
    'disabled-provisioner-execution',
    'invalid-provisioner-health-interval',
    'unsupported-kubernetes-version',
    'disabled-tls',
    'missing-tls-secret',
    'missing-public-host',
    'shared-public-dashboard-host',
    'mismatched-dashboard-host',
    'mismatched-dashboard-console-url',
    'missing-log-ingester-digest',
    'missing-metrics-ingester-digest',
    'missing-observability-kubernetes-egress',
    'missing-observability-database-egress',
    'missing-postgresql-provider-image',
    'mutable-redis-provider-image',
  ]) {
    assert.match(verifier, new RegExp(scenario), `Helm verifier must exercise ${scenario}`);
  }
});

test('CI validates every production Dockerfile with BuildKit', async () => {
  const ci = await fs.readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /go-version:\s*['"]1\.26\.x['"]/);
  assert.match(ci, /docker\/setup-buildx-action@v\d+/);
  assert.match(ci, /dockerfile:\s*\n(?:\s+-\s+[^\n]+\n){8}/);
  assert.match(ci, /docker buildx build --check --file "?\$\{\{ matrix\.dockerfile \}\}"? \./);
  assert.match(ci, /docker buildx build --file "?\$\{\{ matrix\.dockerfile \}\}"? --provenance=false \./);
});

test('CI runs Go controller recovery contracts against real PostgreSQL', async () => {
  const ci = await fs.readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /RAIBITSERVER_TEST_POSTGRES_DSN:\s*postgresql:\/\/[^\s]+\?sslmode=disable/);
  assert.match(ci, /services\/builder[\s\S]*go test[^\n]+\^TestPostgres/);
  assert.match(ci, /services\/orchestrator[\s\S]*go test[^\n]+\^TestPostgres/);
  assert.match(ci, /services\/provisioner[\s\S]*go test[^\n]+\^TestPostgres/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
