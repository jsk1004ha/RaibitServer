import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/permissions.decorator';
import { ServicesService } from './services.service';
import type { ServiceReplacementInput, ServiceSettingsMutation, ServiceSpec } from '@raibitserver/schemas';

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

  @RequirePermission('project:read')
  @Get('settings')
  settings(@Param('serviceId') serviceId: string, @Req() req: any) {
    return this.servicesService.getServiceSettings(serviceId, req.raibitSubject);
  }

  @RequirePermission('service:update')
  @Post('settings/preview')
  @HttpCode(200)
  previewSettings(@Param('serviceId') serviceId: string, @Body() input: ServiceSettingsMutation, @Req() req: any) {
    return this.servicesService.previewServiceSettings(serviceId, input, req.raibitSubject);
  }

  @RequirePermission('service:update')
  @Patch('settings')
  updateSettings(@Param('serviceId') serviceId: string, @Body() input: ServiceSettingsMutation, @Req() req: any) {
    return this.servicesService.updateServiceSettings(serviceId, input, req.raibitSubject);
  }

  @RequirePermission('service:create')
  @Post('replacements')
  createReplacement(@Param('serviceId') serviceId: string, @Body() input: ServiceReplacementInput, @Req() req: any) {
    return this.servicesService.createServiceReplacement(serviceId, input, req.raibitSubject);
  }

  @RequirePermission('project:delete')
  @Delete()
  @HttpCode(200)
  delete(@Param('serviceId') serviceId: string, @Req() req: any) {
    return this.servicesService.deleteService(serviceId, req.raibitSubject);
  }
}
