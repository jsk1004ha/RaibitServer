import { Injectable } from '@nestjs/common';
import type { EnvironmentCreate, EnvironmentDelete, ProjectSettingsUpdate, ProjectSpec } from '@raibitserver/schemas';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Injectable()
export class ProjectsService {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  listProjects(subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.listProjects(subject, options); }
  listPublicSites(limit?: string) { return this.controlPlane.listPublicSites(limit); }
  createProject(project: ProjectSpec, subject: Record<string, any>) { return this.controlPlane.createProject(project, subject); }
  listEnvironments(projectId: string, subject: Record<string, unknown>) { return this.controlPlane.listEnvironments(projectId, subject); }
  createEnvironment(projectId: string, input: EnvironmentCreate, subject: Record<string, unknown>) { return this.controlPlane.createEnvironment(projectId, input, subject); }
  deleteEnvironment(projectId: string, environmentId: string, input: EnvironmentDelete, subject: Record<string, unknown>) { return this.controlPlane.deleteEnvironment(projectId, environmentId, input, subject); }
  getProject(projectId: string, subject: Record<string, any>) { return this.controlPlane.getProject(projectId, subject); }
  overview(projectId: string, subject: Record<string, any>, selector: Record<string, unknown> = {}) { return this.controlPlane.projectOverview(projectId, subject, selector); }
  updateProject(projectId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.updateProject(projectId, input, subject); }
  getProjectSettings(projectId: string, subject: Record<string, unknown>) { return this.controlPlane.getProjectSettings(projectId, subject); }
  updateProjectSettings(projectId: string, input: ProjectSettingsUpdate, subject: Record<string, unknown>) { return this.controlPlane.updateProjectSettings(projectId, input, subject); }
  scheduleProjectDeletion(projectId: string, subject: Record<string, unknown>) { return this.controlPlane.scheduleProjectDeletion(projectId, subject); }
  deleteProject(projectId: string, subject: Record<string, any>) { return this.controlPlane.deleteProject(projectId, subject); }
}
