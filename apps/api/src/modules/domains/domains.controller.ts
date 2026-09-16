import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { CustomDomainCreate, CustomDomainMutation, CustomDomainRotate } from '@raibitserver/schemas';
import { RequirePermission } from '../../auth/permissions.decorator';
import { DomainsService } from './domains.service';

@Controller()
export class DomainsController {
  constructor(private readonly domainsService: DomainsService) {}

  @RequirePermission('domain:read')
  @Get('projects/:projectId/domains')
  list(@Param('projectId') projectId: string, @Req() req: { raibitSubject: Record<string, unknown> }) {
    return this.domainsService.list(projectId, req.raibitSubject);
  }

  @RequirePermission('domain:manage')
  @Post('projects/:projectId/domains')
  create(@Param('projectId') projectId: string, @Body() input: CustomDomainCreate, @Req() req: { raibitSubject: Record<string, unknown> }) {
    return this.domainsService.create(projectId, input, req.raibitSubject);
  }

  @RequirePermission('domain:read')
  @Get('domains/:domainId')
  status(@Param('domainId') domainId: string, @Req() req: { raibitSubject: Record<string, unknown> }) {
    return this.domainsService.status(domainId, req.raibitSubject);
  }

  @RequirePermission('domain:manage')
  @Post('domains/:domainId/rotate')
  @HttpCode(202)
  rotate(@Param('domainId') domainId: string, @Body() input: CustomDomainRotate, @Req() req: { raibitSubject: Record<string, unknown> }) {
    return this.domainsService.rotate(domainId, input, req.raibitSubject);
  }

  @RequirePermission('domain:verify')
  @Post('domains/:domainId/verify')
  @HttpCode(202)
  verify(@Param('domainId') domainId: string, @Body() input: CustomDomainMutation, @Req() req: { raibitSubject: Record<string, unknown> }) {
    return this.domainsService.verify(domainId, input, req.raibitSubject);
  }

  @RequirePermission('domain:manage')
  @Delete('domains/:domainId')
  @HttpCode(202)
  delete(@Param('domainId') domainId: string, @Body() input: CustomDomainMutation, @Req() req: { raibitSubject: Record<string, unknown> }) {
    return this.domainsService.delete(domainId, input, req.raibitSubject);
  }
}
