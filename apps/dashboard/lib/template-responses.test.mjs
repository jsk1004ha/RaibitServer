import assert from 'node:assert/strict';
import test from 'node:test';
import { templateResponseSchema } from './template-responses.ts';

test('all eight template response boundaries are strict and unrelated routes stay unchanged', () => {
  for (const [method, path] of [
    ['GET', '/templates'], ['GET', '/templates/fastapi/versions/v1'], ['GET', '/templates/fastapi/versions/v1/source'],
    ['POST', '/projects/project_1/template-installations/preflight'], ['POST', '/projects/project_1/template-installations'],
    ['GET', '/projects/project_1/template-installations'], ['GET', '/template-installations/template_1'], ['POST', '/template-installations/template_1/retry'],
  ]) assert.ok(templateResponseSchema(path, method), `${method} ${path}`);
  assert.equal(templateResponseSchema('/projects/project_1/services', 'POST'), null);
  const schema = templateResponseSchema('/template-installations/template_1', 'GET');
  const response = {
    installation: { id: 'template_1', projectId: 'project_1', environmentId: 'env_1', environmentKind: 'prod', version: 1, catalogId: 'discord-bot', catalogVersion: 'v1' },
    progress: { status: 'building', completed: 0, total: 1 },
    services: [{ id: 'service_1', logicalSlug: 'bot', type: 'worker', deploymentId: 'deployment_1' }], resources: [],
  };
  assert.equal(schema.safeParse(response).success, true);
  assert.equal(schema.safeParse({ ...response, inputs: { DISCORD_TOKEN: 'must-not-reach-browser' } }).success, false);
  assert.equal(schema.safeParse({ ...response, services: [{ ...response.services[0], secretRefs: ['secret:private-reference'] }] }).success, false);
});
