const requiredDimensions = Object.freeze({
  roles: Object.freeze(['anonymous', 'pending', 'OWNER', 'ADMIN', 'MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER', 'GLOBAL_ADMIN']),
  states: Object.freeze(['empty', 'loading', 'pending', 'success', 'retryable', 'terminal', 'permission', 'conflict', 'degraded']),
  viewports: Object.freeze([320, 375, 390, 768, 1024, 1280]),
  themes: Object.freeze(['light', 'dark', 'system']),
  accessibility: Object.freeze(['keyboard', 'screen-reader-announcement', 'axe', 'reduced-motion', 'zoom-200', 'long-korean', 'long-id']),
});

function values(rows, field) {
  return new Set(rows.flatMap((row) => row[field]));
}

function missing(required, observed) {
  return required.filter((value) => !observed.has(value));
}

export function validatePlatformExpansionMatrix(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('platform_expansion_rows_required');
  const ids = rows.map((row) => row.id);
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) throw new TypeError('platform_expansion_row_ids_unique');
  const coverage = {
    roles: values(rows, 'roles'),
    states: values(rows, 'states'),
    viewports: new Set(rows.map((row) => row.viewport.width)),
    themes: new Set(rows.map((row) => row.theme)),
    accessibility: values(rows, 'accessibility'),
  };
  for (const [dimension, required] of Object.entries(requiredDimensions)) {
    const absent = missing(required, coverage[dimension]);
    if (absent.length > 0) throw new TypeError(`platform_expansion_${dimension}_missing:${absent.join(',')}`);
  }
  for (const row of rows) {
    if (!Array.isArray(row.sourceRefs) || row.sourceRefs.length === 0 || row.sourceRefs.some((ref) => !ref.startsWith('apps/dashboard/tests/e2e/'))) throw new TypeError(`platform_expansion_source_refs_invalid:${row.id}`);
    if (typeof row.action !== 'string' || row.action.length === 0 || typeof row.observedOutcome !== 'string' || row.observedOutcome.length === 0) throw new TypeError(`platform_expansion_outcome_invalid:${row.id}`);
  }
  return Object.freeze({
    expectedScenarioCount: rows.filter((row) => row.execution === 'fixture-driver').length,
    contractPendingScenarioCount: rows.filter((row) => row.execution === 'contract-pending-task41').length,
    delegatedScenarioCount: rows.filter((row) => row.execution === 'delegated-task35').length,
    browserExecution: 'NOT_RUN',
  });
}
