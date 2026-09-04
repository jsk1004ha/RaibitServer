import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { EvidenceError } from './operator-inputs.mjs';

const NON_PUBLIC_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

// Static snapshots of IANA's IPv6 Global Unicast Address Space (2025-10-10)
// and IPv6 Special-Purpose Address Space (2025-10-09). Runtime evidence must
// stay deterministic, so registry refreshes are reviewed code changes.
// Sources: https://www.iana.org/assignments/ipv6-unicast-address-assignments/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const GLOBAL_IPV6_ALLOCATIONS = [
  ['2001:200::', 23], ['2001:400::', 23], ['2001:600::', 23], ['2001:800::', 22],
  ['2001:c00::', 23], ['2001:e00::', 23], ['2001:1200::', 23], ['2001:1400::', 22],
  ['2001:1800::', 23], ['2001:1a00::', 23], ['2001:1c00::', 22], ['2001:2000::', 19],
  ['2001:4000::', 23], ['2001:4200::', 23], ['2001:4400::', 23], ['2001:4600::', 23],
  ['2001:4800::', 23], ['2001:4a00::', 23], ['2001:4c00::', 23], ['2001:5000::', 20],
  ['2001:8000::', 19], ['2001:a000::', 20], ['2001:b000::', 20], ['2003::', 18],
  ['2400::', 12], ['2410::', 12], ['2600::', 12], ['2610::', 23], ['2620::', 23],
  ['2630::', 12], ['2800::', 12], ['2a00::', 12], ['2a10::', 12], ['2c00::', 12],
];

const SPECIAL_IPV6 = [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96],
  ['64:ff9b:1::', 48], ['100::', 64], ['100:0:0:1::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['2620:4f:8000::', 48], ['3fff::', 20],
  ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];

const GLOBAL_SPECIAL_IPV6 = [
  ['2001:1::1', 128], ['2001:1::2', 128], ['2001:1::3', 128], ['2001:3::', 32],
  ['2001:4:112::', 48], ['2001:20::', 28], ['2001:30::', 28], ['2620:4f:8000::', 48],
];

function ipv4Number(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

function ipv6Parts(address) {
  if (address.includes('%') || address.split('::').length > 2) return null;
  const halves = address.toLowerCase().split('::');
  const parseHalf = (half) => {
    if (!half) return [];
    const segments = half.split(':');
    const last = segments.at(-1);
    if (last?.includes('.')) {
      const ipv4 = ipv4Number(last);
      if (ipv4 === null) return null;
      segments.splice(-1, 1, Math.floor(ipv4 / 65536).toString(16), (ipv4 % 65536).toString(16));
    }
    if (segments.some((segment) => !/^[a-f0-9]{1,4}$/.test(segment))) return null;
    return segments.map((segment) => Number.parseInt(segment, 16));
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  if (left === null || right === null) return null;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  return [...left, ...Array.from({ length: omitted }, () => 0), ...right];
}

function ipv6Number(address) {
  const parts = ipv6Parts(address);
  if (parts === null || parts.length !== 8) return null;
  return parts.reduce((value, part) => (value << 16n) + BigInt(part), 0n);
}

function ipv4InCidr(address, base, prefix) {
  const value = ipv4Number(address);
  const first = ipv4Number(base);
  if (value === null || first === null) return false;
  const block = 2 ** (32 - prefix);
  return Math.floor(value / block) === Math.floor(first / block);
}

function ipv6InCidr(address, base, prefix) {
  const value = ipv6Number(address);
  const first = ipv6Number(base);
  if (value === null || first === null) return false;
  const shift = BigInt(128 - prefix);
  return value >> shift === first >> shift;
}

function mappedIpv4(address) {
  const parts = ipv6Parts(address);
  if (parts === null || parts.length !== 8 || parts.slice(0, 5).some((part) => part !== 0) || parts[5] !== 0xffff) return null;
  return `${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`;
}

function translatedIpv4(address) {
  const parts = ipv6Parts(address);
  if (parts === null || !ipv6InCidr(address, '64:ff9b::', 96)) return null;
  return `${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`;
}

export function isGlobalAddress(address, family = isIP(address)) {
  if (family === 4) return ipv4Number(address) !== null
    && !NON_PUBLIC_IPV4.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
  if (family !== 6) return false;
  const mapped = mappedIpv4(address);
  if (mapped !== null) return isGlobalAddress(mapped, 4);
  const translated = translatedIpv4(address);
  if (translated !== null) return isGlobalAddress(translated, 4);
  const globallyReachableSpecial = GLOBAL_SPECIAL_IPV6.some(([base, prefix]) => ipv6InCidr(address, base, prefix));
  return ipv6Number(address) !== null && (globallyReachableSpecial
    || (GLOBAL_IPV6_ALLOCATIONS.some(([base, prefix]) => ipv6InCidr(address, base, prefix))
      && !SPECIAL_IPV6.some(([base, prefix]) => ipv6InCidr(address, base, prefix))));
}

function parsePublicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new EvidenceError('invalid_request');
  let url;
  try { url = new URL(value); }
  catch (error) { if (error instanceof TypeError) throw new EvidenceError('invalid_request'); throw error; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new EvidenceError('invalid_request');
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  const family = isIP(hostname);
  if (family === 0) {
    if (hostname.endsWith('.') || !hostname.includes('.') || hostname.length > 253
      || hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(hostname)) throw new EvidenceError('invalid_request');
  } else if (!isGlobalAddress(hostname, family)) throw new EvidenceError('invalid_request');
  for (const [name] of url.searchParams) {
    if (/password|token|secret|credential|authorization|api[_-]?key|private[_-]?key|cookie/i.test(name)) throw new EvidenceError('redaction');
  }
  return { url, hostname, family };
}

export async function resolvePublicHttpsTarget(value, lookup = dns.lookup) {
  const parsed = parsePublicUrl(value);
  if (parsed.family !== 0) return Object.freeze({ ...parsed, address: parsed.hostname, servername: undefined });
  let records;
  try { records = await lookup(parsed.hostname, { all: true, verbatim: true }); }
  catch (error) {
    if (error instanceof EvidenceError) throw error;
    if (error instanceof Error) throw new EvidenceError('public_endpoint_unavailable');
    throw error;
  }
  if (!Array.isArray(records) || records.length < 1 || records.length > 32
    || records.some((record) => !record || ![4, 6].includes(record.family) || !isGlobalAddress(record.address, record.family))) {
    throw new EvidenceError('invalid_request');
  }
  return Object.freeze({ ...parsed, address: records[0].address, family: records[0].family, servername: parsed.hostname });
}
