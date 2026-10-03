import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/permissions.decorator';
import { ResourcesService } from './resources.service';
import type { ResourceBackupCreate, ResourceBackupDelete, ResourceRestoreCreate, ResourceSpec } from '@raibitserver/schemas';

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
  get(@Param('resourceId') resourceId: string, @Query() query: Record<string, any>, @Req() req: any) {
    return this.resourcesService.getResource(resourceId, req.raibitSubject, query);
  }

  @RequirePermission('db:create')
  @Patch()
  update(@Param('resourceId') resourceId: string, @Body() updates: Record<string, any>, @Query() query: Record<string, any>, @Req() req: any) {
    return this.resourcesService.updateResource(resourceId, updates, req.raibitSubject, query);
  }

  @RequirePermission('db:delete')
  @Delete()
  delete(@Param('resourceId') resourceId: string, @Query() query: Record<string, any>, @Req() req: any) {
    return this.resourcesService.deleteResource(resourceId, req.raibitSubject, query);
  }

  @RequirePermission('db:create')
  @Post('attach')
  attach(@Param('resourceId') resourceId: string, @Body() input: Record<string, any>, @Query() query: Record<string, any>, @Req() req: any) {
    return this.resourcesService.attachResource(resourceId, input, req.raibitSubject, query);
  }

  @RequirePermission('db:create')
  @Post('provision')
  provision(@Param('resourceId') resourceId: string, @Body() input: Record<string, any>, @Query() query: Record<string, any>, @Req() req: any) {
    return this.resourcesService.provisionResource(resourceId, input, req.raibitSubject, query);
  }
}

@Controller('resources/:resourceId/backups')
export class ResourceBackupsController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @RequirePermission('backup:manage')
  @Post()
  @HttpCode(202)
  create(@Param('resourceId') resourceId: string, @Body() input: ResourceBackupCreate, @Query() query: Record<string, any>, @Req() req: any) {
    return this.resourcesService.createResourceBackup(resourceId, input, req.raibitSubject, query);
  }

  @RequirePermission('backup:manage')
  @Get()
  list(@Param('resourceId') resourceId: string, @Query() input: Record<string, unknown>, @Req() req: any) {
    const { environmentId, environment, environmentKind, ...pagination } = input;
    return this.resourcesService.listResourceBackups(resourceId, pagination, req.raibitSubject, { environmentId, environment, environmentKind });
  }
}

@Controller('backups/:backupId')
export class BackupRecoveryController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @RequirePermission('backup:manage')
  @Delete()
  @HttpCode(200)
  delete(@Param('backupId') backupId: string, @Body() input: ResourceBackupDelete, @Query() query: Record<string, any>, @Req() req: any) {
    return this.resourcesService.deleteResourceBackup(backupId, input, req.raibitSubject, query);
  }

  @RequirePermission('backup:restore')
  @Post('restores')
  @HttpCode(202)
  createRestore(@Param('backupId') backupId: string, @Body() input: ResourceRestoreCreate, @Query() query: Record<string, any>, @Req() req: any) {
    return this.resourcesService.createBackupRestore(backupId, input, req.raibitSubject, query);
  }
}

@Controller('restores/:restoreId')
export class ResourceRestoreController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @RequirePermission('backup:restore')
  @Get()
  get(@Param('restoreId') restoreId: string, @Query() query: Record<string, any>, @Req() req: any) {
    return this.resourcesService.getRecoveryRestore(restoreId, req.raibitSubject, query);
  }
}
