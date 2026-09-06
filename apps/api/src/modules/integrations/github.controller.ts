import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/permissions.decorator';
import { GitHubIntegrationService } from './github.service';

@Controller()
export class GitHubIntegrationController {
  constructor(private readonly githubService: GitHubIntegrationService) {}

  @RequirePermission('team:invite')
  @Get('github/install')
  install(@Req() req: any) {
    return this.githubService.githubAppInstall(req.raibitSubject);
  }

  @RequirePermission('team:invite')
  @Get('github/authorize')
  authorize(@Query() input: Record<string, any>, @Req() req: any) {
    return this.githubService.githubAppAuthorize(input, req.raibitSubject);
  }

  @RequirePermission('team:invite')
  @Get('github/callback')
  callback(@Query() input: Record<string, any>, @Req() req: any) {
    return this.githubService.githubAppComplete(input, req.raibitSubject);
  }

  @RequirePermission('project:read')
  @Get('github/installations')
  installations(@Query('organizationId') organizationId: string, @Req() req: any) {
    return this.githubService.listGitHubInstallations(req.raibitSubject, organizationId);
  }

  @RequirePermission('team:invite')
  @Post('integrations/github')
  connect(@Body() input: Record<string, any>, @Req() req: any) {
    return this.githubService.connectGitHub(input, req.raibitSubject);
  }

  @RequirePermission('github:disconnect')
  @Post('organizations/:organizationId/integrations/github/:integrationId/disconnect')
  @HttpCode(200)
  disconnect(@Param('organizationId') organizationId: string, @Param('integrationId') integrationId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.githubService.disconnectGitHubIntegration(organizationId, integrationId, input, req.raibitSubject);
  }

  @RequirePermission('project:read')
  @Get('integrations/github')
  list(@Query('organizationId') organizationId: string, @Req() req: any) {
    return this.githubService.listGitHub(organizationId || req.raibitSubject.organizationId, req.raibitSubject);
  }

  @RequirePermission('deploy:run')
  @Post('projects/:projectId/services/:serviceId/github')
  attach(@Param('projectId') projectId: string, @Param('serviceId') serviceId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.githubService.attachGitHub(projectId, serviceId, input, req.raibitSubject);
  }

  @RequirePermission('project:read')
  @Get('github/installations/:installationId/repositories')
  repositories(@Param('installationId') installationId: string, @Query() query: Record<string, any>, @Req() req: any) {
    return this.githubService.listGitHubInstallationRepositories(installationId, query, req.raibitSubject);
  }

  @RequirePermission('github:refresh')
  @Post('github/installations/:installationId/repositories/refresh')
  @HttpCode(200)
  refreshRepositories(@Param('installationId') installationId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.githubService.refreshGitHubInstallationRepositories(installationId, input, req.raibitSubject);
  }

  @Post('github/webhooks')
  webhook(@Headers('x-github-event') event: string, @Headers('x-github-delivery') deliveryId: string, @Headers('x-hub-signature-256') signature: string, @Body() payload: Record<string, any>, @Req() req: any) {
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : JSON.stringify(payload || {});
    return this.githubService.handleGitHubWebhook({ event, deliveryId, signature, body: rawBody, payload });
  }

  @RequirePermission('deploy:run')
  @Post('github/repositories/import')
  importRepository(@Body() input: Record<string, any>, @Req() req: any) {
    return this.githubService.importGitHubRepository(input || {}, req.raibitSubject);
  }

  @RequirePermission('deploy:run')
  @Post('github/repositories/:repositoryId/sync')
  @HttpCode(202)
  syncRepository(@Param('repositoryId') repositoryId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.githubService.syncGitHubRepository(repositoryId, input || {}, req.raibitSubject);
  }
}
