import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('operation submit leaf keeps the native form contract while enhancing a single confirmed request', async () => {
  const source = await read('../components/operation-submit.tsx');

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
  assert.match(source, /record\?\.status \?\? record\?\.state/);
  assert.match(source, /sameOriginStreamHref/);
  assert.doesNotMatch(source, /QUEUED|READY/);
  assert.doesNotMatch(source, /randomUUID|Math\.random|Date\.now/);
});

test('operation surfaces compose the enhanced native form for every recovery path', async () => {
  const [operations, services, deployment, resource] = await Promise.all([
    read('../components/project-hub/operations.tsx'),
    read('../components/project-hub/services.tsx'),
    read('../app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx'),
    read('../app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
  ]);
  const all = `${operations}\n${services}\n${deployment}\n${resource}`;

  for (const endpoint of ['/deployments', '/retry', '/redeploy', '/cancel', '/rollback', '/preview-cleanup', '/provision', '/attach']) {
    assert.ok(all.includes(endpoint), `missing recovery endpoint ${endpoint}`);
  }
  assert.match(all, /OperationSubmit/);
  assert.match(all, /name="_returnTo"/);
  assert.match(deployment, /cancellationAllowed/);
  assert.match(deployment, /rollbackAllowed/);
  assert.match(deployment, /randomUUID/);
  assert.match(deployment, /name="requestIdempotencyKey"/);
  assert.match(deployment, /name="snapshotVersion"/);
  assert.match(deployment, /previewCleanupAllowed/);
});

test('retry and redeploy native forms render independent replay keys for one deployment view', async () => {
  // Given: the server-owned deployment detail page with both recovery forms.
  const deployment = await read('../app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx');
  const retryForm = deployment.match(/<OperationSubmit action=\{apiAction\(`\/deployments\/\$\{encodedDeploymentId\}\/retry`[\s\S]*?<\/OperationSubmit>/)?.[0];
  const redeployForm = deployment.match(/<OperationSubmit action=\{apiAction\(`\/services\/\$\{String\(detail\.serviceId \|\| ''\)\}\/redeploy`[\s\S]*?<\/OperationSubmit>/)?.[0];

  // When: the hidden native POST payload fields are inspected.
  const retryKey = retryForm?.match(/name="requestIdempotencyKey" type="hidden" value=\{([^}]+)\}/)?.[1];
  const redeployKey = redeployForm?.match(/name="requestIdempotencyKey" type="hidden" value=\{([^}]+)\}/)?.[1];

  // Then: each action references its own server-rendered key, while both carry snapshotVersion.
  assert.ok(retryKey, 'retry form must submit a requestIdempotencyKey');
  assert.ok(redeployKey, 'redeploy form must submit a requestIdempotencyKey');
  assert.notEqual(retryKey, redeployKey, 'retry and redeploy must not reuse one replay key');
  assert.match(deployment, /const retryRequestIdempotencyKey = snapshotVersion === null \? null : randomUUID\(\);/);
  assert.match(deployment, /const redeployRequestIdempotencyKey = snapshotVersion === null \? null : randomUUID\(\);/);
  assert.match(retryForm ?? '', /name="snapshotVersion" type="hidden"/);
  assert.match(redeployForm ?? '', /name="snapshotVersion" type="hidden"/);
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
