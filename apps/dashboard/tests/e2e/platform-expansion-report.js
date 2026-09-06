import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';

const required = Object.freeze({
  roles: Object.freeze(['anonymous', 'pending', 'OWNER', 'ADMIN', 'MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER', 'GLOBAL_ADMIN']),
  states: Object.freeze(['empty', 'loading', 'pending', 'success', 'retryable', 'terminal', 'permission', 'conflict', 'degraded']),
  viewports: Object.freeze([320, 375, 390, 768, 1024, 1280]),
  themes: Object.freeze(['light', 'dark', 'system']),
  accessibility: Object.freeze(['keyboard', 'screen-reader-announcement', 'axe', 'reduced-motion', 'zoom-200', 'long-korean', 'long-id']),
});

function missing(expected, actual) {
  return expected.filter((value) => !actual.has(value));
}

export function validatePlatformExpansionMatrix(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('platform_expansion_rows_required');
  const ids = rows.map((row) => row.id);
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) throw new TypeError('platform_expansion_row_ids_unique');
  const dimensions = {
    roles: new Set(rows.map((row) => row.role)),
    states: new Set(rows.map((row) => row.state)),
    viewports: new Set(rows.map((row) => row.viewport.width)),
    themes: new Set(rows.map((row) => row.theme)),
    accessibility: new Set(rows.flatMap((row) => row.accessibility)),
  };
  for (const [name, expected] of Object.entries(required)) {
    const absent = missing(expected, dimensions[name]);
    if (absent.length > 0) throw new TypeError(`platform_expansion_${name}_missing:${absent.join(',')}`);
  }
  for (const row of rows) {
    if (!Array.isArray(row.sourceRefs) || row.sourceRefs.length === 0 || row.sourceRefs.some((ref) => !ref.startsWith('apps/dashboard/tests/e2e/') && !ref.startsWith('apps/dashboard/lib/'))) throw new TypeError(`platform_expansion_source_refs_invalid:${row.id}`);
    if (typeof row.action !== 'string' || row.action.length === 0 || typeof row.observedOutcome !== 'string' || row.observedOutcome.length === 0) throw new TypeError(`platform_expansion_outcome_invalid:${row.id}`);
    if (row.execution === 'fixture-driver' && (row.driver === null || row.actor === null)) throw new TypeError(`platform_expansion_driver_missing:${row.id}`);
  }
  return Object.freeze({
    expectedScenarioCount: rows.filter((row) => row.execution === 'fixture-driver').length,
    negativeScenarioCount: rows.filter((row) => row.execution === 'fixture-driver' && ['conflict', 'retryable', 'terminal', 'permission', 'degraded'].includes(row.state)).length,
    delegatedTask41ScenarioCount: rows.filter((row) => row.execution === 'delegated-task41').length,
    delegatedScenarioCount: rows.filter((row) => row.execution === 'delegated-task35').length,
  });
}

export function createOutcomeRecorder(rows, kind) {
  if (kind !== 'positive' && kind !== 'negative') throw new TypeError('platform_expansion_kind_invalid');
  const ids = new Set(rows.map((row) => row.id));
  const outcomes = new Map();
  return Object.freeze({
    record(id, outcome) {
      if (!ids.has(id)) throw new TypeError(`platform_expansion_unplanned_outcome:${id}`);
      if (outcomes.has(id)) throw new TypeError(`platform_expansion_duplicate_outcome:${id}`);
      if (!outcome || !outcome.observation) throw new TypeError(`platform_expansion_observation_required:${id}`);
      if (outcome.status !== 'passed' || !validObservation(outcome.observation, kind) || outcome.a11y?.violations !== 0 || (outcome.representativeVisual && !outcome.screenshot)) throw new TypeError(`platform_expansion_incomplete_outcome:${id}`);
      outcomes.set(id, Object.freeze({ id, ...outcome }));
    },
    finish() {
      const absent = [...ids].filter((id) => !outcomes.has(id));
      if (absent.length > 0) throw new TypeError(`platform_expansion_missing_outcomes:${absent.join(',')}`);
      return Object.freeze({ schema: 'raibit.task49.v1', kind, expectedScenarioIds: Object.freeze([...ids]), outcomes: Object.freeze([...outcomes.values()]), summary: Object.freeze({ expected: ids.size, passed: outcomes.size, failed: 0, skipped: 0, unexpected: 0, flaky: 0 }) });
    },
  });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasSerializableValue(record, key) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return false;
  try { JSON.stringify(record[key]); return record[key] !== undefined; } catch { return false; }
}

function validResultingState(state) {
  return isRecord(state) && ['ui', 'fixture', 'combined'].includes(state.source) && hasSerializableValue(state, 'value');
}

function validSideEffects(sideEffects) {
  return isRecord(sideEffects) && sideEffects.unchanged === true
    && hasSerializableValue(sideEffects, 'before') && hasSerializableValue(sideEffects, 'after')
    && JSON.stringify(sideEffects.before) === JSON.stringify(sideEffects.after);
}

function validObservation(observation, reportKind) {
  if (!isRecord(observation) || !validResultingState(observation.resultingState)) return false;
  if (reportKind === 'negative' && !validSideEffects(observation.sideEffects)) return false;
  if (observation.kind === 'client') {
    return typeof observation.action === 'string' && observation.action.length > 0 && observation.networkRequests === 0
      && !Object.prototype.hasOwnProperty.call(observation, 'status');
  }
  if (observation.kind === 'network-error') {
    return isRecord(observation.request) && /^[A-Z]+$/.test(observation.request.method)
      && validAbsoluteUrl(observation.request.url) && typeof observation.error === 'string' && observation.error.length > 0
      && !Object.prototype.hasOwnProperty.call(observation, 'status');
  }
  return observation.kind === 'http' && isRecord(observation.request) && isRecord(observation.response)
    && /^[A-Z]+$/.test(observation.request.method) && validAbsoluteUrl(observation.request.url)
    && Number.isInteger(observation.response.status) && observation.response.status >= 100 && observation.response.status <= 599
    && validAbsoluteUrl(observation.response.url) && hasSerializableValue(observation.response, 'body');
}

function validAbsoluteUrl(value) {
  if (typeof value !== 'string') return false;
  try { return new URL(value).href === value; } catch { return false; }
}

export async function writePlatformExpansionReport(report, outputPath) {
  if (!isAbsolute(outputPath) || resolve(outputPath).startsWith(resolve(process.cwd())) || parse(outputPath).ext !== '.json') throw new TypeError('platform_expansion_external_evidence_path_required');
  if (report.schema !== 'raibit.task49.v1' || (report.kind !== 'positive' && report.kind !== 'negative')) throw new TypeError('platform_expansion_report_invalid');
  if (report.summary.expected !== report.summary.passed || report.summary.failed !== 0 || report.summary.skipped !== 0 || report.summary.unexpected !== 0 || report.summary.flaky !== 0) throw new TypeError('platform_expansion_count_mismatch');
  const target = report.kind === 'negative' ? resolve(dirname(outputPath), 'task-49-platform-expansion-negative-evidence.json') : resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return target;
}
