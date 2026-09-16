import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
const operation = args[args.indexOf('--operation') + 1];
const mutation = args[args.indexOf('--mutation') + 1];
if (!operation || !['wrong-method', 'delete-route', 'invalid-fixture'].includes(mutation)) {
  console.error('Usage: --operation <operationId> --mutation wrong-method|delete-route|invalid-fixture');
  process.exit(2);
}
const result = spawnSync(process.execPath, ['--test', 'tests/api-semantic-parity.test.js'], {
  cwd: fileURLToPath(new URL('../../', import.meta.url)), windowsHide: true, encoding: 'utf8',
  env: { ...process.env, RAIBIT_API_PARITY_MUTATION: JSON.stringify({ operation, mutation }) },
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
console.log(`mutation=${mutation} operation=${operation} exit=${result.status}; mutations were process-local, no product file writes`);
process.exitCode = result.status === 1 && `${result.stdout}${result.stderr}`.includes(operation) ? 1 : 2;
