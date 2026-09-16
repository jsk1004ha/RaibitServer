import http from 'node:http';

const MAX_BODY_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const NONCE = /^[a-f0-9]{64}$/;

class InputError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

async function readEvidence(request) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) {
    throw new InputError(415, 'json_required');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      throw new InputError(413, 'body_too_large');
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new InputError(400, 'invalid_json');
  }
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).sort().join(',') !== 'deploymentId,nonce,runId'
    || typeof value.runId !== 'string' || !UUID.test(value.runId)
    || typeof value.deploymentId !== 'string' || !IDENTIFIER.test(value.deploymentId)
    || typeof value.nonce !== 'string' || !NONCE.test(value.nonce)) {
    throw new InputError(400, 'invalid_evidence');
  }
  return { runId: value.runId, deploymentId: value.deploymentId, nonce: value.nonce };
}

function respond(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function createEvidenceServer(database, log) {
  const server = http.createServer(async (request, response) => {
    const path = request.url;
    const method = path === '/_evidence/db' ? 'POST' : 'GET';
    if (!['/healthz/live', '/healthz/ready', '/_evidence/db'].includes(path)) {
      respond(response, 404, { error: 'not_found' });
      return;
    }
    if (request.method !== method) {
      response.setHeader('allow', method);
      respond(response, 405, { error: 'method_not_allowed' });
      return;
    }
    if (path === '/healthz/live') {
      respond(response, 200, { ok: true });
      return;
    }
    let evidence;
    try {
      if (path === '/healthz/ready') {
        const result = await database.query('SELECT 1 AS ready');
        if (result.rows[0]?.ready !== 1) throw new Error('database_not_ready');
        respond(response, 200, { ok: true });
        return;
      }
      evidence = await readEvidence(request);
      await database.query(`CREATE TABLE IF NOT EXISTS public.production_evidence_nonces (
        run_id uuid NOT NULL,
        deployment_id varchar(128) NOT NULL,
        nonce varchar(64) NOT NULL,
        PRIMARY KEY (run_id, deployment_id, nonce)
      )`);
      const values = [evidence.runId, evidence.deploymentId, evidence.nonce];
      await database.query(`INSERT INTO public.production_evidence_nonces (run_id, deployment_id, nonce)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, values);
      const result = await database.query(`SELECT nonce FROM public.production_evidence_nonces
        WHERE run_id = $1 AND deployment_id = $2 AND nonce = $3`, values);
      const readBack = result.rows[0]?.nonce;
      if (result.rows.length !== 1 || readBack !== evidence.nonce) throw new Error('database_readback_failed');
      log({ level: 'info', event: 'evidence.db.completed', runId: evidence.runId,
        deploymentId: evidence.deploymentId, correlationId: evidence.nonce });
      respond(response, 200, { nonce: evidence.nonce, readBack });
    } catch (error) {
      if (error instanceof InputError) {
        respond(response, error.status, { error: error.message });
        return;
      }
      log({ level: 'error', event: path === '/healthz/ready' ? 'evidence.readiness.failed' : 'evidence.db.failed',
        ...(evidence ? { runId: evidence.runId, deploymentId: evidence.deploymentId, correlationId: evidence.nonce } : {}) });
      respond(response, 503, { error: 'database_unavailable' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return server;
}
