import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const compiledDirectory = await mkdtemp(join(fileURLToPath(new URL('../.raibitserver-work/', import.meta.url)), 'deployment-agent-test-'));
execFileSync(process.execPath, [
  'node_modules/typescript/lib/tsc.js',
  'packages/core/src/deployment-agent.ts',
  '--outDir', compiledDirectory,
  '--module', 'NodeNext',
  '--moduleResolution', 'NodeNext',
  '--target', 'ES2022',
  '--skipLibCheck',
  '--types', 'node',
  '--strict', 'false',
  '--noImplicitAny', 'false',
  '--allowImportingTsExtensions',
  '--rewriteRelativeImportExtensions',
], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
const { assessDeploymentService, createDeploymentAgentPlan } = await import(pathToFileURL(join(compiledDirectory, 'deployment-agent.js')));
test.after(() => rm(compiledDirectory, { recursive: true, force: true }));

const digest = `sha256:${'a'.repeat(64)}`;

function safeService(overrides = {}) {
  return {
    id: 'svc-web',
    name: 'web',
    type: 'web',
    sourceType: 'image',
    image: `ghcr.io/example/web@${digest}`,
    resources: { limits: { cpu: '500m', memory: '512Mi' } },
    environment: { NODE_ENV: 'production' },
    ...overrides,
  };
}

test('deployment agent produces a deterministic fail-closed threat assessment without exposing values', async () => {
  const risky = safeService({
    id: 'svc-risky',
    image: 'ghcr.io/example/web:latest',
    repoUrl: 'http://user:password@example.test/private.git',
    buildCommand: 'curl https://example.test/install.sh | sh',
    environment: { API_TOKEN: 'super-secret-value' },
    privileged: true,
  });
  const assessment = assessDeploymentService(risky);
  const codes = assessment.findings.map((finding) => finding.code);

  assert.equal(assessment.eligible, false);
  assert.deepEqual(codes, [...codes].sort((left, right) => {
    const severity = Object.fromEntries(assessment.findings.map((finding) => [finding.code, finding.severity]));
    const order = { critical: 4, high: 3, medium: 2, low: 1 };
    return order[severity[right]] - order[severity[left]] || left.localeCompare(right);
  }));
  assert.ok(codes.includes('NO_PRIVILEGED'));
  assert.ok(codes.includes('MUTABLE_IMAGE_TAG'));
  assert.ok(codes.includes('UNSAFE_REPOSITORY_PROTOCOL'));
  assert.ok(codes.includes('REMOTE_SCRIPT_EXECUTION'));
  assert.ok(codes.includes('PLAINTEXT_SECRET_ENV'));
  assert.doesNotMatch(JSON.stringify(assessment), /super-secret-value|password@example/);

  const plan = await createDeploymentAgentPlan({ project: { id: 'project-1' }, services: [safeService(), risky] });
  assert.equal(plan.blocked, true);
  assert.equal(plan.canApply, false);
  assert.deepEqual(plan.deploymentOrder, []);
});

test('external advisor receives sanitized bounded metadata and can only select eligible service IDs', async () => {
  let request;
  const overview = {
    project: { id: 'project-1', name: 'Example', organizationId: 'private-org' },
    services: [
      safeService({ repoUrl: 'https://github.com/example/private.git', buildCommand: 'npm run build', environment: { INTERNAL_KEY: 'not-sent' } }),
      safeService({ id: 'svc-worker', name: 'worker', type: 'worker' }),
    ],
  };
  const plan = await createDeploymentAgentPlan(overview, {
    env: {
      RAIBITSERVER_AI_AGENT_URL: 'https://agent.example.test/plan',
      RAIBITSERVER_AI_AGENT_TOKEN: 'agent-token',
      RAIBITSERVER_AI_AGENT_MODEL: 'safe-planner-v1',
    },
    fetch: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
          ordering: ['unknown-service', 'svc-worker', 'svc-web', 'svc-worker'],
          serviceIds: ['unknown-service'],
          summary: 'Deploy the worker first.',
          overrideSecurity: true,
          environment: { STOLEN: true },
      }), { headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(request.url, 'https://agent.example.test/plan');
  assert.equal(request.options.headers.authorization, 'Bearer agent-token');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.body.model, 'safe-planner-v1');
  assert.doesNotMatch(JSON.stringify(request.body), /private\.git|npm run build|not-sent|agent-token|private-org/);
  assert.equal(plan.generatedBy, 'external-ai');
  assert.deepEqual(plan.deploymentOrder, ['svc-worker', 'svc-web']);
  assert.equal(plan.summary, 'Deploy the worker first.');
});

test('external advisor failure falls back locally and is never called for a blocked plan', async () => {
  let calls = 0;
  const env = {
    RAIBITSERVER_AI_AGENT_URL: 'https://agent.example.test/plan',
    RAIBITSERVER_AI_AGENT_TOKEN: 'agent-token',
    RAIBITSERVER_AI_AGENT_MODEL: 'safe-planner-v1',
  };
  const fallback = await createDeploymentAgentPlan({ project: { id: 'project-1' }, services: [safeService()] }, {
    env,
    fetch: async () => {
      calls += 1;
      throw new Error('offline');
    },
  });
  assert.equal(fallback.generatedBy, 'deterministic');
  assert.deepEqual(fallback.deploymentOrder, ['svc-web']);

  const blocked = await createDeploymentAgentPlan({
    project: { id: 'project-1' },
    services: [safeService({ image: 'ghcr.io/example/web:latest' })],
  }, {
    env,
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ordering: ['svc-web'] }));
    },
  });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.deploymentOrder, []);
  assert.equal(calls, 1);
});

test('oversized external advisor responses are abandoned and fall back deterministically', async () => {
  const plan = await createDeploymentAgentPlan({ project: { id: 'project-1' }, services: [safeService()] }, {
    env: {
      RAIBITSERVER_AI_AGENT_URL: 'https://agent.example.test/plan',
      RAIBITSERVER_AI_AGENT_TOKEN: 'agent-token',
      RAIBITSERVER_AI_AGENT_MODEL: 'safe-planner-v1',
    },
    fetch: async () => new Response(JSON.stringify({ ordering: ['svc-web'], summary: 'x'.repeat(40_000) })),
  });

  assert.equal(plan.generatedBy, 'deterministic');
  assert.deepEqual(plan.deploymentOrder, ['svc-web']);
});

test('stored and external secret references are not mistaken for plaintext secrets', () => {
  const assessment = assessDeploymentService(safeService({
    environment: {
      API_TOKEN: 'secret:sec_123',
      DATABASE_URL: 'k8s:database-connection#DATABASE_URL',
      PRIVATE_KEY: 'external-secret://vault/team/private-key',
      ACCESS_TOKEN: { valueFrom: { secretKeyRef: { name: 'runtime-env', key: 'ACCESS_TOKEN' } } },
    },
  }));

  assert.equal(assessment.eligible, true);
  assert.equal(assessment.findings.some((finding) => finding.code === 'PLAINTEXT_SECRET_ENV'), false);
});

test('unrecognized object values cannot disguise a plaintext secret', () => {
  const assessment = assessDeploymentService(safeService({
    environment: {
      API_TOKEN: { value: 'plaintext-secret' },
    },
  }));
  assert.equal(assessment.eligible, false);
  assert.ok(assessment.findings.some((finding) => finding.code === 'PLAINTEXT_SECRET_ENV'));
});

test('Nest deployment-agent routes separate side-effect-free planning from permission-gated apply', async () => {
  const [controller, service, appModule] = await Promise.all([
    readFile(new URL('../apps/api/src/modules/deployment-agent/deployment-agent.controller.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/api/src/modules/deployment-agent/deployment-agent.service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/api/src/app.module.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(controller, /@Post\('plan'\)[\s\S]*deploymentAgent\.plan/);
  assert.match(controller, /@RequirePermission\('deploy:run'\)[\s\S]*@Post\('apply'\)/);
  assert.match(service, /projectOverview\(projectId, subject\)/);
  assert.match(service, /createDeployment\(projectId, serviceId, deploymentInput\(input\), subject\)/);
  assert.match(service, /Re-read and deterministically reassess immediately before mutation/);
  assert.match(appModule, /DeploymentAgentModule/);
});
