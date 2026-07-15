import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/permissions.decorator';
import { ProjectsService } from './projects.service';
import type { ProjectSpec } from '@raibitserver/schemas';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @RequirePermission('project:read')
  @Get()
  list(@Query() query: Record<string, any>, @Req() req: any) {
    return this.projectsService.listProjects(req.raibitSubject, query);
  }

  @RequirePermission('project:create')
  @Post()
  create(@Body() project: ProjectSpec, @Req() req: any) {
    return this.projectsService.createProject(project, req.raibitSubject);
  }

  @RequirePermission('project:read')
  @Get(':projectId/overview')
  overview(@Param('projectId') projectId: string, @Req() req: any) {
    return this.projectsService.overview(projectId, req.raibitSubject);
  }

  @RequirePermission('project:read')
  @Get(':projectId')
  get(@Param('projectId') projectId: string, @Req() req: any) {
    return this.projectsService.getProject(projectId, req.raibitSubject);
  }

  @RequirePermission('project:update')
  @Patch(':projectId')
  update(@Param('projectId') projectId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.projectsService.updateProject(projectId, input || {}, req.raibitSubject);
  }

  @RequirePermission('project:delete')
  @Delete(':projectId')
  @HttpCode(200)
  delete(@Param('projectId') projectId: string, @Req() req: any) {
    return this.projectsService.deleteProject(projectId, req.raibitSubject);
  }
}
