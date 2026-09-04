import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertRedacted, digest, EvidenceError } from './operator-inputs.mjs';

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_PATH_BYTES = 512;
const MAX_SEGMENTS = 8;
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function parseRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > MAX_PATH_BYTES
    || value.includes('\\') || value.includes(':') || path.posix.isAbsolute(value)) throw new EvidenceError('invalid_artifact');
  const segments = value.split('/');
  if (segments.length > MAX_SEGMENTS || segments.some((segment) => !SEGMENT.test(segment) || segment.endsWith('.')
    || segment === '.' || segment === '..' || WINDOWS_DEVICE.test(segment))) throw new EvidenceError('invalid_artifact');
  return Object.freeze(segments);
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function allowedPathPredicate(value) {
  if (typeof value === 'function') return value;
  if (!Array.isArray(value) && !(value instanceof Set)) throw new EvidenceError('invalid_artifact_policy');
  const allowed = new Set(value);
  if (allowed.size === 0 || [...allowed].some((item) => typeof item !== 'string')) throw new EvidenceError('invalid_artifact_policy');
  for (const artifactPath of allowed) parseRelativePath(artifactPath);
  return (artifactPath) => allowed.has(artifactPath);
}

async function checkedDirectory(root, candidate) {
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new EvidenceError('invalid_artifact');
  const resolved = await realpath(candidate);
  if (resolved !== candidate || (candidate !== root && !pathIsWithin(root, resolved))) throw new EvidenceError('invalid_artifact');
}

async function ensureParent(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    await checkedDirectory(root, current);
  }
  return current;
}

export async function createSafeArtifactWriter({ runDirectory, allowedPaths }) {
  if (typeof runDirectory !== 'string' || !path.isAbsolute(runDirectory)) throw new EvidenceError('invalid_run_directory');
  const root = path.resolve(runDirectory);
  await checkedDirectory(root, root);
  const isAllowed = allowedPathPredicate(allowedPaths);

  return Object.freeze({
    async writeJson(relativePath, value) {
      const segments = parseRelativePath(relativePath);
      if (isAllowed(relativePath) !== true) throw new EvidenceError('invalid_artifact');
      const encoded = JSON.stringify(value);
      if (typeof encoded !== 'string') throw new EvidenceError('invalid_schema');
      assertRedacted(encoded);
      const bytes = Buffer.from(`${encoded}\n`);
      if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) throw new EvidenceError('artifact_output_limit');

      const parent = await ensureParent(root, segments.slice(0, -1));
      const target = path.join(parent, segments.at(-1));
      if (!pathIsWithin(root, target)) throw new EvidenceError('invalid_artifact');
      const resolvedParent = await realpath(parent);
      if (resolvedParent !== parent || !pathIsWithin(root, target)) throw new EvidenceError('invalid_artifact');
      const parentIdentity = await lstat(parent);

      try {
        const existing = await lstat(target);
        if (existing.isSymbolicLink() || !existing.isFile()) throw new EvidenceError('invalid_artifact');
        throw new EvidenceError('reused_artifact');
      } catch (error) {
        if (error instanceof EvidenceError) throw error;
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }

      const noFollow = typeof constants.O_NOFOLLOW === 'number' && process.platform !== 'win32' ? constants.O_NOFOLLOW : 0;
      let handle;
      try {
        handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new EvidenceError('reused_artifact');
        if (error instanceof Error && 'code' in error && ['ELOOP', 'ENOTDIR'].includes(error.code)) throw new EvidenceError('invalid_artifact');
        throw error;
      }
      try {
        const metadata = await handle.stat();
        const currentParent = await lstat(parent);
        const currentTarget = await lstat(target);
        if (!metadata.isFile() || currentTarget.isSymbolicLink() || !currentTarget.isFile()
          || parentIdentity.dev !== currentParent.dev || parentIdentity.ino !== currentParent.ino
          || metadata.dev !== currentTarget.dev || metadata.ino !== currentTarget.ino
          || await realpath(parent) !== parent || await realpath(target) !== target) throw new EvidenceError('invalid_artifact');
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return Object.freeze({ path: relativePath, sha256: digest(bytes), redacted: true });
    },
  });
}
