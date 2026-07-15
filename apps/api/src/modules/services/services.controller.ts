import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/permissions.decorator';
import { ServicesService } from './services.service';
import type { ServiceSpec } from '@raibitserver/schemas';

@Controller('projects/:projectId/services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @RequirePermission('project:read')
  @Get()
  list(@Param('projectId') projectId: string, @Query() query: Record<string, any>, @Req() req: any) {
    return this.servicesService.listServices(projectId, req.raibitSubject, query);
  }

  @RequirePermission('service:create')
  @Post()
  create(@Param('projectId') projectId: string, @Body() service: ServiceSpec, @Req() req: any) {
    return this.servicesService.addService(projectId, service, req.raibitSubject);
  }
}

@Controller('services/:serviceId')
export class ServiceDetailController {
  constructor(private readonly servicesService: ServicesService) {}

  @RequirePermission('project:read')
  @Get()
  get(@Param('serviceId') serviceId: string, @Req() req: any) {
    return this.servicesService.getService(serviceId, req.raibitSubject);
  }

  @RequirePermission('service:update')
  @Patch()
  update(@Param('serviceId') serviceId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.servicesService.updateService(serviceId, input || {}, req.raibitSubject);
  }

  @RequirePermission('project:delete')
  @Delete()
  @HttpCode(200)
  delete(@Param('serviceId') serviceId: string, @Req() req: any) {
    return this.servicesService.deleteService(serviceId, req.raibitSubject);
  }
}
