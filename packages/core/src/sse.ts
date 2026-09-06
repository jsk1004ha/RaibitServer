import { projectObservationPayload } from './observability-projection.ts';
import { decodeKeysetCursor } from './store-helpers.ts';

type AnyRecord = Record<string, any>;

export type ServiceLogResumeScope = {
  readonly projectId: string;
  readonly serviceId: string;
};

export type ServiceLogResumeCursor = {
  readonly serviceCursor: string | null;
  readonly logCursor: ReturnType<typeof decodeKeysetCursor> | null;
  readonly logCursorToken: string | null;
};

export type DeploymentActivityResumeScope = {
  readonly projectId: string;
  readonly deploymentId: string;
};

export type DeploymentActivityResumeCursor = {
  readonly deploymentCursor: string | null;
  readonly logCursorToken: string | null;
  readonly eventCursorToken: string | null;
};

type ResumeTokenPayload = {
  readonly v: 1;
  readonly p: string;
  readonly s: string;
  readonly sc: string | null;
  readonly lc: string | null;
};

type DeploymentResumeTokenPayload = {
  readonly v: 1;
  readonly p: string;
  readonly d: string;
  readonly dc: string | null;
  readonly lc: string | null;
  readonly ec: string | null;
};

const MAX_RESUME_TOKEN_LENGTH = 2_048;
const MAX_SCOPE_LENGTH = 512;
const MAX_SERVICE_CURSOR_LENGTH = 1_024;
const MAX_DEPLOYMENT_RESUME_TOKEN_LENGTH = 4_096;

export class ServiceLogResumeTokenError extends Error {
  readonly name = 'ServiceLogResumeTokenError';
  readonly statusCode = 400;

  constructor() {
    super('invalid service log resume token');
  }
}

export class DeploymentActivityResumeTokenError extends Error {
  readonly name = 'DeploymentActivityResumeTokenError';
  readonly code = 'INVALID_DEPLOYMENT_RESUME_CURSOR';
  readonly statusCode = 400;

  constructor() {
    super('invalid deployment activity resume cursor');
  }
}

export function encodeServiceLogResumeToken(scope: ServiceLogResumeScope, cursors: { readonly serviceCursor?: unknown; readonly logCursor?: unknown }): string {
  const projectId = boundedRequiredString(scope.projectId, MAX_SCOPE_LENGTH);
  const serviceId = boundedRequiredString(scope.serviceId, MAX_SCOPE_LENGTH);
  const serviceCursor = boundedOptionalString(cursors.serviceCursor, MAX_SERVICE_CURSOR_LENGTH);
  const logCursor = boundedOptionalString(cursors.logCursor, 1_024);
  if (logCursor !== null) decodeKeysetCursor(logCursor);
  const payload: ResumeTokenPayload = { v: 1, p: projectId, s: serviceId, sc: serviceCursor, lc: logCursor };
  const token = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (token.length > MAX_RESUME_TOKEN_LENGTH) throw new ServiceLogResumeTokenError();
  return token;
}

export function decodeServiceLogResumeToken(value: unknown, scope: ServiceLogResumeScope): ServiceLogResumeCursor {
  if (typeof value !== 'string' || !value || value.length > MAX_RESUME_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ServiceLogResumeTokenError();
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!isResumeTokenPayload(decoded)) throw new ServiceLogResumeTokenError();
    if (decoded.p !== scope.projectId || decoded.s !== scope.serviceId) throw new ServiceLogResumeTokenError();
    return {
      serviceCursor: decoded.sc,
      logCursor: decoded.lc === null ? null : decodeKeysetCursor(decoded.lc),
      logCursorToken: decoded.lc,
    };
  } catch (error) {
    if (error instanceof ServiceLogResumeTokenError) throw error;
    throw new ServiceLogResumeTokenError();
  }
}

export function encodeDeploymentActivityResumeToken(scope: DeploymentActivityResumeScope, cursors: { readonly deploymentCursor?: unknown; readonly logCursor?: unknown; readonly eventCursor?: unknown }): string {
  try {
    const deploymentCursor = boundedOptionalString(cursors.deploymentCursor, MAX_SERVICE_CURSOR_LENGTH);
    const logCursor = boundedOptionalString(cursors.logCursor, 1_024);
    const eventCursor = boundedOptionalString(cursors.eventCursor, 1_024);
    if (logCursor !== null) decodeKeysetCursor(logCursor);
    if (eventCursor !== null) decodeKeysetCursor(eventCursor);
    const payload: DeploymentResumeTokenPayload = {
      v: 1,
      p: boundedRequiredString(scope.projectId, MAX_SCOPE_LENGTH),
      d: boundedRequiredString(scope.deploymentId, MAX_SCOPE_LENGTH),
      dc: deploymentCursor,
      lc: logCursor,
      ec: eventCursor,
    };
    const token = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    if (token.length > MAX_DEPLOYMENT_RESUME_TOKEN_LENGTH) throw new DeploymentActivityResumeTokenError();
    return token;
  } catch (error) {
    if (error instanceof DeploymentActivityResumeTokenError) throw error;
    throw new DeploymentActivityResumeTokenError();
  }
}

export function decodeDeploymentActivityResumeToken(value: unknown, scope: DeploymentActivityResumeScope): DeploymentActivityResumeCursor {
  if (typeof value !== 'string' || !value || value.length > MAX_DEPLOYMENT_RESUME_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new DeploymentActivityResumeTokenError();
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!isDeploymentResumeTokenPayload(decoded) || decoded.p !== scope.projectId || decoded.d !== scope.deploymentId) {
      throw new DeploymentActivityResumeTokenError();
    }
    if (decoded.lc !== null) decodeKeysetCursor(decoded.lc);
    if (decoded.ec !== null) decodeKeysetCursor(decoded.ec);
    return { deploymentCursor: decoded.dc, logCursorToken: decoded.lc, eventCursorToken: decoded.ec };
  } catch (error) {
    if (error instanceof DeploymentActivityResumeTokenError) throw error;
    throw new DeploymentActivityResumeTokenError();
  }
}

export function startBoundedSseStream({ req, res, event, initialPayload, load, onClose, preprojected = false, eventId, terminalError }: {
  req: any;
  res: any;
  event: string;
  initialPayload: AnyRecord;
  load: (cursors: AnyRecord) => Promise<AnyRecord>;
  onClose?: () => void;
  preprojected?: boolean;
  eventId?: (payload: AnyRecord) => string;
  terminalError?: (error: unknown) => boolean;
}) {
  const streamConfig = initialPayload?.stream || {};
  const retryMs = boundedInteger(streamConfig.retryMs, 3_000, 10, 60_000);
  const heartbeatMs = boundedInteger(streamConfig.heartbeatMs, 15_000, 10, 60_000);
  const maxLifetimeMs = boundedInteger(streamConfig.maxLifetimeMs, 15 * 60_000, 25, 60 * 60_000);
  const slowClientTimeoutMs = boundedInteger(streamConfig.slowClientTimeoutMs, 5_000, 10, 60_000);
  const deltaEvent = event.endsWith('.snapshot') ? `${event.slice(0, -'.snapshot'.length)}.delta` : `${event}.delta`;
  const initial = preprojected ? initialPayload : projectObservationPayload(initialPayload);
  const cursors: AnyRecord = {};
  let sequence = 0;
  let polling = false;
  let closed = false;
  let backpressured = false;
  let slowClientTimer: any = null;
  let drainListener: (() => void) | null = null;
  let pollTimer: any = null;
  let heartbeatTimer: any = null;
  let lifetimeTimer: any = null;
  const onRequestClose = () => stop(false);
  const onResponseClose = () => stop(false);

  try {
    prepareResponse(res);
    writeFrame(`retry: ${retryMs}\n\n`);
    if (writeEvent(event, initial)) Object.assign(cursors, cursorValues(initial));

    if (!closed) {
      pollTimer = setInterval(() => void poll(), retryMs);
      heartbeatTimer = setInterval(() => {
        if (!closed && !backpressured) writeFrame(`: keepalive ${Date.now()}\n\n`);
      }, heartbeatMs);
      lifetimeTimer = setTimeout(() => {
        writeControlEvent('stream.end', { reason: 'max_lifetime' });
        stop(true);
      }, maxLifetimeMs);
      pollTimer.unref?.();
      heartbeatTimer.unref?.();
      lifetimeTimer.unref?.();
      req?.on?.('close', onRequestClose);
      res?.on?.('close', onResponseClose);
    }
  } catch {
    stop(true);
  }

  async function poll() {
    if (closed || polling || backpressured) return;
    polling = true;
    try {
      const loaded = await load({ ...cursors });
      const payload = preprojected ? loaded : projectObservationPayload(loaded);
      if (hasDelta(payload) && writeEvent(deltaEvent, payload)) Object.assign(cursors, cursorValues(payload));
    } catch (error) {
      writeControlEvent('stream.error', { error: 'stream update unavailable' });
      if (terminalError?.(error)) stop(true);
    } finally {
      polling = false;
    }
  }

  function writeEvent(eventName: string, payload: AnyRecord) {
    sequence += 1;
    const id = eventId ? eventId(payload) : `${Date.now()}-${sequence}`;
    return writeFrame(`id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  function writeControlEvent(eventName: string, payload: AnyRecord) {
    if (!eventId) return writeEvent(eventName, payload);
    return writeFrame(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  function writeFrame(frame: string) {
    if (closed || backpressured) return false;
    let writable = false;
    try {
      writable = res.write(frame) !== false;
    } catch {
      stop(true);
      return false;
    }
    if (!writable) waitForDrain();
    return true;
  }

  function waitForDrain() {
    if (closed || backpressured) return;
    backpressured = true;
    const onDrain = () => {
      if (closed) return;
      backpressured = false;
      drainListener = null;
      if (slowClientTimer) clearTimeout(slowClientTimer);
      slowClientTimer = null;
    };
    if (typeof res.once !== 'function') {
      stop(true);
      return;
    }
    drainListener = onDrain;
    res.once('drain', onDrain);
    slowClientTimer = setTimeout(() => {
      res.removeListener?.('drain', onDrain);
      drainListener = null;
      stop(true);
    }, slowClientTimeoutMs);
    slowClientTimer.unref?.();
  }

  function stop(endResponse = false) {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    clearTimeout(lifetimeTimer);
    if (slowClientTimer) clearTimeout(slowClientTimer);
    if (drainListener) res.removeListener?.('drain', drainListener);
    drainListener = null;
    req?.removeListener?.('close', onRequestClose);
    res?.removeListener?.('close', onResponseClose);
    if (endResponse && !res.writableEnded && !res.destroyed) {
      try { res.end(); } catch { /* response is already gone */ }
    }
    try { onClose?.(); } catch { /* cleanup cannot reopen a closed stream */ }
  }

  return {
    stop,
    get closed() { return closed; },
    get backpressured() { return backpressured; },
  };
}

function isResumeTokenPayload(value: unknown): value is ResumeTokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(',') !== 'lc,p,s,sc,v') return false;
  const version = Reflect.get(value, 'v');
  const projectId = Reflect.get(value, 'p');
  const serviceId = Reflect.get(value, 's');
  const serviceCursor = Reflect.get(value, 'sc');
  const logCursor = Reflect.get(value, 'lc');
  return version === 1
    && typeof projectId === 'string' && projectId.length > 0 && projectId.length <= MAX_SCOPE_LENGTH
    && typeof serviceId === 'string' && serviceId.length > 0 && serviceId.length <= MAX_SCOPE_LENGTH
    && (serviceCursor === null || (typeof serviceCursor === 'string' && serviceCursor.length > 0 && serviceCursor.length <= MAX_SERVICE_CURSOR_LENGTH))
    && (logCursor === null || (typeof logCursor === 'string' && logCursor.length > 0 && logCursor.length <= 1_024));
}

function isDeploymentResumeTokenPayload(value: unknown): value is DeploymentResumeTokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(',') !== 'd,dc,ec,lc,p,v') return false;
  const stringOrNull = (candidate: unknown, maximum: number) => candidate === null || (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= maximum);
  return Reflect.get(value, 'v') === 1
    && stringOrNull(Reflect.get(value, 'p'), MAX_SCOPE_LENGTH) && Reflect.get(value, 'p') !== null
    && stringOrNull(Reflect.get(value, 'd'), MAX_SCOPE_LENGTH) && Reflect.get(value, 'd') !== null
    && stringOrNull(Reflect.get(value, 'dc'), MAX_SERVICE_CURSOR_LENGTH)
    && stringOrNull(Reflect.get(value, 'lc'), 1_024)
    && stringOrNull(Reflect.get(value, 'ec'), 1_024);
}

function boundedRequiredString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new ServiceLogResumeTokenError();
  return value;
}

function boundedOptionalString(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return boundedRequiredString(value, maximum);
}

function prepareResponse(res: any) {
  if (typeof res.status === 'function') res.status(200);
  else if (typeof res.writeHead === 'function' && !res.headersSent) res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.setHeader === 'function' && !res.headersSent) {
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
  }
  res.flushHeaders?.();
}

function cursorValues(payload: AnyRecord = {}) {
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) => key.endsWith('Cursor') && typeof value === 'string' && value));
}

function hasDelta(payload: AnyRecord = {}) {
  return Object.entries(payload).some(([key, value]) => {
    if (key === 'stream' || key.endsWith('Cursor')) return false;
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null;
  });
}

function boundedInteger(value: any, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}
