import { Injectable } from '@nestjs/common';
import type { ServiceReplacementInput, ServiceSettingsMutation, ServiceSpec } from '@raibitserver/schemas';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Injectable()
export class ServicesService {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  listServices(projectId: string, subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.listServices(projectId, subject, options); }
  addService(projectId: string, service: ServiceSpec, subject: Record<string, any>) { return this.controlPlane.addService(projectId, service, subject); }
  getService(serviceId: string, subject: Record<string, any>) { return this.controlPlane.getService(serviceId, subject); }
  updateService(serviceId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.updateService(serviceId, input, subject); }
  getServiceSettings(serviceId: string, subject: Record<string, any>) { return this.controlPlane.getServiceSettings(serviceId, subject); }
  previewServiceSettings(serviceId: string, input: ServiceSettingsMutation, subject: Record<string, any>) { return this.controlPlane.previewServiceSettings(serviceId, input, subject); }
  updateServiceSettings(serviceId: string, input: ServiceSettingsMutation, subject: Record<string, any>) { return this.controlPlane.updateServiceSettings(serviceId, input, subject); }
  createServiceReplacement(serviceId: string, input: ServiceReplacementInput, subject: Record<string, any>) { return this.controlPlane.createServiceReplacement(serviceId, input, subject); }
  deleteService(serviceId: string, subject: Record<string, any>) { return this.controlPlane.deleteService(serviceId, subject); }
}
