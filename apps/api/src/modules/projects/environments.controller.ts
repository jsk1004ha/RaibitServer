import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { EnvironmentCreate, EnvironmentDelete } from '@raibitserver/schemas';
import { RequirePermission } from '../../auth/permissions.decorator';
import { ProjectsService } from './projects.service';

@Controller('projects/:projectId/environments')
export class ProjectEnvironmentsController {
  constructor(private readonly projects: ProjectsService) {}

  @RequirePermission('project:read')
  @Get()
  list(@Param('projectId') projectId: string, @Req() req: Record<string, unknown>) {
    return this.projects.listEnvironments(projectId, requestSubject(req));
  }

  @RequirePermission('environment:manage')
  @Post()
  create(@Param('projectId') projectId: string, @Body() input: EnvironmentCreate, @Req() req: Record<string, unknown>) {
    return this.projects.createEnvironment(projectId, input, requestSubject(req));
  }

  @RequirePermission('environment:manage')
  @Delete(':environmentId')
  @HttpCode(200)
  delete(@Param('projectId') projectId: string, @Param('environmentId') environmentId: string, @Body() input: EnvironmentDelete, @Req() req: Record<string, unknown>) {
    return this.projects.deleteEnvironment(projectId, environmentId, input, requestSubject(req));
  }
}

function requestSubject(request: Record<string, unknown>): Record<string, unknown> {
  const subject = request.raibitSubject;
  return typeof subject === 'object' && subject !== null && !Array.isArray(subject) ? Object.fromEntries(Object.entries(subject)) : {};
}
