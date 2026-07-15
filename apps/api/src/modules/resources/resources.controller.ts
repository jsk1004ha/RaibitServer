import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/permissions.decorator';
import { ResourcesService } from './resources.service';
import type { ResourceSpec } from '@raibitserver/schemas';

@Controller('projects/:projectId/resources')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @RequirePermission('project:read')
  @Get()
  list(@Param('projectId') projectId: string, @Query() query: Record<string, any>, @Req() req: any) {
    return this.resourcesService.listResources(projectId, req.raibitSubject, query);
  }

  @RequirePermission('db:create')
  @Post()
  create(@Param('projectId') projectId: string, @Body() resource: ResourceSpec, @Req() req: any) {
    return this.resourcesService.addResource(projectId, resource, req.raibitSubject);
  }
}

@Controller('resources/:resourceId')
export class ResourceLifecycleController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @RequirePermission('project:read')
  @Get()
  get(@Param('resourceId') resourceId: string, @Req() req: any) {
    return this.resourcesService.getResource(resourceId, req.raibitSubject);
  }

  @RequirePermission('db:create')
  @Patch()
  update(@Param('resourceId') resourceId: string, @Body() updates: Record<string, any>, @Req() req: any) {
    return this.resourcesService.updateResource(resourceId, updates, req.raibitSubject);
  }

  @RequirePermission('db:delete')
  @Delete()
  delete(@Param('resourceId') resourceId: string, @Req() req: any) {
    return this.resourcesService.deleteResource(resourceId, req.raibitSubject);
  }

  @RequirePermission('db:create')
  @Post('attach')
  attach(@Param('resourceId') resourceId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.resourcesService.attachResource(resourceId, input, req.raibitSubject);
  }

  @RequirePermission('db:create')
  @Post('provision')
  provision(@Param('resourceId') resourceId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.resourcesService.provisionResource(resourceId, input, req.raibitSubject);
  }
}
