import { Module } from '@nestjs/common';
import { ControlPlaneModule } from '../../control-plane.module';
import { OrganizationInviteAcceptanceController, OrganizationInvitesController } from './organizations.controller';

@Module({
  imports: [ControlPlaneModule],
  controllers: [OrganizationInvitesController, OrganizationInviteAcceptanceController],
})
export class OrganizationsModule {}
