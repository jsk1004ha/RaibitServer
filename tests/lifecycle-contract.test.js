import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import * as schemas from '../packages/schemas/src/index.ts';
import { canTransitionDeployment, normalizeDeploymentStatus, isDeploymentTerminal } from '../packages/core/src/deployments.ts';
import { createWorkflowJobRecord, claimWorkflowJobRecord, completeWorkflowJobRecord, failWorkflowJobRecord, isWorkflowTerminal } from '../packages/core/src/workflows.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const fixturePath = process.env.RAIBITSERVER_LIFECYCLE_FIXTURE ?? new URL('../test-fixtures/contracts/lifecycle-v1.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

test('Given a completed failed build, when its service is deleted, then persistence preserves the terminal outcome', async () => {
  const rows = [{ id: 'd', serviceId: 's', status: 'BUILD_FAILED' }, { id: 'active', serviceId: 's', status: 'BUILDING' }];
  const service = { id: 's', projectId: 'p', status: 'READY' };
  const prisma = {
    $transaction: callback => callback(prisma),
    service: { findUnique: async () => service, updateMany: async ({ data }) => Object.assign(service, data) },
    deployment: {
      findMany: async () => rows,
      updateMany: async ({ where, data }) => {
        for (const row of rows) if (!where.status.notIn.includes(row.status)) Object.assign(row, data);
      },
    },
    auditLog: { create: async ({ data }) => data },
  };
  await new PrismaControlPlaneRepository(prisma).deleteService('s');
  assert.equal(rows[0].status, 'BUILD_FAILED');
  assert.equal(rows[1].status, 'CANCELLED');
});

test('Given resource health, when parsed separately, then UNHEALTHY is not public rollout health', () => {
  assert.ok(schemas.ResourceHealthStatusSchema);
  assert.equal(schemas.ResourceHealthStatusSchema.parse('UNHEALTHY'), 'UNHEALTHY');
  assert.equal(schemas.HealthStatusSchema.safeParse('UNHEALTHY').success, false);
});

test('Given the shared fixture, when parsed, then every state has an exact schema and valid outgoing edges', () => {
  const contract = schemas.LifecycleContractSchema.parse(fixture);
  for (const machine of Object.values(contract.machines)) {
    for (const state of Object.values(machine.states)) assert.equal(new Set(state.next).size, state.next.length);
  }
  const edges = Object.entries(contract.machines).flatMap(([name, machine]) =>
    Object.entries(machine.states).flatMap(([from, state]) => state.next.map(to => `${name}:${from}->${to}`))).sort();
  console.log('transition-sha256=' + createHash('sha256').update(edges.join('\n') + '\n').digest('hex'));
});

test('Given a deployment fixture, when core evaluates every pair, then its transition and terminal observations agree', () => {
  const states = fixture.machines.deployment.states;
  for (const [from, state] of Object.entries(states)) {
    assert.equal(isDeploymentTerminal(from), state.terminal, from);
    for (const to of Object.keys(states)) assert.equal(canTransitionDeployment(from, to), from === to || state.next.includes(to), `${from}->${to}`);
  }
});

test('Given independent required outcomes, when checking the fixture, then terminal and runtime transitions cannot disappear', () => {
  const required = {
    deployment: [['BUILDING', 'IMAGE_READY'], ['BUILDING', 'BUILD_FAILED'], ['IMAGE_READY', 'DEPLOYING'], ['DEPLOYING', 'READY'], ['READY', 'PREVIEW_CLEANUP_REQUESTED'], ['PREVIEW_CLEANUP_REQUESTED', 'DEPLOYING'], ['ROLLBACK_REQUESTED', 'DEPLOYING'], ['DEPLOYING', 'CLEANED_UP']],
    workflow: [['queued', 'running'], ['running', 'succeeded'], ['running', 'failed'], ['running', 'queued']],
    resource: [['PROVISIONING', 'RECONCILING'], ['RECONCILING', 'READY'], ['DELETE_REQUESTED', 'DELETING'], ['DELETING', 'DELETED']],
    backup: [['VERIFYING', 'READY'], ['DELETING', 'DELETED']],
    restore: [['VERIFYING', 'READY'], ['RUNNING', 'CANCELLED']],
    domain: [['PENDING_VERIFICATION', 'VERIFIED'], ['ROUTING', 'READY'], ['READY', 'PENDING_VERIFICATION']],
    tls: [['ISSUING', 'READY']],
    health: [['CHECKING', 'HEALTHY'], ['CHECKING', 'DEGRADED']],
  };
  for (const [name, edges] of Object.entries(required)) {
    for (const [from, to] of edges) assert.ok(fixture.machines[name].states[from]?.next.includes(to), `${name}:${from}->${to}`);
  }
});

test('Given a real workflow record, when claimed and completed or failed, then outputs obey the shared transitions', () => {
  const queued = createWorkflowJobRecord({ targetId: 'lifecycle', createdAt: '2026-01-01T00:00:00Z', runAfter: '2026-01-01T00:00:00Z' });
  const running = claimWorkflowJobRecord(queued, { now: '2026-01-01T00:00:01Z' });
  const completed = completeWorkflowJobRecord(running, {}, { now: '2026-01-01T00:00:02Z' });
  const failed = failWorkflowJobRecord(running, 'fixture failure', { retryable: false, now: '2026-01-01T00:00:02Z' });
  for (const [from, to] of [[queued, running], [running, completed], [running, failed]]) {
    assert.ok(fixture.machines.workflow.states[from.status].next.includes(to.status));
    assert.equal(isWorkflowTerminal(to), fixture.machines.workflow.states[to.status].terminal);
  }
});

test('Given legacy and hostile boundary values, when parsed, then only canonical states cross the boundary', () => {
  assert.equal(schemas.parseDeploymentStatus('cleanup-requested'), 'PREVIEW_CLEANUP_REQUESTED');
  assert.equal(schemas.parseWorkflowStatus(' COMPLETED '), 'succeeded');
  for (const value of ['arbitrary', '__proto__', 'toString']) {
    assert.throws(() => schemas.parseDeploymentStatus(value));
    assert.throws(() => schemas.parseWorkflowStatus(value));
  }
  assert.equal(schemas.DeploymentStatusSchema.safeParse('ready').success, false);
});

test('Given the public DeploymentStatus type, when TypeScript compiles assignments, then arbitrary strings are rejected', () => {
  const virtualPath = path.resolve('lifecycle-contract-probe.ts');
  const options = { strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, resolveJsonModule: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  for (const [value, expected] of [['IMAGE_READY', 0], ['not-a-deployment-status', 1]]) {
    const source = `import type { DeploymentStatus } from './packages/schemas/src/index.ts'; const value: DeploymentStatus = '${value}';`;
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (filename, languageVersion, ...args) => path.resolve(filename) === virtualPath ? ts.createSourceFile(filename, source, languageVersion) : original(filename, languageVersion, ...args);
    const program = ts.createProgram([virtualPath], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, expected, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n' }));
    if (expected) assert.equal(diagnostics[0].code, 2322);
  }
});

test('Given legacy deployment input, when normalized, then existing canonical behavior is preserved', () => {
  assert.equal(normalizeDeploymentStatus('pending'), 'queued');
  assert.equal(normalizeDeploymentStatus('build'), 'BUILDING');
  assert.equal(normalizeDeploymentStatus('deploy-ready'), 'IMAGE_READY');
  assert.equal(normalizeDeploymentStatus('success'), 'READY');
  assert.equal(canTransitionDeployment('BUILDING', 'IMAGE_READY'), true);
  assert.equal(canTransitionDeployment('BUILDING', 'BUILD_FAILED'), true);
  assert.equal(canTransitionDeployment('READY', 'BUILDING'), false);
  assert.equal(isDeploymentTerminal('READY'), true);
});

test('Given the public schema package, when reading lifecycle exports, then all closed contracts are available', () => {
  for (const name of ['DeploymentStatusSchema', 'WorkflowStatusSchema', 'ResourceStatusSchema', 'BackupStatusSchema', 'RestoreStatusSchema', 'DomainStatusSchema', 'TlsStatusSchema', 'HealthStatusSchema']) {
    assert.ok(schemas[name], name);
  }
});

test('Given legacy rollback and cleanup, when transitioned, then Go runtime states are represented', () => {
  assert.equal(canTransitionDeployment('ROLLBACK_REQUESTED', 'DEPLOYING'), true);
  assert.equal(canTransitionDeployment('PREVIEW_CLEANUP_REQUESTED', 'DEPLOYING'), true);
  assert.equal(canTransitionDeployment('DEPLOYING', 'CLEANED_UP'), true);
  assert.equal(isDeploymentTerminal('CLEANED_UP'), true);
});
