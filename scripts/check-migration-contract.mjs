import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const digest = (content) => createHash('sha256').update(content.replaceAll('\r\n', '\n')).digest('hex');
const reviewedTriggerMigrations = new Set(['000014_resource_recovery', '000015_preview_lineage']);

function executableSql(sql) {
  let code = '';
  for (let index = 0; index < sql.length;) {
    const start = index;
    const quote = sql[index];
    const dollar = quote === '$' ? /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index))?.[0] : undefined;
    if (quote === "'" || quote === '"') {
      let closed = false;
      for (index++; index < sql.length; index++) {
        if (sql[index] !== quote) continue;
        if (sql[index + 1] === quote) index++;
        else { index++; closed = true; break; }
      }
      assert.ok(closed, 'unterminated SQL quote');
    } else if (dollar) {
      const end = sql.indexOf(dollar, index + dollar.length);
      assert.notEqual(end, -1, 'unterminated SQL dollar quote');
      index = end + dollar.length;
    } else if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2);
      index = end < 0 ? sql.length : end;
    } else if (sql.startsWith('/*', index)) {
      let depth = 1;
      for (index += 2; index < sql.length && depth > 0;) {
        if (sql.startsWith('/*', index)) { depth++; index += 2; }
        else if (sql.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      assert.equal(depth, 0, 'unterminated SQL block comment');
    } else {
      code += quote;
      index++;
      continue;
    }
    code += sql.slice(start, index).replace(/[^\r\n]/g, ' ');
  }
  return code;
}

export function checkReviewedTriggerSql(sql) {
  const functions = new Set();
  const functionPattern = /CREATE\s+FUNCTION\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(\)\s+RETURNS\s+trigger\s+LANGUAGE\s+plpgsql\s+AS\s+\$\$([\s\S]*?)\$\$\s*;/gi;
  let remaining = sql.replace(functionPattern, (_statement, name, body) => {
    assert.match(body, /^\s*BEGIN[\s\S]*END\s*$/i, 'trigger function must be a bounded BEGIN/END body');
    const code = executableSql(body);
    assert.doesNotMatch(code, /\b(?:WITH|INSERT|UPDATE|DELETE)\b/i, 'trigger function may not mutate rows');
    assert.doesNotMatch(code, /\b(EXECUTE|PERFORM|CALL|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i, 'trigger function may not execute dynamic or schema-changing SQL');
    functions.add(name.toLowerCase());
    return '';
  });
  assert.ok(functions.size > 0, 'reviewed trigger migration must define a trigger function');
  const referencedFunctions = new Set();
  const triggerPattern = /CREATE\s+TRIGGER\s+(?:"[A-Za-z_][A-Za-z_0-9]*"|[A-Za-z_][A-Za-z_0-9]*)\s+BEFORE\s+(?:INSERT|UPDATE|DELETE)(?:\s+OR\s+(?:INSERT|UPDATE|DELETE))*\s+ON\s+(?:"[A-Za-z_][A-Za-z_0-9]*"|[A-Za-z_][A-Za-z_0-9]*)\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+FUNCTION\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(\)\s*;/gi;
  remaining = remaining.replace(triggerPattern, (_statement, name) => {
    const identity = name.toLowerCase();
    assert.ok(functions.has(identity), 'trigger must reference a function defined in the same migration');
    referencedFunctions.add(identity);
    return '';
  });
  assert.deepEqual(referencedFunctions, functions, 'every reviewed trigger function must have a matching trigger');
  assert.doesNotMatch(remaining, /\b(CREATE\s+FUNCTION|CREATE\s+TRIGGER|DROP|TRUNCATE|RENAME|DO|GRANT|REVOKE|SECURITY\s+DEFINER)\b/i, 'unreviewed trigger or destructive SQL');
}

// This is deliberately a narrow additive DDL gate, not a general SQL parser.
// Unsupported statements require compatibility review, never an implicit pass.
export function checkAdditiveSql(sql) {
  const code = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''");
  assert.doesNotMatch(code, /\b(DROP|TRUNCATE|RENAME|DELETE|UPDATE|INSERT|DO|GRANT|REVOKE)\b/i, 'destructive or unsupported SQL');
  const identifier = '(?:"[A-Za-z_][A-Za-z_0-9]*"|[A-Za-z_][A-Za-z_0-9]*)';
  const column = `${identifier}\\s+(?:TEXT|INTEGER|BIGINT|BOOLEAN|JSONB|TIMESTAMP(?:\\(\\d+\\))?|DOUBLE PRECISION)(?:\\s+DEFAULT\\s+(?:''|NULL|true|false|[0-9]+|CURRENT_TIMESTAMP))?`;
  const add = new RegExp(`^ALTER\\s+TABLE\\s+(${identifier})\\s+ADD\\s+COLUMN\\s+${column}(?:\\s*,\\s*ADD\\s+COLUMN\\s+${column})*$`, 'i');
  const createTable = new RegExp(`^CREATE\\s+TABLE\\s+(${identifier})\\s*\\([\\s\\S]+\\)$`, 'i');
  const columns = `${identifier}(?:\\s*,\\s*${identifier})*`;
  const predicate = `${identifier}\\s+IS\\s+NOT\\s+NULL`;
  const createIndex = new RegExp(`^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}\\s+ON\\s+(${identifier})\\s*\\(\\s*(${columns})\\s*\\)(?:\\s+WHERE\\s+${predicate}(?:\\s+AND\\s+${predicate})*)?$`, 'i');
  const tableIdentity = (name) => name.startsWith('"') ? name.slice(1, -1) : name.toLowerCase();
  const createdTables = new Set();
  const nullableAdditions = new Map();
  for (const statement of code.split(';').map((part) => part.trim()).filter(Boolean)) {
    const addition = add.exec(statement);
    const table = createTable.exec(statement);
    const index = createIndex.exec(statement);
    assert.ok(addition || table || index, 'migration must use additive nullable columns, tables or supported indexes');
    if (addition) {
      const identity = tableIdentity(addition[1]);
      const nullable = nullableAdditions.get(identity) || new Set();
      for (const match of statement.matchAll(new RegExp(`ADD\\s+COLUMN\\s+(${identifier})\\s+([^,]+)`, 'gi'))) {
        if (!/\bDEFAULT\b/i.test(match[2])) nullable.add(tableIdentity(match[1]));
      }
      nullableAdditions.set(identity, nullable);
    }
    if (table) createdTables.add(tableIdentity(table[1]));
    // A new table has no N-1 writers; an existing table can contain permitted duplicates.
    if (index?.[1]) {
      const identity = tableIdentity(index[2]);
      const includesNewNullable = index[3].split(',').some(name => nullableAdditions.get(identity)?.has(tableIdentity(name.trim())));
      assert.ok(createdTables.has(identity) || includesNewNullable, 'UNIQUE index requires a new table or a new nullable column without a default in this migration');
    }
  }
  assert.ok(code.trim(), 'empty migration');
}

function checkSchema(previous, current) {
  assert.ok(current && typeof current === 'object', 'CRD schema node removed');
  const { properties: oldProperties = {}, required: oldRequired = [], ...oldRules } = previous;
  const { properties: newProperties = {}, required: newRequired = [], ...newRules } = current;
  assert.deepEqual(newRules, oldRules, 'CRD existing field constraint changed');
  assert.ok(newRequired.every((name) => oldRequired.includes(name)), 'CRD added required field');
  for (const [name, schema] of Object.entries(oldProperties)) checkSchema(schema, newProperties[name]);
}

export function checkCrd(previous, current) {
  assert.equal(current.apiVersion, previous.apiVersion, 'CRD API version changed');
  assert.equal(current.kind, previous.kind, 'CRD kind changed');
  assert.equal(current.metadata.name, previous.metadata.name, 'CRD identity changed');
  for (const field of ['group', 'names', 'scope']) assert.deepEqual(current.spec[field], previous.spec[field], `CRD ${field} changed`);
  assert.equal(current.spec.conversion?.strategy ?? 'None', 'None', 'CRD conversion is forbidden');
  assert.equal(current.spec.versions.length, previous.spec.versions.length, 'CRD served/storage versions changed');
  for (const oldVersion of previous.spec.versions) {
    const next = current.spec.versions.find((version) => version.name === oldVersion.name);
    assert.ok(next, 'CRD storage version renamed');
    assert.equal(next.served, oldVersion.served, 'CRD served version changed');
    assert.equal(next.storage, oldVersion.storage, 'CRD storage version changed');
    checkSchema(oldVersion.schema.openAPIV3Schema, next.schema.openAPIV3Schema);
  }
}

export function checkMigrationContract(root = projectRoot) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'prisma/migration-contract.json'), 'utf8'));
  assert.equal(manifest.version, 1, 'unsupported migration contract');
  assert.equal(manifest.digestEncoding, 'sha256-utf8-lf', 'unsupported digest encoding');
  assert.equal(manifest.applicationCompatibilityFloor, '000008_git_source_binding', 'application compatibility floor changed');
  assert.equal(manifest.historicalThrough, '000010_user_bans', 'historical migration boundary changed');
  assert.equal(manifest.rollbackMode, 'forward-fix', 'down migrations are forbidden');
  assert.deepEqual(manifest.deploymentOrder, ['migrate', 'readers', 'writers'], 'migrate before application rollout');
  const ids = readdirSync(resolve(root, 'prisma/migrations'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.ok(ids.includes(manifest.applicationCompatibilityFloor) && ids.includes(manifest.historicalThrough), 'historical migrations missing');
  assert.deepEqual(manifest.migrations.map((entry) => entry.id), ids, 'ordered migration IDs must exactly match disk');
  for (const entry of manifest.migrations) {
    assert.match(entry.id, /^\d{6}_[a-z0-9_]+$/, 'invalid migration ID');
    assert.match(entry.sha256 ?? '', /^[a-f0-9]{64}$/, 'missing migration digest');
    const directory = resolve(root, 'prisma/migrations', entry.id);
    assert.deepEqual(readdirSync(directory).sort(), ['migration.sql'], 'down/extra migration files are forbidden');
    const sql = readFileSync(resolve(directory, 'migration.sql'), 'utf8');
    assert.equal(digest(sql), entry.sha256, `migration digest mismatch: ${entry.id}`);
    assert.doesNotMatch(sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' '), /\b(DROP|TRUNCATE|RENAME)\b/i, 'destructive SQL is forbidden');
    if (entry.id > manifest.historicalThrough) {
      if (reviewedTriggerMigrations.has(entry.id)) checkReviewedTriggerSql(sql);
      else checkAdditiveSql(sql);
    }
  }
  const baseline = JSON.parse(readFileSync(resolve(root, 'test-fixtures/contracts/crd-schema-v1.json'), 'utf8'));
  assert.deepEqual(baseline.map((entry) => entry.path), ['infra/k8s/appservice-crd.yaml', 'infra/operators/manageddatabase-crd.yaml'], 'CRD baselines missing');
  for (const entry of baseline) checkCrd(entry.document, parse(readFileSync(resolve(root, entry.path), 'utf8')));
  return { migrations: ids.length, applicationCompatibilityFloor: manifest.applicationCompatibilityFloor, rollbackMode: manifest.rollbackMode, crds: baseline.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(checkMigrationContract(process.argv[2] && resolve(process.argv[2]))));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
