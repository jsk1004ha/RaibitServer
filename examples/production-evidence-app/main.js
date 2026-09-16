import pg from 'pg';
import { createEvidenceServer } from './server.js';

const log = (event) => console.log(JSON.stringify(event));
let pool;
try {
  const connectionString = process.env.DATABASE_URL;
  const databaseUrl = new URL(connectionString);
  const port = Number(process.env.PORT ?? '3000');
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
    || !databaseUrl.hostname || databaseUrl.pathname.length < 2
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('invalid_configuration');
  }
  pool = new pg.Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
    idleTimeoutMillis: 10_000,
  });
  pool.on('error', () => log({ level: 'error', event: 'evidence.database.connection_failed' }));
  const server = createEvidenceServer(pool, log);
  const closePool = () => pool.end().catch(() => {
    log({ level: 'error', event: 'evidence.database.close_failed' });
    process.exitCode = 1;
  });
  server.on('error', () => {
    log({ level: 'error', event: 'evidence.server.failed' });
    process.exitCode = 1;
    void closePool();
  });
  server.listen(port, '0.0.0.0', () => log({ level: 'info', event: 'evidence.server.started', port }));
  process.once('SIGTERM', () => server.close(closePool));
  process.once('SIGINT', () => server.close(closePool));
} catch {
  log({ level: 'error', event: 'evidence.configuration.invalid' });
  process.exitCode = 1;
  if (pool) await pool.end();
}
