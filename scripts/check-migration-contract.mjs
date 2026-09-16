import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const digest = (content) => createHash('sha256').update(content.replaceAll('\r\n', '\n')).digest('hex');
export const migrationSetDigest = (entries) => digest(`${entries.map((entry) => `${entry.id}:${entry.sha256}`).join('\n')}\n`);
const reviewedTriggerMigrations = new Set(['000014_resource_recovery', '000015_preview_lineage', '202609130001_operational_persistence', '202609130002_runtime_environment_protocol']);
const reviewedCompatibilityContracts = new Map([
  ['000017_github_integration_lifecycle', 'c470f59cd7902fc70306d75d31a230b4c6159d9030147329c66b329324157198'],
  ['000017_organization_invites', '065527eaa28391ce49cdf3e0a3467e1c4220f61783385f9476f337d0252f630b'],
  ['000018_github_catalog_generation', 'fc72c579048e9f186ca44992289ad66eae44823a1cda38fcb8f0c253a75b1978'],
  ['000018_membership_versions', '166ec8f77c0720aa2adc48dae2680be4e4c0b6254b16ff9de716b5945ab1e9fe'],
  ['202609060001_custom_domain_lifecycle', '44a36e6face136eac2dad193ab2282f5c41f423435de61127c4aba08fb36e6bb'],
]);
const reviewedFunctionReplacementContracts = new Map([
  ['202609130003_operational_state_dispatch', {
    sqlDigest: '72001f2d48c4d4890057a258408facd8fb14cc058c61e9a70e2b02dd7b56681c',
    functions: ['raibit_operational_state_guard'],
  }],
]);
// Anchor manually reviewed schema DDL that precedes the closed trigger declarations.
const reviewedTriggerContracts = new Map([
  ['000014_resource_recovery', {
    sqlDigest: 'b2e611fbbe6d6d66e9c04b6c4cbf3000a4af1c83ec7d4be1f986d3c2de0a38ac',
    prefixDigest: 'dc3efe6158e92f3ffe4e23b667f38824280a9832e85cc0f6ea9b1f117e8ad907',
    functions: ['recovery_attempt_guard', 'recovery_backup_guard', 'recovery_pin_guard', 'recovery_restore_guard'],
    triggers: ['"ResourceBackup_guard"|INSERTORUPDATEORDELETE|"ResourceBackup"|recovery_backup_guard', '"ResourceRecoveryAttempt_guard"|INSERTORUPDATEORDELETE|"ResourceRecoveryAttempt"|recovery_attempt_guard', '"ResourceRecoveryPin_guard"|INSERTORUPDATE|"ResourceRecoveryPin"|recovery_pin_guard', '"ResourceRestore_guard"|INSERTORUPDATEORDELETE|"ResourceRestore"|recovery_restore_guard'],
  }],
  ['000015_preview_lineage', {
    sqlDigest: '1cc33de5d47030b3643e7bc26fb4870c32d28d468e6962a1f43fdd2745ec756d',
    prefixDigest: '3b85ca152eaf0f0d33c024e4767b32b4645219df0a1a4404f1a9a4df9dbd8a7b',
    functions: ['raibit_preview_attempt_guard', 'raibit_preview_lineage_guard'],
    triggers: ['"Deployment_preview_guard"|UPDATE|"Deployment"|raibit_preview_attempt_guard', '"PreviewLineage_guard"|INSERTORUPDATE|"PreviewLineage"|raibit_preview_lineage_guard'],
  }],
  ['202609130001_operational_persistence', {
    sqlDigest: '3f0aba94669d906664b6b734d47d02d946a0960ba69e5501945bf6a5b17df817',
    prefixDigest: '82c7fcd4b63fb16128bbf28c43546edc6c9106a78665e5945684315dd89e0132',
    insertTargets: {
      raibit_service_binding_required: ['Environment', 'EnvironmentService'],
      raibit_resource_binding_required: ['Environment', 'EnvironmentResource'],
    },
    functions: ['raibit_operational_protocol_guard', 'raibit_operational_state_guard', 'raibit_resource_binding_required', 'raibit_service_binding_required'],
    triggers: [
      '"BackupPolicyRun_protocol_guard"|INSERTORUPDATEORDELETE|"BackupPolicyRun"|raibit_operational_protocol_guard',
      '"BackupPolicyRun_state_guard"|INSERTORUPDATEORDELETE|"BackupPolicyRun"|raibit_operational_state_guard',
      '"BackupPolicy_protocol_guard"|INSERTORUPDATEORDELETE|"BackupPolicy"|raibit_operational_protocol_guard',
      '"BackupPolicy_state_guard"|INSERTORUPDATEORDELETE|"BackupPolicy"|raibit_operational_state_guard',
      '"EnvironmentResource_binding_required"|UPDATEORDELETE|"EnvironmentResource"|raibit_resource_binding_required',
      '"EnvironmentResource_protocol_guard"|INSERTORUPDATEORDELETE|"EnvironmentResource"|raibit_operational_protocol_guard',
      '"EnvironmentService_binding_required"|UPDATEORDELETE|"EnvironmentService"|raibit_service_binding_required',
      '"EnvironmentService_protocol_guard"|INSERTORUPDATEORDELETE|"EnvironmentService"|raibit_operational_protocol_guard',
      '"Environment_protocol_guard"|INSERTORUPDATEORDELETE|"Environment"|raibit_operational_protocol_guard',
      '"NotificationDeliveryAttempt_protocol_guard"|INSERTORUPDATEORDELETE|"NotificationDeliveryAttempt"|raibit_operational_protocol_guard',
      '"NotificationDeliveryAttempt_state_guard"|INSERTORUPDATEORDELETE|"NotificationDeliveryAttempt"|raibit_operational_state_guard',
      '"NotificationDestination_protocol_guard"|INSERTORUPDATEORDELETE|"NotificationDestination"|raibit_operational_protocol_guard',
      '"NotificationDestination_state_guard"|INSERTORUPDATEORDELETE|"NotificationDestination"|raibit_operational_state_guard',
      '"NotificationIntent_protocol_guard"|INSERTORUPDATEORDELETE|"NotificationIntent"|raibit_operational_protocol_guard',
      '"NotificationIntent_state_guard"|INSERTORUPDATEORDELETE|"NotificationIntent"|raibit_operational_state_guard',
      '"NotificationSubscription_protocol_guard"|INSERTORUPDATEORDELETE|"NotificationSubscription"|raibit_operational_protocol_guard',
      '"NotificationSubscription_state_guard"|INSERTORUPDATEORDELETE|"NotificationSubscription"|raibit_operational_state_guard',
      '"ObjectMultipartPart_protocol_guard"|INSERTORUPDATEORDELETE|"ObjectMultipartPart"|raibit_operational_protocol_guard',
      '"ObjectMultipartPart_state_guard"|INSERTORUPDATEORDELETE|"ObjectMultipartPart"|raibit_operational_state_guard',
      '"ObjectMultipartUpload_protocol_guard"|INSERTORUPDATEORDELETE|"ObjectMultipartUpload"|raibit_operational_protocol_guard',
      '"ObjectMultipartUpload_state_guard"|INSERTORUPDATEORDELETE|"ObjectMultipartUpload"|raibit_operational_state_guard',
      '"ObjectStorageObject_protocol_guard"|INSERTORUPDATEORDELETE|"ObjectStorageObject"|raibit_operational_protocol_guard',
      '"ObjectStorageObject_state_guard"|INSERTORUPDATEORDELETE|"ObjectStorageObject"|raibit_operational_state_guard',
      '"ObjectUploadReservation_protocol_guard"|INSERTORUPDATEORDELETE|"ObjectUploadReservation"|raibit_operational_protocol_guard',
      '"ObjectUploadReservation_state_guard"|INSERTORUPDATEORDELETE|"ObjectUploadReservation"|raibit_operational_state_guard',
      '"PromotionOperation_protocol_guard"|INSERTORUPDATEORDELETE|"PromotionOperation"|raibit_operational_protocol_guard',
      '"PromotionPreview_protocol_guard"|INSERTORUPDATEORDELETE|"PromotionPreview"|raibit_operational_protocol_guard',
      '"PromotionPreview_state_guard"|INSERTORUPDATEORDELETE|"PromotionPreview"|raibit_operational_state_guard',
      '"ResourceBackup_operational_protocol_guard"|INSERTORUPDATEORDELETE|"ResourceBackup"|raibit_operational_protocol_guard',
      '"ResourceBackup_operational_state_guard"|INSERTORUPDATEORDELETE|"ResourceBackup"|raibit_operational_state_guard',
      '"Resource_binding_required"|INSERTORUPDATE|"Resource"|raibit_resource_binding_required',
      '"Resource_environment_protocol_guard"|INSERTORUPDATEORDELETE|"Resource"|raibit_operational_protocol_guard',
      '"Service_binding_required"|INSERTORUPDATE|"Service"|raibit_service_binding_required',
      '"Service_environment_protocol_guard"|INSERTORUPDATEORDELETE|"Service"|raibit_operational_protocol_guard',
      '"TemplateInstallationVersion_protocol_guard"|INSERTORUPDATEORDELETE|"TemplateInstallationVersion"|raibit_operational_protocol_guard',
      '"TemplateInstallationVersion_state_guard"|INSERTORUPDATEORDELETE|"TemplateInstallationVersion"|raibit_operational_state_guard',
      '"TemplateInstallation_protocol_guard"|INSERTORUPDATEORDELETE|"TemplateInstallation"|raibit_operational_protocol_guard',
      '"WorkflowJob_operational_protocol_guard"|INSERTORUPDATEORDELETE|"WorkflowJob"|raibit_operational_protocol_guard',
    ],
  }],
  ['202609130002_runtime_environment_protocol', {
    sqlDigest: 'eebc11a218f527416688b643f4ab630a9adb90a07fb4362e3467873f8967e191',
    prefixDigest: '230ca3c6a948af259c2567501122ad8168933973fddfae089d815f6cde54954a',
    functions: [
      'raibit_deployment_runtime_environment_guard',
      'raibit_preview_lineage_runtime_environment_guard',
      'raibit_workflow_job_runtime_environment_guard',
    ],
    triggers: [
      '"Deployment_runtime_environment_guard"|INSERTORUPDATEORDELETE|"Deployment"|raibit_deployment_runtime_environment_guard',
      '"PreviewLineage_runtime_environment_guard"|INSERTORUPDATEORDELETE|"PreviewLineage"|raibit_preview_lineage_runtime_environment_guard',
      '"WorkflowJob_runtime_environment_guard"|INSERTORUPDATEORDELETE|"WorkflowJob"|raibit_workflow_job_runtime_environment_guard',
    ],
  }],
]);

function executableSql(sql) {
  let code = '';
  for (let index = 0; index < sql.length;) {
    const start = index;
    const quote = sql[index];
    const dollar = quote === '$' ? /^(?:\$\$|\$[A-Za-z_][A-Za-z_0-9]*\$)/.exec(sql.slice(index))?.[0] : undefined;
    if (quote === "'" || quote === '"') {
      const escaped = quote === "'" && index > 0 && /[eE]/.test(sql[index - 1]) && (index === 1 || !/[A-Za-z_0-9$]/.test(sql[index - 2]));
      let closed = false;
      for (index++; index < sql.length; index++) {
        if (escaped && sql[index] === '\\') { index++; continue; }
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

function assertSqlTrivia(sql) {
  for (let index = 0; index < sql.length;) {
    if (/\s/.test(sql[index])) { index++; continue; }
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1;
      for (index += 2; index < sql.length && depth > 0;) {
        if (sql.startsWith('/*', index)) { depth++; index += 2; }
        else if (sql.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      assert.equal(depth, 0, 'unterminated SQL block comment');
      continue;
    }
    assert.fail('reviewed trigger migration contains SQL outside approved declarations');
  }
}

export function checkReviewedTriggerSql(sql, migrationId) {
  const functions = new Set();
  let functionDeclarationCount = 0;
  const firstFunction = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i.exec(sql);
  assert.ok(firstFunction, 'reviewed trigger migration must define a trigger function');
  const prefix = sql.slice(0, firstFunction.index);
  const contract = migrationId ? reviewedTriggerContracts.get(migrationId) : [...reviewedTriggerContracts.values()].find(entry => entry.prefixDigest === digest(prefix));
  if (migrationId) assert.ok(contract, 'reviewed trigger migration contract is missing');
  if (contract) {
    assert.equal(digest(prefix), contract.prefixDigest, 'reviewed pre-trigger DDL changed');
    assert.equal(digest(sql), contract.sqlDigest, 'reviewed trigger migration differs from canonical SQL');
  }
  else assertSqlTrivia(prefix);
  const functionPattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(\)\s+RETURNS\s+trigger\s+LANGUAGE\s+plpgsql\s+AS\s+(\$\$|\$[A-Za-z_][A-Za-z_0-9]*\$)([\s\S]*?)\2\s*;/gi;
  let remaining = sql.slice(firstFunction.index).replace(functionPattern, (_statement, name, _delimiter, body) => {
    const code = executableSql(body);
    assert.match(code, /^\s*BEGIN[\s\S]*END\s*$/i, 'trigger function must be a bounded BEGIN/END body');
    const insertTargets = contract?.insertTargets?.[name.toLowerCase()];
    if (insertTargets) {
      // Only these canonical, digest-closed legacy bridges may insert rows.
      assert.deepEqual([...body.matchAll(/INSERT INTO "([^"]+)"/g)].map(match => match[1]), insertTargets, 'legacy bridge insert targets changed');
      assert.doesNotMatch(code, /\b(?:WITH|UPDATE|DELETE)\b/i, 'legacy bridge may only insert');
    } else assert.doesNotMatch(code, /\b(?:WITH|INSERT|UPDATE|DELETE)\b/i, 'trigger function may not mutate rows');
    assert.doesNotMatch(code, /\b(EXECUTE|PERFORM|CALL|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i, 'trigger function may not execute dynamic or schema-changing SQL');
    functions.add(name.toLowerCase());
    functionDeclarationCount++;
    return '';
  });
  assert.ok(functions.size > 0, 'reviewed trigger migration must define a trigger function');
  assert.equal(functionDeclarationCount, functions.size, 'reviewed trigger function declarations must be unique');
  if (contract) assert.deepEqual([...functions].sort(), contract.functions, 'reviewed trigger function set changed');
  const referencedFunctions = new Set();
  const triggerSignatures = new Set();
  let triggerDeclarationCount = 0;
  const identifier = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z_0-9]*)';
  const triggerPattern = new RegExp(`CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+(${identifier})\\s+(?:BEFORE|AFTER)\\s+((?:INSERT|UPDATE|DELETE)(?:\\s+OR\\s+(?:INSERT|UPDATE|DELETE))*)\\s+ON\\s+(${identifier})\\s+(?:DEFERRABLE\\s+INITIALLY\\s+DEFERRED\\s+)?FOR\\s+EACH\\s+ROW\\s+EXECUTE\\s+FUNCTION\\s+([A-Za-z_][A-Za-z_0-9]*)\\s*\\(\\)\\s*;`, 'gi');
  remaining = remaining.replace(triggerPattern, (_statement, triggerName, events, tableName, name) => {
    const identity = name.toLowerCase();
    assert.ok(functions.has(identity), 'trigger must reference a function defined in the same migration');
    referencedFunctions.add(identity);
    triggerSignatures.add(`${triggerName}|${events.replaceAll(/\s+/g, '').toUpperCase()}|${tableName}|${identity}`);
    triggerDeclarationCount++;
    return '';
  });
  assert.deepEqual(referencedFunctions, functions, 'every reviewed trigger function must have a matching trigger');
  assert.equal(triggerDeclarationCount, triggerSignatures.size, 'reviewed trigger declarations must be unique');
  if (contract) assert.deepEqual([...triggerSignatures].sort(), contract.triggers, 'reviewed trigger declaration set changed');
  assertSqlTrivia(remaining);
}

function checkReviewedFunctionReplacementSql(sql, migrationId) {
  const contract = reviewedFunctionReplacementContracts.get(migrationId);
  assert.ok(contract, 'reviewed function replacement contract is missing');
  assert.equal(digest(sql), contract.sqlDigest, `reviewed function replacement changed: ${migrationId}`);
  const functions = new Set();
  let declarationCount = 0;
  const functionPattern = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(\)\s+RETURNS\s+trigger\s+LANGUAGE\s+plpgsql\s+AS\s+(\$\$|\$[A-Za-z_][A-Za-z_0-9]*\$)([\s\S]*?)\2\s*;/gi;
  const remaining = sql.replace(functionPattern, (_statement, name, _delimiter, body) => {
    const code = executableSql(body);
    assert.match(code, /^\s*BEGIN[\s\S]*END\s*$/i, 'replacement trigger function must be a bounded BEGIN/END body');
    assert.doesNotMatch(code, /\b(?:WITH|INSERT|UPDATE|DELETE)\b/i, 'replacement trigger function may not mutate rows');
    assert.doesNotMatch(code, /\b(?:EXECUTE|PERFORM|CALL|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i, 'replacement trigger function may not execute dynamic or schema-changing SQL');
    functions.add(name.toLowerCase());
    declarationCount++;
    return '';
  });
  assert.equal(declarationCount, functions.size, 'reviewed replacement function declarations must be unique');
  assert.deepEqual([...functions].sort(), contract.functions, 'reviewed replacement function set changed');
  assertSqlTrivia(remaining);
}

function checkReviewedCompatibilitySql(sql, migrationId) {
  assert.equal(digest(sql), reviewedCompatibilityContracts.get(migrationId), `reviewed migration changed: ${migrationId}`);
  assert.doesNotMatch(sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' '), /(?:^|;)\s*(?:DELETE|INSERT|DO|GRANT|REVOKE)\b/i, 'reviewed migration became destructive');
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
    assert.match(entry.id, /^(?:\d{6}|\d{12})_[a-z0-9_]+$/, 'invalid migration ID');
    assert.match(entry.sha256 ?? '', /^[a-f0-9]{64}$/, 'missing migration digest');
    const directory = resolve(root, 'prisma/migrations', entry.id);
    assert.deepEqual(readdirSync(directory).sort(), ['migration.sql'], 'down/extra migration files are forbidden');
    const sql = readFileSync(resolve(directory, 'migration.sql'), 'utf8');
    assert.equal(digest(sql), entry.sha256, `migration digest mismatch: ${entry.id}`);
    let destructiveCheck = sql;
    if (entry.id === '202609130001_operational_persistence') {
      // One atomic replacement of the v1 expiry CHECK, never a general DROP exemption.
      assert.equal(digest(sql), reviewedTriggerContracts.get(entry.id).sqlDigest, 'reviewed trigger migration differs from canonical SQL');
      destructiveCheck = sql.replace('DROP CONSTRAINT "ResourceBackup_ready_complete",', '');
    }
    assert.doesNotMatch(destructiveCheck.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' '), /\b(DROP|TRUNCATE|RENAME)\b/i, 'destructive SQL is forbidden');
    if (entry.id > manifest.historicalThrough) {
      if (reviewedTriggerMigrations.has(entry.id)) checkReviewedTriggerSql(sql, entry.id);
      else if (reviewedFunctionReplacementContracts.has(entry.id)) checkReviewedFunctionReplacementSql(sql, entry.id);
      else if (reviewedCompatibilityContracts.has(entry.id)) checkReviewedCompatibilitySql(sql, entry.id);
      else checkAdditiveSql(sql);
    }
  }
  const baseline = JSON.parse(readFileSync(resolve(root, 'test-fixtures/contracts/crd-schema-v1.json'), 'utf8'));
  assert.deepEqual(baseline.map((entry) => entry.path), ['infra/k8s/appservice-crd.yaml', 'infra/operators/manageddatabase-crd.yaml'], 'CRD baselines missing');
  for (const entry of baseline) checkCrd(entry.document, parse(readFileSync(resolve(root, entry.path), 'utf8')));
  return {
    migrations: ids.length,
    migrationDigest: migrationSetDigest(manifest.migrations),
    applicationCompatibilityFloor: manifest.applicationCompatibilityFloor,
    rollbackMode: manifest.rollbackMode,
    crds: baseline.length,
  };
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
