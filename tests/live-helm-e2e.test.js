import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import YAML from 'yaml';

const scriptPath = 'scripts/live-helm-e2e.sh';

test('public live package commands reach the real kind Helm gate while dry commands stay deterministic', async () => {
  const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const { scripts } = packageJson;

  assert.equal(scripts['e2e:live:helm'], 'bash scripts/live-helm-e2e.sh');
  assert.equal(scripts['e2e:live'], 'pnpm e2e:live:helm');
  assert.equal(scripts['dev:e2e:live'], 'pnpm e2e:live:helm');
  assert.equal(scripts['e2e:dry'], 'node scripts/dev-e2e.mjs --mode dry');
  assert.equal(scripts['dev:e2e:dry'], 'node scripts/dev-e2e.mjs --mode dry');
  assert.doesNotMatch(scripts['e2e:live'], /dev-e2e\.mjs/);
  assert.doesNotMatch(scripts['dev:e2e:live'], /dev-e2e\.mjs/);
});

test('live Helm cleanup fails the gate when its disposable cluster cannot be removed', async () => {
  const script = await fs.readFile(scriptPath, 'utf8');
  assert.doesNotMatch(script, /kind delete cluster[^\n]+\|\| true/);
  assert.match(script, /if ! kind delete cluster --name "\$\{CLUSTER_NAME\}"/);
  assert.match(script, /failed to delete kind cluster/);
  assert.match(script, /if \[\[ "\$\{status\}" -eq 0 \]\]; then[\s\S]{0,80}status=1/);
});

test('live Helm E2E exercises real images, migrations, API health, and an orchestrator transition', async () => {
  const script = (await fs.readFile(scriptPath, 'utf8')).replace(/\r\n/g, '\n');

  assert.match(script, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/m);
  assert.match(script, /for command in docker kind kubectl helm curl go/);
  assert.match(script, /require_command "\$\{command\}"/);

  for (const component of ['api', 'orchestrator', 'provisioner']) {
    assert.match(script, new RegExp(`docker build[^\n]+${escapeRegExp(`${component}/Dockerfile`)}`));
    assert.match(script, new RegExp(`kind load docker-image[^\n]+raibitserver/${component}`));
  }
  assert.doesNotMatch(script, /docker build[^\n]+services\/builder\/Dockerfile/);
  assert.match(script, /--set builder\.replicas=0/);
  assert.match(script, /kind create cluster[^\n]+--image "\$\{KIND_NODE_IMAGE\}"/);
  assert.match(script, /postgres:16\.[0-9]+-alpine[0-9.]+@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(script, /POSTGRES_RUNTIME_IMAGE|docker tag "\$\{POSTGRES_IMAGE\}"/);
  assert.match(script, /docker exec "\$\{CLUSTER_NAME\}-control-plane" crictl pull "\$\{POSTGRES_IMAGE\}"/);
  assert.match(script, /image: \$\{POSTGRES_IMAGE\}/);
  assert.match(script, /name: postgres[\s\S]{0,800}automountServiceAccountToken: false/);
  assert.match(script, /name: postgres[\s\S]{0,1000}runAsNonRoot: true/);
  assert.match(script, /name: postgres[\s\S]{0,1000}seccompProfile:[\s\S]{0,40}RuntimeDefault/);
  const postgresManifest = script.match(/apply -f - <<EOF\r?\n([\s\S]*?)\r?\nEOF/)?.[1];
  assert.ok(postgresManifest, 'script must embed the PostgreSQL Deployment and Service');
  const renderedPostgresManifest = postgresManifest.replace(/\$\{[A-Z_]+\}/g, 'live-e2e-value');
  const postgresDocuments = YAML.parseAllDocuments(renderedPostgresManifest);
  assert.deepEqual(postgresDocuments.flatMap((document) => document.errors), []);
  assert.deepEqual(postgresDocuments.map((document) => document.get('kind')), ['Deployment', 'Service']);
  assert.match(script, /helm upgrade --install/);
  assert.match(script, /RAIBITSERVER_EMAIL_WEBHOOK_URL=/);
  assert.match(script, /RAIBITSERVER_EMAIL_FROM=/);
  assert.match(script, /prisma_migrations/);
  assert.match(script, /RAIBITSERVER_TEST_POSTGRES_DSN=[\s\S]{0,300}go test[\s\S]{0,240}TestPostgresDeletionLeaseUsesStoredTimestamp/);
  assert.match(script, /TestPostgresClaimReapsExpiredExhaustedBuild/);
  assert.match(script, /TestPostgresReadyProviderReplacementTransitionsToFailed/);
  assert.match(script, /curl --fail --silent --show-error[^\n]+\/api\/health/);

  assert.match(script, /--set provisioner\.execute=true/);
  // Health checks are driven explicitly below; the long interval prevents a
  // wall-clock race between a fresh claim and scaling the worker down.
  assert.match(script, /--set provisioner\.healthIntervalSeconds=300/);
  assert.match(script, /provisioner\.providerImages\.postgresql=\$\{POSTGRES_IMAGE\}/);
  assert.doesNotMatch(script, /--set security\.imageVerification\.enabled=false/);
  assert.match(script, /verify-image-signatures/);
  // The public API historically writes lowercase lifecycle values. Keeping the
  // live seed lowercase guards the provisioner's case-insensitive claim path.
  assert.match(script, /INSERT INTO "Resource"[\s\S]{0,700}'live-postgresql'[\s\S]{0,300}'provisioning'/);
  assert.match(script, /"storageGb":1/);
  assert.match(script, /get pvc "\$\{PROVIDER_NAME\}-data"[\s\S]{0,180}requests\.storage[\s\S]{0,100}1Gi/);
  assert.match(script, /connectionSecretName/);
  assert.match(script, /statefulset\/\$\{PROVIDER_NAME\}/);
  assert.match(script, /statefulset\/\$\{PROVIDER_NAME\}[\s\S]{0,500}psql[\s\S]{0,200}SELECT 1/);
  assert.match(script, /healthCheckedAt/);
  assert.match(script, /credentialSecretUID/);
  assert.match(script, /credential Secret crash recovery through metadata-only dry-run PATCH/);
  assert.match(script, /\\"desiredState\\" = \\"desiredState\\" - 'credentialSecretUID'/);
  assert.match(script, /READY\|\$\{LIVE_PROVIDER_SECRET_UID\}/);
  assert.match(script, /preconditions[\\"]+:[\s\S]{0,80}uid/);
  assert.match(script, /Impersonate-User: \$\{PROVISIONER_USER\}/);
  assert.match(script, /raibitserver\.io\/credential-owner[\"]+:\"raibitserver-provisioner\"/);
  assert.match(script, /raibitserver\.io\/credential-generation[\"]+:\"\$\{PERSISTED_PROVIDER_SECRET_GENERATION\}\"/);
  assert.match(script, /raibitserver\.io\/resource-id[\"]+:\"live-postgresql\"/);
  assert.match(script, /raibitserver\.io\/project-id[\"]+:\"live-provider-project\"/);
  assert.match(script, /REPLACEMENT_PROVIDER_SECRET_UID/);
  assert.match(script, /same-name credential replacement was not rejected/);

  assert.match(script, /DELETE_REQUESTED/);
  assert.match(script, /live-org--live-project/);
  assert.match(script, /kubectl[\s\S]{0,180}scale deployment[\s\S]{0,120}ORCHESTRATOR_DEPLOYMENT[\s\S]{0,60}--replicas=1/);
  assert.match(script, /SELECT COUNT\(\*\) FROM "Project"/);
  assert.match(script, /project_deleted/);
  assert.match(script, /worker_log_verified=0[\s\S]{0,900}project_deleted[\s\S]{0,300}worker_log_verified=1/);
  assert.match(script, /kind delete cluster/);
  assert.match(script, /PASS: kind\/Helm reconciliation[^\n]+tenant BuildKit\/registry lifecycle not covered/);
});

test('live container commands do not trigger Git Bash host-path conversion', async () => {
  const script = await fs.readFile(scriptPath, 'utf8');

  assert.doesNotMatch(script, /-- \/bin\/sh\b/);
  assert.match(script, /-- sh -ec/);
});

test('orchestrator deletion seed satisfies the managed namespace admission contract', async () => {
  const script = await fs.readFile(scriptPath, 'utf8');
  const seedStart = script.indexOf('create namespace "${TENANT_NAMESPACE}"');
  const seedEnd = script.indexOf('create configmap live-deletion-sentinel', seedStart);
  const namespaceSeed = script.slice(seedStart, seedEnd);

  assert.ok(seedStart >= 0 && seedEnd > seedStart, 'script must seed the deletion namespace before its sentinel');
  for (const label of [
    'app.kubernetes.io/managed-by=raibitserver',
    'raibitserver.io/managed=true',
    'raibitserver.io/namespace-kind=application',
    'raibitserver.io/project=live-project',
    'raibitserver.io/project-id=live-project',
    'pod-security.kubernetes.io/enforce=restricted',
    'pod-security.kubernetes.io/audit=restricted',
    'pod-security.kubernetes.io/warn=restricted',
  ]) {
    assert.match(namespaceSeed, new RegExp(escapeRegExp(label)), `missing namespace label ${label}`);
  }
});

test('credential replacement waits for UID-fenced deletion to finish', async () => {
  const script = await fs.readFile(scriptPath, 'utf8');
  const deleteRequest = script.indexOf('--request DELETE');
  const deleteWait = script.indexOf('--for=delete "secret/${PROVIDER_SECRET}"');
  const createRequest = script.indexOf('--request POST');
  const scaleDown = script.indexOf('"${PROVISIONER_DEPLOYMENT}" --replicas=0');
  const scaleUp = script.indexOf('"${PROVISIONER_DEPLOYMENT}" --replicas=1');
  const healthTriggers = [...script.matchAll(/\$\(force_provider_health_check_due\)/g)].map((match) => match.index);

  assert.ok(deleteRequest >= 0, 'script must delete the original credential Secret');
  assert.ok(deleteWait > deleteRequest, 'script must wait after requesting deletion');
  assert.ok(createRequest > deleteWait, 'script must not recreate the Secret before deletion finishes');
  assert.equal(healthTriggers.length, 2, 'script must explicitly schedule both health checks');
  assert.match(script, /interval '301 seconds'/);
  assert.ok(healthTriggers[0] < scaleDown, 'the first health check must complete before scale-down');
  assert.ok(healthTriggers[1] > createRequest, 'replacement health must be scheduled after Secret recreation');
  assert.ok(healthTriggers[1] < scaleUp, 'replacement health must be due before worker restart');
  assert.match(script, /"propagationPolicy":"Background"/);
  assert.doesNotMatch(script, /"propagationPolicy":"Foreground"/);
  assert.match(script, /provisioner scale-down interrupted an active health claim/);
  assert.match(script, /same-name credential replacement was not rejected[^\n]+status=\$\{replacement_status\}/);
  assert.match(script, /healthFailureCount/);
  assert.match(script, /lastHealthError/);
});

test('live gate documentation names its exact coverage and keeps the builder lifecycle gap explicit', async () => {
  const documentation = await fs.readFile('docs/live-e2e.md', 'utf8');

  assert.match(documentation, /kind \/ Helm reconciliation gate/i);
  assert.match(documentation, /API.*migration.*health/is);
  assert.match(documentation, /Provisioner.*PostgreSQL/is);
  assert.match(documentation, /Orchestrator.*namespace.*delet/is);
  assert.match(documentation, /does not.*Go Builder.*build.*registry push.*workload.*HTTP 200/is);
  assert.match(documentation, /external registry.*signing.*scanner/is);
});

test('worker execution is explicit, dry-run by default, and mandatory in production', async () => {
  const [valuesText, orchestrator, provisioner, validation, fixtureText] = await Promise.all([
    fs.readFile('infra/helm/raibitserver/values.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/templates/orchestrator-deployment.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/templates/provisioner-deployment.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/templates/validate.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/ci-production-values.yaml', 'utf8'),
  ]);
  const values = YAML.parse(valuesText);
  const fixture = YAML.parse(fixtureText);

  assert.equal(values.orchestrator.execute, false);
  assert.equal(values.provisioner.execute, false);
  assert.equal(fixture.orchestrator.execute, true);
  assert.equal(fixture.provisioner.execute, true);

  assert.match(orchestrator, /RAIBITSERVER_DRY_RUN[\s\S]{0,160}\.Values\.orchestrator\.execute/);
  assert.match(orchestrator, /RAIBITSERVER_EXECUTE[\s\S]{0,160}\.Values\.orchestrator\.execute/);
  assert.match(provisioner, /RAIBITSERVER_DRY_RUN[\s\S]{0,160}\.Values\.provisioner\.execute/);
  assert.match(provisioner, /RAIBITSERVER_EXECUTE[\s\S]{0,160}\.Values\.provisioner\.execute/);
  assert.match(validation, /production orchestrator execution must be enabled/);
  assert.match(validation, /production provisioner execution must be enabled/);
});

test('CI has a bounded, dedicated kind Helm live gate', async () => {
  const workflowText = await fs.readFile('.github/workflows/ci.yml', 'utf8');
  const workflow = YAML.parse(workflowText);
  const job = workflow.jobs?.['live-helm-e2e'];

  assert.ok(job, 'CI must define the live-helm-e2e job');
  assert.match(String(job.name), /kind.*Helm.*live/i);
  assert.ok(Number(job['timeout-minutes']) <= 40, 'live job must have a finite timeout of 40 minutes or less');
  const steps = (job.steps ?? []).map((step) => `${step.uses ?? ''}\n${step.run ?? ''}`).join('\n');
  assert.match(steps, /actions\/setup-go@v5/);
  assert.match(steps, /sigs\.k8s\.io\/kind@v0\.31\.0/);
  assert.match(steps, /azure\/setup-kubectl@v4/);
  assert.match(steps, /azure\/setup-helm@v4/);
  assert.match(steps, /scripts\/live-helm-e2e\.sh/);
});

test('manual live workflow installs the pinned kind Helm toolchain and uses the public command', async () => {
  const workflowText = await fs.readFile('.github/workflows/live-e2e.yml', 'utf8');
  const workflow = YAML.parse(workflowText);
  const job = workflow.jobs?.['live-e2e'];

  assert.ok(job, 'manual workflow must define the live-e2e job');
  assert.match(String(job.name), /kind.*Helm.*reconciliation/i);
  assert.ok(Number(job['timeout-minutes']) <= 40, 'manual live gate must have a finite timeout of 40 minutes or less');
  const steps = (job.steps ?? []).map((step) => `${step.uses ?? ''}\n${step.run ?? ''}`).join('\n');
  assert.match(steps, /actions\/setup-go@v5/);
  assert.match(steps, /azure\/setup-kubectl@v4/);
  assert.match(steps, /azure\/setup-helm@v4/);
  assert.match(steps, /sigs\.k8s\.io\/kind@v0\.31\.0/);
  assert.match(steps, /pnpm e2e:live/);
  assert.doesNotMatch(steps, /kind\|k3d|live-e2e-report\.json/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
