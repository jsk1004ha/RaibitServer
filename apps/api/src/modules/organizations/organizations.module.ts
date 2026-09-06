import { Module } from '@nestjs/common';
import { ControlPlaneModule } from '../../control-plane.module';
import { OrganizationInviteAcceptanceController, OrganizationInvitesController, OrganizationMembershipsController } from './organizations.controller';

@Module({
  imports: [ControlPlaneModule],
  controllers: [OrganizationInvitesController, OrganizationInviteAcceptanceController, OrganizationMembershipsController],
})
export class OrganizationsModule {}
