import {
  TemplateCatalogResponseSchema,
  TemplateDetailResponseSchema,
  TemplateInstallationListResponseSchema,
  TemplateInstallationResponseSchema,
  TemplatePreflightResponseSchema,
  TemplateSourceDownloadSchema,
} from '@raibitserver/schemas';

// Validate public template responses before they cross the server/browser boundary.
export function templateResponseSchema(path: string, method: string) {
  if (method === 'GET' && path === '/templates') return TemplateCatalogResponseSchema;
  if (method === 'GET' && /^\/templates\/[^/]+\/versions\/[^/]+\/source$/.test(path)) return TemplateSourceDownloadSchema;
  if (method === 'GET' && /^\/templates\/[^/]+\/versions\/[^/]+$/.test(path)) return TemplateDetailResponseSchema;
  if (method === 'POST' && /^\/projects\/[^/]+\/template-installations\/preflight$/.test(path)) return TemplatePreflightResponseSchema;
  if (/^\/projects\/[^/]+\/template-installations$/.test(path)) return method === 'GET' ? TemplateInstallationListResponseSchema : method === 'POST' ? TemplateInstallationResponseSchema : null;
  if ((method === 'GET' && /^\/template-installations\/[^/]+$/.test(path)) || (method === 'POST' && /^\/template-installations\/[^/]+\/retry$/.test(path))) return TemplateInstallationResponseSchema;
  return null;
}
