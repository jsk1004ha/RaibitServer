import { Inject, Injectable } from '@nestjs/common';
import { preflightTemplateInstallation, templateAvailability, templateRequestIdempotencyKey, TemplateInstallationError, type TemplateInstallationIntent, type TemplatePreflightContext, type EnvironmentSelector } from '@raibitserver/core';
import { TemplateInstallationResponseSchema, TemplatePreflightResponseSchema, TemplateInstallRequestSchema, TemplateRetryRequestSchema, type TemplateCatalogResponse, type TemplateDetailResponse, type TemplateInstallationResponse, type TemplateInstallationListResponse, type TemplatePreflightResponse } from '@raibitserver/schemas';
import { RAIBITSERVERService } from '../../raibitserver.service';
import { downloadTemplateSource, readPackagedTemplateCatalog } from './template-source';

type Subject = Readonly<Record<string, unknown>>;
interface TemplateControlPlane {
  templatePreflightContext(projectId: string, selector: EnvironmentSelector, key: string, subject: Subject): Promise<TemplatePreflightContext>;
  installTemplateGraph(intent: TemplateInstallationIntent, secretValues: Readonly<Record<string, string>>, subject: Subject): Promise<unknown>;
  listTemplateInstallations(projectId: string, selector: EnvironmentSelector, subject: Subject): Promise<readonly unknown[]>;
  getTemplateInstallation(id: string, selector: EnvironmentSelector, subject: Subject): Promise<unknown>;
  retryTemplateInstallation(id: string, input: unknown, selector: EnvironmentSelector, subject: Subject): Promise<unknown>;
}

@Injectable()
export class TemplatesService {
  constructor(@Inject(RAIBITSERVERService) private readonly controlPlane: TemplateControlPlane) {}

  async list(): Promise<TemplateCatalogResponse> {
    const catalog = await readPackagedTemplateCatalog();
    return { catalogDigest: catalog.catalogDigest, availability: templateAvailability(), starters: catalog.starters };
  }

  async show(catalogId: string, catalogVersion: string): Promise<TemplateDetailResponse> {
    const catalog = await readPackagedTemplateCatalog();
    const starter = catalog.starters.find(row => row.id === catalogId && row.version === catalogVersion);
    if (!starter) throw new TemplateInstallationError('TEMPLATE_NOT_FOUND', 404);
    return { catalogDigest: catalog.catalogDigest, availability: templateAvailability(), starter };
  }

  async preflight(projectId: string, input: unknown, selector: EnvironmentSelector, subject: Subject): Promise<TemplatePreflightResponse> {
    const intent = await this.plan(projectId, input, selector, subject);
    return TemplatePreflightResponseSchema.parse({ projectId: intent.projectId, environmentId: intent.environmentId, environmentKind: intent.environmentKind,
      catalogId: intent.catalogId, catalogVersion: intent.catalogVersion,
      services: intent.services.map(({ logicalSlug, type }) => ({ logicalSlug, type })),
      resources: intent.resources.map(({ logicalSlug, engine, plan }) => ({ logicalSlug, engine, plan })) });
  }

  async install(projectId: string, input: unknown, selector: EnvironmentSelector, subject: Subject): Promise<TemplateInstallationResponse> {
    const intent = await this.plan(projectId, input, selector, subject);
    const { inputs } = TemplateInstallRequestSchema.parse(input);
    return publicInstallation(await this.controlPlane.installTemplateGraph(intent, inputs, subject));
  }

  async listInstallations(projectId: string, selector: EnvironmentSelector, subject: Subject): Promise<TemplateInstallationListResponse> {
    return { installations: (await this.controlPlane.listTemplateInstallations(projectId, selector, subject)).map(publicInstallation) };
  }

  async get(installationId: string, selector: EnvironmentSelector, subject: Subject): Promise<TemplateInstallationResponse> {
    return publicInstallation(await this.controlPlane.getTemplateInstallation(installationId, selector, subject));
  }

  async retry(installationId: string, input: unknown, selector: EnvironmentSelector, subject: Subject): Promise<TemplateInstallationResponse> {
    const parsed = TemplateRetryRequestSchema.safeParse(input);
    if (!parsed.success) throw new TemplateInstallationError('TEMPLATE_INPUT_INVALID', 400);
    return publicInstallation(await this.controlPlane.retryTemplateInstallation(installationId, parsed.data, selector, subject));
  }

  download = downloadTemplateSource;

  private async plan(projectId: string, input: unknown, selector: EnvironmentSelector, subject: Subject): Promise<TemplateInstallationIntent> {
    const key = templateRequestIdempotencyKey(input);
    const [catalog, context] = await Promise.all([readPackagedTemplateCatalog(), this.controlPlane.templatePreflightContext(projectId, selector, key, subject)]);
    if (!templateAvailability().enabled) throw new TemplateInstallationError('TEMPLATE_UNAVAILABLE', 409);
    return preflightTemplateInstallation(catalog, input, context);
  }
}

function publicInstallation(input: unknown): TemplateInstallationResponse {
  if (!isRecord(input) || !Array.isArray(input.services) || !Array.isArray(input.resources)) throw new TemplateInstallationError('TEMPLATE_VERSION_CONFLICT', 409);
  const parsed = TemplateInstallationResponseSchema.safeParse({
    installation: { id: input.installationId, projectId: input.projectId, environmentId: input.environmentId, environmentKind: input.environmentKind,
      version: input.version, catalogId: input.catalogId, catalogVersion: input.catalogVersion }, progress: input.progress,
    services: input.services.map(row => isRecord(row) ? { id: row.id, logicalSlug: row.logicalSlug, type: row.type, deploymentId: row.deploymentId } : null),
    resources: input.resources.map(row => isRecord(row) ? { id: row.id, logicalSlug: row.logicalSlug, engine: row.engine, plan: row.plan } : null),
  });
  if (!parsed.success) throw new TemplateInstallationError('TEMPLATE_VERSION_CONFLICT', 409);
  return parsed.data;
}
function isRecord(input: unknown): input is Record<string, unknown> { return typeof input === 'object' && input !== null && !Array.isArray(input); }
