import assert from 'node:assert/strict';
import test from 'node:test';
import { operationResult } from './operation-result.ts';

test('Given a valid plan-only provision response, when parsing preview success, then it does not require an operation ID', () => {
  const payload = {
    resource: { id: 'res_fixture_pg' },
    result: {
      intent: 'preview-plan',
      engine: 'postgresql',
      provider: 'postgresql-direct',
      status: 'PLAN_ONLY',
      dryRun: true,
      plan: { namespace: 'team-alpha' },
    },
  };

  assert.deepEqual(operationResult(payload, 'resource-plan'), {
    kind: 'resource-plan',
    result: payload.result,
  });
});

test('Given a plan-only provision response, when parsing a generic operation, then it still requires an operation ID', () => {
  const payload = {
    result: {
      intent: 'preview-plan',
      engine: 'postgresql',
      provider: 'postgresql-direct',
      status: 'PLAN_ONLY',
      dryRun: true,
      plan: {},
    },
  };

  assert.equal(operationResult(payload), null);
});
