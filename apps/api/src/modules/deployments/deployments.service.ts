import { Injectable } from '@nestjs/common';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Injectable()
export class DeploymentsService {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  createDeploymentOperation(target: { readonly operation: 'retry' | 'redeploy'; readonly id: string }, input: unknown, subject: { readonly id: string }) { return this.controlPlane.createDeploymentOperation(target, input, subject); }
  listDeploymentHistory(projectId: string, query: Record<string, unknown>, subject: Record<string, unknown>) { return this.controlPlane.listDeploymentHistory(projectId, query, subject); }

  listDeployments(projectId: string, serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.listDeployments(projectId, serviceId, subject, options); }
  createDeployment(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.createDeployment(projectId, serviceId, input, subject); }
  listDeploymentsForService(serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.listDeploymentsForService(serviceId, subject, options); }
  createDeploymentForService(serviceId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.createDeploymentForService(serviceId, input, subject); }
  getDeployment(deploymentId: string, subject: Record<string, any>) { return this.controlPlane.getDeployment(deploymentId, subject); }
  updateDeploymentStatus(deploymentId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.updateDeploymentStatus(deploymentId, input, subject); }
  cancelDeployment(deploymentId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.cancelDeployment(deploymentId, input, subject); }
  rollbackDeployment(deploymentId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.rollbackDeployment(deploymentId, input, subject); }
  requestPreviewCleanup(deploymentId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.requestPreviewCleanup(deploymentId, input, subject); }
  listDeploymentLogs(deploymentId: string, subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.listDeploymentLogs(deploymentId, subject, options); }
  listDeploymentEvents(deploymentId: string, subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.listDeploymentEvents(deploymentId, subject, options); }
  deploymentActivitySnapshot(deploymentId: string, subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.deploymentActivitySnapshot(deploymentId, subject, options); }
  openDeploymentActivityStream(deploymentId: string, subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.openDeploymentActivityStream(deploymentId, subject, options); }
  listRuntimeLogs(serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.listRuntimeLogs(serviceId, subject, options); }
  serviceLogSnapshot(serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.serviceLogSnapshot(serviceId, subject, options); }
  openServiceLogStream(serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.openServiceLogStream(serviceId, subject, options); }
}
