import { Body, Controller, Get, HttpCode, HttpException, Param, Post, Query, Req } from '@nestjs/common';
import { TemplateInstallationError, type EnvironmentSelector } from '@raibitserver/core';
import { RequirePermission } from '../../auth/permissions.decorator';
import { TemplatesService } from './templates.service';

type AuthenticatedRequest = { readonly raibitSubject: Readonly<Record<string, unknown>> };

@Controller()
export class ProjectTemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @RequirePermission('project:read')
  @Get('templates')
  list() { return templateResponse(() => this.templates.list()); }

  @RequirePermission('project:read')
  @Get('templates/:catalogId/versions/:catalogVersion')
  show(@Param('catalogId') id: string, @Param('catalogVersion') version: string) { return templateResponse(() => this.templates.show(id, version)); }

  @RequirePermission('project:read')
  @Get('templates/:catalogId/versions/:catalogVersion/source')
  download(@Param('catalogId') id: string, @Param('catalogVersion') version: string, @Query('catalogDigest') catalogDigest: string, @Query('sourceDigest') sourceDigest: string) {
    return templateResponse(() => this.templates.download(id, version, catalogDigest, sourceDigest));
  }

  @RequirePermission('deploy:run')
  @Post('projects/:projectId/template-installations/preflight')
  @HttpCode(200)
  preflight(@Param('projectId') id: string, @Query() selector: EnvironmentSelector, @Body() input: unknown, @Req() request: AuthenticatedRequest) {
    return templateResponse(() => this.templates.preflight(id, input, selector, request.raibitSubject));
  }

  @RequirePermission('deploy:run')
  @Post('projects/:projectId/template-installations')
  @HttpCode(202)
  install(@Param('projectId') id: string, @Query() selector: EnvironmentSelector, @Body() input: unknown, @Req() request: AuthenticatedRequest) {
    return templateResponse(() => this.templates.install(id, input, selector, request.raibitSubject));
  }

  @RequirePermission('project:read')
  @Get('projects/:projectId/template-installations')
  installations(@Param('projectId') id: string, @Query() selector: EnvironmentSelector, @Req() request: AuthenticatedRequest) {
    return templateResponse(() => this.templates.listInstallations(id, selector, request.raibitSubject));
  }

  @RequirePermission('project:read')
  @Get('template-installations/:installationId')
  get(@Param('installationId') id: string, @Query() selector: EnvironmentSelector, @Req() request: AuthenticatedRequest) {
    return templateResponse(() => this.templates.get(id, selector, request.raibitSubject));
  }

  @RequirePermission('deploy:run')
  @Post('template-installations/:installationId/retry')
  @HttpCode(202)
  retry(@Param('installationId') id: string, @Query() selector: EnvironmentSelector, @Body() input: unknown, @Req() request: AuthenticatedRequest) {
    return templateResponse(() => this.templates.retry(id, input, selector, request.raibitSubject));
  }
}

async function templateResponse<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof TemplateInstallationError) throw new HttpException({ statusCode: error.statusCode, message: error.code, code: error.code }, error.statusCode);
    throw error;
  }
}
