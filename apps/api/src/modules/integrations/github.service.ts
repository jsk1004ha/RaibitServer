import { Injectable } from '@nestjs/common';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Injectable()
export class GitHubIntegrationService {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  listGitHubInstallations(subject: Record<string, any>, organizationId?: string) { return this.controlPlane.listGitHubInstallations(subject, organizationId); }
  githubAppInstall(subject: Record<string, any>) { return this.controlPlane.githubAppInstall(subject); }
  githubAppAuthorize(input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.githubAppAuthorize(input, subject); }
  githubAppComplete(input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.githubAppComplete(input, subject); }
  connectGitHub(input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.connectGitHub(input, subject); }
  listGitHub(organizationId: string, subject: Record<string, any>) { return this.controlPlane.listGitHub(organizationId, subject); }
  attachGitHub(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.attachGitHub(projectId, serviceId, input, subject); }
  listGitHubInstallationRepositories(installationId: string, subject: Record<string, any>) { return this.controlPlane.listGitHubInstallationRepositories(installationId, subject); }
  handleGitHubWebhook(input: Record<string, any>) { return this.controlPlane.handleGitHubWebhook(input); }
  importGitHubRepository(input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.importGitHubRepository(input, subject); }
  syncGitHubRepository(repositoryId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.syncGitHubRepository(repositoryId, input, subject); }
}
