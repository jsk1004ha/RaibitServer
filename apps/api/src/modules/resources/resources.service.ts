import { Injectable } from '@nestjs/common';
import type { ResourceBackupCreate, ResourceBackupDelete, ResourceRestoreCreate, ResourceSpec } from '@raibitserver/schemas';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Injectable()
export class ResourcesService {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  listResources(projectId: string, subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.listResources(projectId, subject, options); }
  addResource(projectId: string, resource: ResourceSpec, subject: Record<string, any>) { return this.controlPlane.addResource(projectId, resource, subject); }
  getResource(resourceId: string, subject: Record<string, any>) { return this.controlPlane.getResource(resourceId, subject); }
  updateResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.updateResource(resourceId, input, subject); }
  deleteResource(resourceId: string, subject: Record<string, any>) { return this.controlPlane.deleteResource(resourceId, subject); }
  attachResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.attachResource(resourceId, input, subject); }
  provisionResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.provisionResource(resourceId, input, subject); }
  createResourceBackup(resourceId: string, input: ResourceBackupCreate, subject: Record<string, any>) { return this.controlPlane.createResourceBackup(resourceId, input, subject); }
  listResourceBackups(resourceId: string, input: Record<string, unknown>, subject: Record<string, any>) { return this.controlPlane.listResourceBackups(resourceId, input, subject); }
  deleteResourceBackup(backupId: string, input: ResourceBackupDelete, subject: Record<string, any>) { return this.controlPlane.deleteResourceBackup(backupId, input, subject); }
  createBackupRestore(backupId: string, input: ResourceRestoreCreate, subject: Record<string, any>) { return this.controlPlane.createBackupRestore(backupId, input, subject); }
  getRecoveryRestore(restoreId: string, subject: Record<string, any>) { return this.controlPlane.getRecoveryRestore(restoreId, subject); }
  resourceConsoleView(resourceId: string, view: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.resourceConsoleView(resourceId, view, input, subject); }
  queryResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.queryResource(resourceId, input, subject); }
  commandResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.commandResource(resourceId, input, subject); }
  browseResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.browseResource(resourceId, input, subject); }
}
