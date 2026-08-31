export function controlPlaneErrorCode(payload, status) {
  const candidates = [payload?.code, payload?.message, payload?.error];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate)) return candidate;
  }
  return `request_failed_${status}`;
}
