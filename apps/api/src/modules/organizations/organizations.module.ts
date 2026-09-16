import { Module } from '@nestjs/common';
import { ControlPlaneModule } from '../../control-plane.module';
import { OrganizationInviteAcceptanceController, OrganizationInvitesController, OrganizationMembershipsController, OrganizationsController } from './organizations.controller';

@Module({
  imports: [ControlPlaneModule],
  controllers: [OrganizationsController, OrganizationInvitesController, OrganizationInviteAcceptanceController, OrganizationMembershipsController],
})
export class OrganizationsModule {}
