import { Injectable } from '@nestjs/common';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Injectable()
export class EnvironmentService {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  listEnvironment(projectId: string, serviceId: string, subject: Record<string, any>, selector: Record<string, any> = {}) { return this.controlPlane.listEnvironment(projectId, serviceId, subject, selector); }
  upsertEnvironment(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) { return this.controlPlane.upsertEnvironment(projectId, serviceId, input, subject, selector); }
  importEnvironmentFile(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) { return this.controlPlane.importEnvironmentFile(projectId, serviceId, input, subject, selector); }
}
