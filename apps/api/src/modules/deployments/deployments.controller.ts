import { Body, Controller, Get, HttpCode, HttpException, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { clearObservationProjectionContinuation, createObservationProjectionContinuation, encodeDeploymentActivityResumeToken, encodeServiceLogResumeToken, startBoundedSseStream } from '@raibitserver/core';
import { RequirePermission } from '../../auth/permissions.decorator';
import { DeploymentsService } from './deployments.service';

@Controller('projects/:projectId/services/:serviceId/deployments')
export class DeploymentsController {
  constructor(private readonly deploymentsService: DeploymentsService) {}

  @RequirePermission('project:read')
  @Get()
  list(@Param('projectId') projectId: string, @Param('serviceId') serviceId: string, @Query() query: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.listDeployments(projectId, serviceId, req.raibitSubject, query);
  }

  @RequirePermission('deploy:run')
  @Post()
  @HttpCode(202)
  create(@Param('projectId') projectId: string, @Param('serviceId') serviceId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.createDeployment(projectId, serviceId, input || {}, req.raibitSubject);
  }
}

@Controller('services/:serviceId/deployments')
export class ServiceDeploymentsController {
  constructor(private readonly deploymentsService: DeploymentsService) {}

  @RequirePermission('project:read')
  @Get()
  list(@Param('serviceId') serviceId: string, @Query() query: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.listDeploymentsForService(serviceId, req.raibitSubject, query);
  }

  @RequirePermission('deploy:run')
  @Post()
  @HttpCode(202)
  create(@Param('serviceId') serviceId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.createDeploymentForService(serviceId, input || {}, req.raibitSubject);
  }
}

@Controller()
export class DeploymentLogsController {
  constructor(private readonly deploymentsService: DeploymentsService) {}

  @RequirePermission('deploy:run')
  @Post('deployments/:deploymentId/retry')
  @HttpCode(202)
  retry(@Param('deploymentId') deploymentId: string, @Body() input: unknown, @Req() req: { readonly raibitSubject: { readonly id: string } }) {
    return this.deploymentsService.createDeploymentOperation({ operation: 'retry', id: deploymentId }, input, req.raibitSubject);
  }

  @RequirePermission('deploy:run')
  @Post('services/:serviceId/redeploy')
  @HttpCode(202)
  redeploy(@Param('serviceId') serviceId: string, @Body() input: unknown, @Req() req: { readonly raibitSubject: { readonly id: string } }) {
    return this.deploymentsService.createDeploymentOperation({ operation: 'redeploy', id: serviceId }, input, req.raibitSubject);
  }

  @RequirePermission('project:read')
  @Get('deployments/:deploymentId')
  get(@Param('deploymentId') deploymentId: string, @Req() req: any) {
    return this.deploymentsService.getDeployment(deploymentId, req.raibitSubject);
  }

  @RequirePermission('deploy:run')
  @Patch('deployments/:deploymentId/status')
  statusPatch(@Param('deploymentId') deploymentId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.updateDeploymentStatus(deploymentId, input || {}, req.raibitSubject);
  }

  @RequirePermission('deploy:run')
  @Post('deployments/:deploymentId/status')
  statusPost(@Param('deploymentId') deploymentId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.updateDeploymentStatus(deploymentId, input || {}, req.raibitSubject);
  }

  @RequirePermission('deploy:run')
  @Post('deployments/:deploymentId/cancel')
  @HttpCode(200)
  cancel(@Param('deploymentId') deploymentId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.cancelDeployment(deploymentId, input || {}, req.raibitSubject);
  }

  @RequirePermission('deploy:run')
  @Post('deployments/:deploymentId/rollback')
  @HttpCode(202)
  rollback(@Param('deploymentId') deploymentId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.rollbackDeployment(deploymentId, input || {}, req.raibitSubject);
  }

  @RequirePermission('deploy:run')
  @Post('deployments/:deploymentId/preview-cleanup')
  @HttpCode(202)
  previewCleanup(@Param('deploymentId') deploymentId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.requestPreviewCleanup(deploymentId, input || {}, req.raibitSubject);
  }

  @RequirePermission('logs:read')
  @Get('deployments/:deploymentId/logs')
  logs(@Param('deploymentId') deploymentId: string, @Query() query: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.listDeploymentLogs(deploymentId, req.raibitSubject, query);
  }

  @RequirePermission('logs:read')
  @Get('deployments/:deploymentId/events')
  events(@Param('deploymentId') deploymentId: string, @Query() query: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.listDeploymentEvents(deploymentId, req.raibitSubject, query);
  }

  @RequirePermission('logs:read')
  @Get('deployments/:deploymentId/stream')
  async deploymentStream(@Param('deploymentId') deploymentId: string, @Req() req: any, @Res() res: any) {
    const continuation = createObservationProjectionContinuation();
    const { snapshot, resumeScope } = await this.deploymentsService.openDeploymentActivityStream(deploymentId, req.raibitSubject, {
      lastEventId: req.headers?.['last-event-id'],
      observationContinuation: continuation,
    });
    startBoundedSseStream({
      req,
      res,
      event: 'deployment.snapshot',
      initialPayload: snapshot,
      preprojected: true,
      eventId: (payload) => encodeDeploymentActivityResumeToken(resumeScope, payload),
      terminalError: (error) => error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500,
      onClose: () => clearObservationProjectionContinuation(continuation),
      load: (cursors) => this.deploymentsService.deploymentActivitySnapshot(deploymentId, req.raibitSubject, {
        deploymentCursor: cursors.deploymentCursor,
        logCursor: cursors.logCursor,
        eventCursor: cursors.eventCursor,
        observationContinuation: continuation,
      }),
    });
  }

  @RequirePermission('logs:read')
  @Get('services/:serviceId/logs')
  runtime(@Param('serviceId') serviceId: string, @Query() query: Record<string, any>, @Req() req: any) {
    return this.deploymentsService.listRuntimeLogs(serviceId, req.raibitSubject, query);
  }

  @RequirePermission('logs:read')
  @Get('services/:serviceId/logs/stream')
  async runtimeStream(@Param('serviceId') serviceId: string, @Req() req: any, @Res() res: any) {
    const continuation = createObservationProjectionContinuation();
    const { snapshot, resumeScope } = await this.deploymentsService.openServiceLogStream(serviceId, req.raibitSubject, {
      lastEventId: req.headers?.['last-event-id'],
      observationContinuation: continuation,
    });
    startBoundedSseStream({
      req,
      res,
      event: 'service.logs.snapshot',
      initialPayload: snapshot,
      preprojected: true,
      eventId: (payload) => encodeServiceLogResumeToken(resumeScope, payload),
      terminalError: (error) => error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500,
      onClose: () => clearObservationProjectionContinuation(continuation),
      load: (cursors) => this.deploymentsService.serviceLogSnapshot(serviceId, req.raibitSubject, {
        serviceCursor: cursors.serviceCursor,
        logCursor: cursors.logCursor,
        observationContinuation: continuation,
      }),
    });
  }
}
