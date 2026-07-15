type AnyRecord = Record<string, any>;

export function startBoundedSseStream({ req, res, event, initialPayload, load }: {
  req: any;
  res: any;
  event: string;
  initialPayload: AnyRecord;
  load: (cursors: AnyRecord) => Promise<AnyRecord>;
}) {
  const streamConfig = initialPayload?.stream || {};
  const retryMs = boundedInteger(streamConfig.retryMs, 3_000, 10, 60_000);
  const heartbeatMs = boundedInteger(streamConfig.heartbeatMs, 15_000, 10, 60_000);
  const maxLifetimeMs = boundedInteger(streamConfig.maxLifetimeMs, 15 * 60_000, 25, 60 * 60_000);
  const slowClientTimeoutMs = boundedInteger(streamConfig.slowClientTimeoutMs, 5_000, 10, 60_000);
  const deltaEvent = event.endsWith('.snapshot') ? `${event.slice(0, -'.snapshot'.length)}.delta` : `${event}.delta`;
  const cursors = cursorValues(initialPayload);
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

  prepareResponse(res);
  writeFrame(`retry: ${retryMs}\n\n`);
  writeEvent(event, initialPayload);

  if (!closed) {
    pollTimer = setInterval(() => void poll(), retryMs);
    heartbeatTimer = setInterval(() => {
      if (!closed && !backpressured) writeFrame(`: keepalive ${Date.now()}\n\n`);
    }, heartbeatMs);
    lifetimeTimer = setTimeout(() => stop(true), maxLifetimeMs);
    pollTimer.unref?.();
    heartbeatTimer.unref?.();
    lifetimeTimer.unref?.();
    req?.on?.('close', onRequestClose);
    res?.on?.('close', onResponseClose);
  }

  async function poll() {
    if (closed || polling || backpressured) return;
    polling = true;
    try {
      const payload = await load({ ...cursors });
      Object.assign(cursors, cursorValues(payload));
      if (hasDelta(payload)) writeEvent(deltaEvent, payload);
    } catch {
      writeEvent('stream.error', { error: 'stream update unavailable' });
    } finally {
      polling = false;
    }
  }

  function writeEvent(eventName: string, payload: AnyRecord) {
    sequence += 1;
    return writeFrame(`id: ${Date.now()}-${sequence}\nevent: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  function writeFrame(frame: string) {
    if (closed || backpressured) return false;
    let accepted = false;
    try {
      accepted = res.write(frame) !== false;
    } catch {
      stop(true);
      return false;
    }
    if (!accepted) waitForDrain();
    return accepted;
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
  }

  return {
    stop,
    get closed() { return closed; },
    get backpressured() { return backpressured; },
  };
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
