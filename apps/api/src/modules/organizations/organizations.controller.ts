import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { OrganizationInviteAcceptSchema, OrganizationInviteCreateSchema, type OrganizationInviteAccept, type OrganizationInviteCreate } from '@raibitserver/schemas';
import { RequirePermission } from '../../auth/permissions.decorator';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Controller('organizations/:organizationId/invites')
export class OrganizationInvitesController {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  @RequirePermission('team:invite')
  @Post()
  issue(@Param('organizationId') organizationId: string, @Body() body: OrganizationInviteCreate, @Req() request: { readonly raibitSubject: Record<string, unknown> }) {
    return this.controlPlane.issueOrganizationInvite(organizationId, OrganizationInviteCreateSchema.parse(body), request.raibitSubject);
  }

  @RequirePermission('team:invite')
  @Get()
  list(@Param('organizationId') organizationId: string, @Req() request: { readonly raibitSubject: Record<string, unknown> }) {
    return this.controlPlane.listOrganizationInvites(organizationId, request.raibitSubject);
  }
}

@Controller('organization-invites')
export class OrganizationInviteAcceptanceController {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  @RequirePermission('project:read')
  @Post('accept')
  @HttpCode(200)
  accept(@Body() body: OrganizationInviteAccept, @Req() request: { readonly raibitSubject: Record<string, unknown> }) {
    return this.controlPlane.acceptOrganizationInvite(OrganizationInviteAcceptSchema.parse(body).token, request.raibitSubject);
  }
}
