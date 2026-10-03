import pg from 'pg';

export const dynamic = 'force-dynamic';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, max: 2 });

export async function GET() {
  if (!process.env.DATABASE_URL) return Response.json({ status: 'unhealthy', code: 'DATABASE_URL_REQUIRED' }, { status: 503 });
  try {
    const client = await pool.connect();
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS raibit_starter');
      await client.query('CREATE TABLE IF NOT EXISTS raibit_starter.health_probe (id text PRIMARY KEY, checked_at timestamptz NOT NULL)');
      await client.query("INSERT INTO raibit_starter.health_probe (id, checked_at) VALUES ('synthetic-healthz', now()) ON CONFLICT (id) DO UPDATE SET checked_at = excluded.checked_at");
      const result = await client.query("SELECT id FROM raibit_starter.health_probe WHERE id = 'synthetic-healthz'");
      return Response.json({ status: result.rows[0]?.id === 'synthetic-healthz' ? 'ok' : 'unhealthy', database: 'roundtrip' }, { status: result.rows[0] ? 200 : 503 });
    } finally {
      client.release();
    }
  } catch {
    return Response.json({ status: 'unhealthy', code: 'DATABASE_ROUNDTRIP_FAILED' }, { status: 503 });
  }
}
