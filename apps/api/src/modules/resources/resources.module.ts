import { Module } from '@nestjs/common';
import { PrismaBackupPolicyPersistence } from '@raibitserver/core';
import { ControlPlaneModule } from '../../control-plane.module';
import { ResourceConsoleController } from './resource-console.controller';
import { BackupPolicyController } from './backup-policy.controller';
import { BackupPolicyPersistence, BackupPolicyService, DeferredBackupPolicyPersistence } from './backup-policy.service';
import { BackupRecoveryController, ResourceBackupsController, ResourceLifecycleController, ResourceRestoreController, ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Module({
  imports: [ControlPlaneModule],
  controllers: [ResourcesController, ResourceLifecycleController, ResourceBackupsController, BackupRecoveryController, ResourceRestoreController, ResourceConsoleController, BackupPolicyController],
  providers: [ResourcesService, BackupPolicyService, {
    provide: BackupPolicyPersistence,
    inject: [RAIBITSERVERService],
    useFactory: (controlPlane: RAIBITSERVERService) => new DeferredBackupPolicyPersistence(async () => new PrismaBackupPolicyPersistence(await controlPlane.requireOperationalPrismaClient())),
  }],
})
export class ResourcesModule {}
