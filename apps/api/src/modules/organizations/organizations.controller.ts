import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, Patch, Post, Req } from '@nestjs/common';
import { OrganizationCreateRequestSchema, OrganizationInviteAcceptSchema, OrganizationInviteCreateSchema, OrganizationMembershipRoleChangeSchema, OrganizationMembershipSnapshotSchema, type OrganizationCreateRequest, type OrganizationInviteAccept, type OrganizationInviteCreate, type OrganizationMembershipRoleChange, type OrganizationMembershipSnapshot } from '@raibitserver/schemas';
import { RequirePermission } from '../../auth/permissions.decorator';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  @RequirePermission('project:read')
  @Post()
  create(@Body() body: unknown, @Req() request: { readonly raibitSubject: Record<string, unknown> }) {
    return this.controlPlane.createOrganization(parseOrganizationCreateRequest(body), request.raibitSubject);
  }
}

function parseOrganizationCreateRequest(input: unknown): OrganizationCreateRequest {
  const result = OrganizationCreateRequestSchema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues.find((candidate) => candidate.message.startsWith('organization_route_slug_') || candidate.message === 'organization_name_invalid');
  const hasNameIssue = result.error.issues.some((candidate) => candidate.path[0] === 'name');
  const code = issue?.message || (hasNameIssue ? 'organization_name_invalid' : 'organization_creation_input_invalid');
  throw new HttpException({ statusCode: 400, message: code, code, retryable: false, terminal: true, permission: false }, 400);
}

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

@Controller('organizations/:organizationId')
export class OrganizationMembershipsController {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  @RequirePermission('project:read')
  @Get('members')
  list(@Param('organizationId') organizationId: string, @Req() request: { readonly raibitSubject: Record<string, unknown> }) {
    return this.controlPlane.listOrganizationMembers(organizationId, request.raibitSubject);
  }

  @RequirePermission('team:invite')
  @Patch('members/:membershipId')
  changeRole(@Param() path: { readonly organizationId: string; readonly membershipId: string }, @Body() body: OrganizationMembershipRoleChange, @Req() request: { readonly raibitSubject: Record<string, unknown> }) {
    return this.controlPlane.changeOrganizationMembershipRole({ ...path, ...OrganizationMembershipRoleChangeSchema.parse(body) }, request.raibitSubject);
  }

  @RequirePermission('team:invite')
  @Delete('members/:membershipId')
  remove(@Param() path: { readonly organizationId: string; readonly membershipId: string }, @Body() body: OrganizationMembershipSnapshot, @Req() request: { readonly raibitSubject: Record<string, unknown> }) {
    return this.controlPlane.removeOrganizationMember({ ...path, ...OrganizationMembershipSnapshotSchema.parse(body) }, request.raibitSubject);
  }

  @RequirePermission('project:read')
  @Post('leave')
  @HttpCode(200)
  leave(@Param('organizationId') organizationId: string, @Body() body: OrganizationMembershipSnapshot, @Req() request: { readonly raibitSubject: Record<string, unknown> }) {
    return this.controlPlane.leaveOrganization(organizationId, OrganizationMembershipSnapshotSchema.parse(body), request.raibitSubject);
  }

  @RequirePermission('team:invite')
  @Delete('invites/:inviteId')
  revokeInvite(@Param('organizationId') organizationId: string, @Param('inviteId') inviteId: string, @Req() request: { readonly raibitSubject: Record<string, unknown> }) {
    return this.controlPlane.revokeOrganizationInvite({ organizationId, inviteId }, request.raibitSubject);
  }
}
