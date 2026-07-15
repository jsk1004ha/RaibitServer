import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildExecutionPlan, executeBuildWorkflow } from '../packages/core/src/build-executor.ts';
import { processBuilderWorkflowJob, reconcileDeploymentRollout } from '../packages/core/src/deployment-workflow.ts';
import { redactGitUrl, sourceCheckoutPlan } from '../packages/core/src/source-control.ts';
import { ControlPlaneStore, DEPLOYMENT_STATUSES, WORKFLOW_TYPES } from '../packages/core/src/index.ts';

const legacyLiveError = /legacy TypeScript builder.*dry-run only.*Go builder/i;

test('legacy TypeScript build surfaces reject live execution before IMAGE_READY', async () => {
  const imageService = {
    name: 'web',
    projectSlug: 'demo',
    sourceType: 'image',
    image: 'registry.example.test/demo/web:latest',
  };
  await assert.rejects(
    () => executeBuildWorkflow(imageService, {}, { dryRun: false, imageDigest: `sha256:${'a'.repeat(64)}` }),
    legacyLiveError,
  );

  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Legacy', slug: 'legacy' });
  const project = store.createProject({ organizationId: organization.id, name: 'Demo', slug: 'demo' });
  const service = store.createService({ projectId: project.id, ...imageService });
  const deployment = store.createDeployment({ serviceId: service.id, imageUrl: imageService.image });
  const job = store.enqueueWorkflowJob({
    type: WORKFLOW_TYPES.BUILD_AND_DEPLOY,
    targetType: 'deployment',
    targetId: deployment.id,
    payload: { deploymentId: deployment.id, serviceId: service.id, projectId: project.id },
  });
  await assert.rejects(() => processBuilderWorkflowJob(store, job, { dryRun: false }), legacyLiveError);
  assert.notEqual(store.snapshot().deployments.find((row) => row.id === deployment.id).status, DEPLOYMENT_STATUSES.IMAGE_READY);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'raibitserver-legacy-live-'));
  const input = path.join(root, 'project.json');
  await fs.writeFile(input, JSON.stringify({ project: { slug: 'demo' }, services: [imageService] }), { mode: 0o600 });
  try {
    const cli = spawnSync(process.execPath, ['src/cli.js', 'build-execute', input, '--execute'], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0, cli.stdout);
    assert.match(cli.stderr, legacyLiveError);
    assert.doesNotMatch(cli.stdout, /IMAGE_READY/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('legacy TypeScript rollout rejects live execution before READY mutation', async () => {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Legacy Rollout', slug: 'legacy-rollout' });
  const project = store.createProject({ organizationId: organization.id, name: 'Demo', slug: 'demo' });
  const service = store.createService({ projectId: project.id, name: 'web', type: 'web', imageUrl: 'registry.example.test/demo/web@sha256:abc' });
  const deployment = store.createDeployment({
    serviceId: service.id,
    imageUrl: service.imageUrl,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    status: DEPLOYMENT_STATUSES.IMAGE_READY,
  });

  await assert.rejects(
    () => reconcileDeploymentRollout(store, deployment.id, { dryRun: false }),
    /legacy TypeScript rollout.*dry-run only.*Go orchestrator/i,
  );
  const snapshot = store.snapshot();
  assert.equal(snapshot.deployments.find((row) => row.id === deployment.id).status, DEPLOYMENT_STATUSES.IMAGE_READY);
  assert.notEqual(snapshot.services.find((row) => row.id === service.id).status, 'ready');
  assert.equal(snapshot.deploymentEvents.some((event) => event.deploymentId === deployment.id && event.type.startsWith('rollout.')), false);
});

test('legacy TypeScript build planning rejects secret build args and preserves safe args', () => {
  const service = {
    name: 'web',
    projectSlug: 'demo',
    sourceType: 'local',
    localPath: '.',
    dockerfilePath: 'Dockerfile',
    registry: 'registry.example.test/team',
  };
  assert.throws(
    () => buildExecutionPlan(service, { Dockerfile: 'FROM scratch' }, { sourceDir: '/workspace/demo', buildArgs: { API_TOKEN: 'never-on-argv' } }),
    /secret-looking build arg.*BuildKit secret mount/i,
  );
  const safe = buildExecutionPlan(service, { Dockerfile: 'FROM scratch' }, { sourceDir: '/workspace/demo', buildArgs: { PUBLIC_VERSION: '2026.07' } });
  assert.match(safe.buildCommand, /--build-arg PUBLIC_VERSION=2026\.07/);
});

test('Git URL validation rejects userinfo and credential query parameters without echoing secrets', () => {
  const cases = [
    ['http://user:http-secret@github.com/acme/demo.git', 'http-secret'],
    ['https://user:https-secret@github.com/acme/demo.git', 'https-secret'],
    ['file://user:file-secret@localhost/repo.git', 'file-secret'],
    ['file:///tmp/repo.git?access_token=file-query-secret', 'file-query-secret'],
    ['https://github.com/acme/demo.git?access_token=query-secret', 'query-secret'],
    ['https://github.com/acme/demo.git?ref=main&api_key=query-key', 'query-key'],
    ['https://github.com/acme/demo.git?client_secret=oauth-secret', 'oauth-secret'],
  ];
  for (const [repoUrl, secret] of cases) {
    assert.throws(
      () => sourceCheckoutPlan({ name: 'web', sourceType: 'github', repoUrl }),
      (error) => {
        assert.match(error.message, /credentialed git URLs are not allowed/i);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  }
  const redacted = redactGitUrl('https://user:plain-secret@github.com/acme/demo.git?access_token=query-secret&ref=main');
  assert.equal(redacted.includes('plain-secret'), false);
  assert.equal(redacted.includes('query-secret'), false);
  assert.match(redacted, /\*\*\*\*/);

  for (const [repoUrl, secret] of cases.filter(([url]) => url.startsWith('file:'))) {
    const fileRedacted = redactGitUrl(repoUrl);
    assert.equal(fileRedacted.includes(secret), false);
    assert.match(fileRedacted, /\*\*\*\*/);
  }
});

test('temporary Git askpass material uses a private random directory and guaranteed cleanup', async () => {
  const source = await fs.readFile('packages/core/src/source-control.ts', 'utf8');
  assert.match(source, /fs\.mkdtemp\(/);
  assert.match(source, /mode:\s*0o700/);
  assert.match(source, /fs\.rm\([^)]*recursive:\s*true[^)]*force:\s*true/s);
  assert.doesNotMatch(source, /git-askpass-\$\{process\.pid\}/);
});

test('legacy raw-manifest orchestrator refuses live kubectl execution', async () => {
  const source = await fs.readFile('services/orchestrator/main.go', 'utf8');
  assert.match(source, /dry-run planning only/i);
  assert.match(source, /cmd\/orchestrator.*control-plane reconciler/i);
  assert.doesNotMatch(source, /exec\.Command\(|cmd\.Run\(/);
});

test('Go workflow ownership is fenced and renewed during long builds', async () => {
  const [store, postgres, builder, storeTests] = await Promise.all([
    fs.readFile('services/builder/internal/controlplane/store.go', 'utf8'),
    fs.readFile('services/builder/internal/controlplane/postgres_store.go', 'utf8'),
    fs.readFile('services/builder/internal/worker/builder.go', 'utf8'),
    fs.readFile('services/builder/internal/controlplane/store_test.go', 'utf8'),
  ]);
  assert.match(store, /type WorkflowLease struct/);
  assert.match(store, /RenewWorkflowJobLease/);
  assert.match(store, /ErrWorkflowLeaseLost/);
  assert.match(postgres, /status\s*=\s*'running'[\s\S]*lockedBy[\s\S]*attempts/);
  assert.match(builder, /leaseHeartbeat|renewWorkflowLease/i);
  assert.match(storeTests, /TestFileStoreFencesReclaimedWorkflowLease/);
  assert.match(storeTests, /TestFileStoreRenewedLeaseCannotBeReclaimed/);
});

test('builder dispatcher keeps database authority outside tenant BuildKit Pods', async () => {
  const [main, remoteStore, helm, security] = await Promise.all([
    fs.readFile('services/builder/cmd/builder/main.go', 'utf8'),
    fs.readFile('services/builder/internal/controlplane/remote_store.go', 'utf8'),
    fs.readFile('infra/helm/raibitserver/templates/builder-deployment.yaml', 'utf8'),
    fs.readFile('infra/helm/raibitserver/templates/worker-security.yaml', 'utf8'),
  ]);
  assert.match(main, /RAIBITSERVER_BUILDER_ROLE[\s\S]*dispatcher[\s\S]*executor/);
  assert.match(main, /must not receive database credentials/);
  assert.match(remoteStore, /tls\.RequireAndVerifyClientCert/);
  assert.match(remoteStore, /MinVersion:\s*tls\.VersionTLS13/);
  assert.doesNotMatch(remoteStore, /InsecureSkipVerify/);
  assert.match(remoteStore, /crypto\/rand/);
  assert.match(remoteStore, /scope_mismatch/);
  assert.match(remoteStore, /http\.MaxBytesReader/);
  assert.match(helm, /builder-dispatcher[\s\S]*DATABASE_URL/);
  assert.match(helm, /builder-executor[\s\S]*RAIBITSERVER_CONTROL_PLANE_REMOTE_URL/);
  assert.match(security, /builder-dispatcher[\s\S]*databaseEgress/);
  assert.match(security, /builder-executor[\s\S]*except:[\s\S]*\$databaseEgress\.cidrs/);
});

test('every live Go build requires scan, sign, and a configured registry destination', async () => {
  const [builder, builderTests, builderIsolationTests] = await Promise.all([
    fs.readFile('services/builder/internal/worker/builder.go', 'utf8'),
    fs.readFile('services/builder/internal/worker/builder_test.go', 'utf8'),
    fs.readFile('services/builder/internal/worker/builder_isolation_test.go', 'utf8'),
  ]);
  const builderTestSource = `${builderTests}\n${builderIsolationTests}`;
  assert.match(builder, /live builder requires fail-closed vulnerability scanning/i);
  assert.match(builder, /live builder requires image signing/i);
  assert.match(builder, /outside configured registry|configured registry prefix/i);
  assert.match(builder, /private registry|private address/i);
  assert.match(builder, /build\.image_scan_failed/);
  assert.match(builder, /build\.image_sign_failed/);
  for (const name of [
    'TestBuilderLiveBuildRejectsDisabledScanOrSign',
    'TestBuilderSignFailurePreventsImageReady',
    'TestBuilderRejectsSourceRegistryDestinationOverride',
    'TestBuilderRejectsSourceImageDestinationOverrideWithinRegistryPrefix',
    'TestBuilderRejectsPrivateRegistryOverride',
    'TestBuilderRejectsCredentialedGitURLVariants',
  ]) {
    assert.match(builderTestSource, new RegExp(name));
  }
});

test('builder and orchestrator reject conflicting digests and mutable rollback targets', async () => {
  const [builder, builderTests, kube, kubeTests, reconciler, reconcilerTests] = await Promise.all([
    fs.readFile('services/builder/internal/worker/builder.go', 'utf8'),
    fs.readFile('services/builder/internal/worker/builder_test.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/kube/deployment.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/kube/deployment_test.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/reconciler/reconciler.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/reconciler/reconciler_test.go', 'utf8'),
  ]);
  assert.match(builder, /image digest conflict/i);
  assert.match(builderTests, /TestBuilderRejectsConflictingEmbeddedAndRecordedDigest/);
  assert.match(kube, /image digest conflict/i);
  assert.match(kubeTests, /TestResolveImageReferenceRejectsDigestConflict/);
  assert.match(reconciler, /previousImageUrl.*digest-pinned/i);
  assert.match(reconcilerTests, /TestRollbackRequiresDigestPinnedPreviousImage/);
  assert.match(reconcilerTests, /TestRollbackUsesPreviousEmbeddedDigestInsteadOfCurrentDigest/);
});
