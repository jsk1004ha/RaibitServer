import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('operation submit leaf keeps the native form contract while enhancing a single confirmed request', async () => {
  const [source, result] = await Promise.all([read('../components/operation-submit.tsx'), read('../lib/operation-result.ts')]);

  assert.match(source, /^['"]use client['"]/);
  assert.match(source, /<form[\s\S]*action=\{action\}[\s\S]*method="post"/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /running\.current/);
  assert.match(source, /FormData\(event\.currentTarget\)/);
  assert.match(source, /'content-type': 'application\/json'/);
  assert.match(source, /aria-busy/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /operationId/);
  assert.match(source, /streamHref/);
  assert.match(source, /retryable/);
  assert.match(source, /controlPlaneErrorCode/);
  assert.match(source, /status === 401 \|\| status === 403/);
  assert.match(result, /record\?\.status \?\? record\?\.state/);
  assert.match(source, /sameOriginStreamHref/);
  assert.doesNotMatch(source, /QUEUED|READY/);
  assert.doesNotMatch(source, /randomUUID|Math\.random|Date\.now/);
});

test('operation surfaces compose the enhanced native form for every recovery path', async () => {
  const [operations, services, deployment, resource, recovery, history] = await Promise.all([
    read('../components/project-hub/operations.tsx'),
    read('../components/project-hub/services.tsx'),
    read('../app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx'),
    read('../app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
    read('../components/project-hub/deployment-recovery-action.tsx'),
    read('../components/project-hub/deployment-history-model.ts'),
  ]);
  const all = `${operations}\n${services}\n${deployment}\n${resource}\n${recovery}`;

  for (const endpoint of ['/deployments', '/provision', '/attach']) {
    assert.ok(all.includes(endpoint), `missing recovery endpoint ${endpoint}`);
  }
  assert.match(all, /OperationSubmit/);
  assert.match(all, /name="_returnTo"/);
  assert.match(deployment, /DeploymentRecoveryAction[\s\S]*history\.eligibleAction/);
  assert.match(deployment, /randomUUID/);
  assert.match(recovery, /action=\{`\/api\/control\$\{action\.href\}`\}/);
  assert.match(recovery, /name="requestIdempotencyKey"/);
  assert.match(recovery, /name="snapshotVersion"/);
  assert.match(recovery, /action\.type === 'rollback'[\s\S]*name="confirmed"/);
  assert.match(history, /type: 'retry' \| 'redeploy' \| 'cancel' \| 'rollback'/);
  assert.match(history, /entry\.method !== 'POST' \|\| entry\.confirmationRequired !== true/);
});

test('server-selected retry and redeploy actions receive fresh keys while every recovery form preserves its server snapshot', async () => {
  const [deployment, recovery] = await Promise.all([
    read('../app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx'),
    read('../components/project-hub/deployment-recovery-action.tsx'),
  ]);

  assert.match(deployment, /history\.eligibleAction\.type === 'retry' \|\| history\.eligibleAction\.type === 'redeploy' \? randomUUID\(\) : null/);
  assert.match(recovery, /requiresIdempotencyKey && idempotencyKey !== null[\s\S]*name="requestIdempotencyKey"/);
  assert.match(recovery, /requiresIdempotencyKey && action\.snapshotVersion !== null[\s\S]*name="snapshotVersion"/);
});

test('deployment stream preserves hostile text as text and exposes only same-origin operation links', async () => {
  const source = await read('../components/project-hub/deployment-stream.tsx');

  assert.match(source, /^['"]use client['"]/);
  assert.match(source, /EventSource/);
  assert.match(source, /deployment\.snapshot/);
  assert.match(source, /sameOriginStreamHref/);
  assert.match(source, /\[overflow-wrap:anywhere\]/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});
