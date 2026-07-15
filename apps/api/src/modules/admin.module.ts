import { Module } from '@nestjs/common';
import { ControlPlaneModule } from '../control-plane.module';
import { AdminController, AdminOverviewController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [ControlPlaneModule],
  controllers: [AdminController, AdminOverviewController],
  providers: [AdminService],
})
export class AdminModule {}
