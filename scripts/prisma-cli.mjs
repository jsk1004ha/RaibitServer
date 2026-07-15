import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const command = process.argv[2];
if (!new Set(['generate', 'validate']).has(command)) {
  console.error('Usage: node scripts/prisma-cli.mjs <generate|validate>');
  process.exit(2);
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma/build/index.js', { paths: [projectRoot] });
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://raibitserver:raibitserver@localhost:5432/raibitserver',
};
const result = spawnSync(process.execPath, [prismaCli, command, '--schema', 'prisma/schema.prisma'], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
