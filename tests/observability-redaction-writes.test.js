import test from 'node:test';
import assert from 'node:assert/strict';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { projectObservationPayload } from '../packages/core/src/observability-projection.ts';

for (const kind of ['runtime', 'build']) {
  test('masks ' + kind + ' quoted bodies before append and default projection', () => {
    // Given one immutable source and a secret split into three writes.
    const plane = new RAIBITSERVERControlPlane();
    const source = { serviceId: 'service-1', deploymentId: 'deployment-1', podUid: 'pod-1', containerName: 'app', step: 'build' };
    const append = line => kind === 'runtime' ? plane.store.appendRuntimeLog({ ...source, line }) : plane.store.appendBuildLog({ ...source, line });
    // When the normal writer ingests consecutive records.
    const rows = ['POSTGRES_PASSWORD="begin', 'AuditSyntheticValue_97531', 'end" ready=true'].map(append);
    // Then neither stored rows nor a default read projection contain source secret bytes.
    assert.deepEqual(rows.map(row => row.line), ['POSTGRES_PASSWORD="****"', '****', '****" ready=true']);
    assert.equal(JSON.stringify(projectObservationPayload({ logs: rows })).includes('AuditSyntheticValue_97531'), false);
  });
}
