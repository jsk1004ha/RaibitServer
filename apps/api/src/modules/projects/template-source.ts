import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TemplateInstallationError, validateTemplateCatalog } from '@raibitserver/core';
import { TemplateSourceDownloadSchema, type TemplateCatalog, type TemplateSourceDownload } from '@raibitserver/schemas';

type SourceIdentity = Pick<TemplateSourceDownload, 'catalogId' | 'catalogVersion' | 'catalogDigest' | 'sourceDigest'>;
const digest = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export async function readPackagedTemplateCatalog(): Promise<TemplateCatalog> {
  return validateTemplateCatalog(JSON.parse(await readPackagedText('starter-catalog-v1.json')));
}

export async function downloadTemplateSource(
  catalogId: string, catalogVersion: string, catalogDigest: string, sourceDigest: string,
): Promise<TemplateSourceDownload> {
  const [catalog, bundleText] = await Promise.all([
    readPackagedTemplateCatalog(), readPackagedText('starter-catalog-v1.bundle.json'),
  ]);
  return validateTemplateSourceDownload(catalog, bundleText, { catalogId, catalogVersion, catalogDigest, sourceDigest });
}

export function validateTemplateSourceDownload(
  catalogInput: unknown, bundleText: string, identity: SourceIdentity,
): TemplateSourceDownload {
  const catalog = validateTemplateCatalog(catalogInput);
  if (catalog.catalogDigest !== identity.catalogDigest || catalog.bundleDigest !== digest(bundleText)) {
    throw new TemplateInstallationError('TEMPLATE_CATALOG_DIGEST_MISMATCH', 409);
  }
  let bundle: unknown;
  try { bundle = JSON.parse(bundleText); }
  catch { throw new TemplateInstallationError('TEMPLATE_SOURCE_DIGEST_MISMATCH', 409); }
  if (!isRecord(bundle) || Object.keys(bundle).length !== 2 || bundle.schema !== 'raibitserver.starter-source-bundle/v1'
    || !Array.isArray(bundle.sources) || bundle.sources.length !== catalog.starters.length) {
    throw new TemplateInstallationError('TEMPLATE_SOURCE_DIGEST_MISMATCH', 409);
  }
  let previousSource = '';
  let selected: TemplateSourceDownload | undefined;
  for (const source of bundle.sources) {
    if (!isRecord(source)) throw new TemplateInstallationError('TEMPLATE_SOURCE_DIGEST_MISMATCH', 409);
    const starter = catalog.starters.find(candidate => candidate.id === source.id && candidate.version === source.version);
    if (!starter) throw new TemplateInstallationError('TEMPLATE_SOURCE_DIGEST_MISMATCH', 409);
    const sourceKey = `${starter.id}/${starter.version}`;
    if (sourceKey <= previousSource) throw new TemplateInstallationError('TEMPLATE_SOURCE_DIGEST_MISMATCH', 409);
    previousSource = sourceKey;
    const parsed = TemplateSourceDownloadSchema.safeParse({
      contentType: 'application/vnd.raibitserver.starter-source.v1+json',
      filename: `${starter.id}-${starter.version}.raibit-starter.json`,
      catalogId: starter.id, catalogVersion: starter.version, catalogDigest: catalog.catalogDigest,
      sourceDigest: starter.source.digest, source,
    });
    if (!parsed.success) throw new TemplateInstallationError('TEMPLATE_SOURCE_DIGEST_MISMATCH', 409);
    const download = parsed.data;
    const hash = createHash('sha256');
    let previousPath = '';
    let byteCount = 0;
    for (const file of download.source.files) {
      if (file.path <= previousPath || file.path.includes('\\') || /[:\x00-\x1f\x7f-\x9f]/.test(file.path)
        || path.posix.isAbsolute(file.path) || file.path.split('/').some(part => part === '' || part === '.' || part === '..')) {
        throw new TemplateInstallationError('TEMPLATE_SOURCE_DIGEST_MISMATCH', 409);
      }
      const content = Buffer.from(file.contentBase64, 'base64');
      if (content.toString('base64') !== file.contentBase64 || file.size !== content.length || file.digest !== digest(content)) {
        throw new TemplateInstallationError('TEMPLATE_SOURCE_DIGEST_MISMATCH', 409);
      }
      hash.update(`${file.path}\0${file.mode}\0${content.length}\0`);
      hash.update(content);
      hash.update('\0');
      previousPath = file.path;
      byteCount += content.length;
    }
    if (download.source.digest !== `sha256:${hash.digest('hex')}` || download.source.digest !== starter.source.digest
      || download.source.files.length !== starter.source.fileCount || byteCount !== starter.source.byteCount) {
      throw new TemplateInstallationError('TEMPLATE_SOURCE_DIGEST_MISMATCH', 409);
    }
    if (starter.id === identity.catalogId && starter.version === identity.catalogVersion) selected = download;
  }
  if (!selected || selected.sourceDigest !== identity.sourceDigest) {
    throw new TemplateInstallationError('TEMPLATE_SOURCE_DIGEST_MISMATCH', 409);
  }
  return selected;
}

async function readPackagedText(filename: string): Promise<string> {
  try { return await readFile(path.resolve(process.cwd(), filename), 'utf8'); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT' || process.env.NODE_ENV === 'production') throw error;
    return readFile(path.resolve(process.cwd(), 'test-fixtures', 'contracts', filename), 'utf8');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
