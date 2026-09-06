import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Injectable()
export class GitHubIntegrationService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeDrain: Promise<Readonly<{ processed: number }>> | null = null;
  private lastDrainFailure: string | null = null;
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  onModuleInit() {
    const intervalMs = Math.max(250, Math.min(60_000, Number(process.env.RAIBITSERVER_PREVIEW_APPLY_INTERVAL_MS || 1_000)));
    this.timer = setInterval(() => {
      void this.drainPreviewObservations().catch(error => { this.lastDrainFailure = error instanceof Error ? error.name : 'UnknownError'; });
    }, intervalMs);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.activeDrain) await this.activeDrain;
  }

  drainPreviewObservations() {
    if (this.activeDrain) return this.activeDrain;
    const drain = this.runPreviewDrain().finally(() => { if (this.activeDrain === drain) this.activeDrain = null; });
    this.activeDrain = drain;
    return drain;
  }

  previewDrainStatus() { return { running: this.activeDrain !== null, lastFailure: this.lastDrainFailure }; }

  private async runPreviewDrain() {
    let processed = 0;
    while (processed < 10) {
      const result = await this.controlPlane.applyNextPreviewObservation({ workerId: `api-preview-${process.pid}` });
      if (!result.processed) break;
      processed += 1;
    }
    return { processed } as const;
  }

  listGitHubInstallations(subject: Record<string, any>, organizationId?: string) { return this.controlPlane.listGitHubInstallations(subject, organizationId); }
  disconnectGitHubIntegration(organizationId: string, integrationId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.disconnectGitHubIntegration(organizationId, integrationId, input, subject); }
  githubAppInstall(subject: Record<string, any>) { return this.controlPlane.githubAppInstall(subject); }
  githubAppAuthorize(input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.githubAppAuthorize(input, subject); }
  githubAppComplete(input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.githubAppComplete(input, subject); }
  connectGitHub(input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.connectGitHub(input, subject); }
  listGitHub(organizationId: string, subject: Record<string, any>) { return this.controlPlane.listGitHub(organizationId, subject); }
  attachGitHub(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.attachGitHub(projectId, serviceId, input, subject); }
  listGitHubInstallationRepositories(installationId: string, query: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.listGitHubInstallationRepositories(installationId, query, subject); }
  refreshGitHubInstallationRepositories(installationId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.refreshGitHubInstallationRepositories(installationId, input, subject); }
  handleGitHubWebhook(input: Record<string, any>) { return this.controlPlane.handleGitHubWebhook(input); }
  importGitHubRepository(input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.importGitHubRepository(input, subject); }
  syncGitHubRepository(repositoryId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.syncGitHubRepository(repositoryId, input, subject); }
}
