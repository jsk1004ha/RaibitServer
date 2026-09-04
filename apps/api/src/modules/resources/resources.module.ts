import { Module } from '@nestjs/common';
import { ControlPlaneModule } from '../../control-plane.module';
import { ResourceConsoleController } from './resource-console.controller';
import { BackupRecoveryController, ResourceBackupsController, ResourceLifecycleController, ResourceRestoreController, ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';

@Module({
  imports: [ControlPlaneModule],
  controllers: [ResourcesController, ResourceLifecycleController, ResourceBackupsController, BackupRecoveryController, ResourceRestoreController, ResourceConsoleController],
  providers: [ResourcesService],
})
export class ResourcesModule {}
