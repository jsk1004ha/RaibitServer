import { Module } from '@nestjs/common';
import { ControlPlaneModule } from '../../control-plane.module';
import { GitHubIntegrationController } from './github.controller';
import { GitHubIntegrationService } from './github.service';
import { DISCORD_ALERTS_REPOSITORY, type DiscordAlertsRepository } from '@raibitserver/core';
import { DiscordAlertsController } from './discord.controller';
import {
  ControlPlaneDiscordProjectAccess,
  DeferredPrismaDiscordAlertsRepository,
  DISCORD_PROJECT_ACCESS,
  DiscordAlertsService,
  type DiscordProjectAccess,
} from './discord.service';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Module({
  imports: [ControlPlaneModule],
  controllers: [GitHubIntegrationController, DiscordAlertsController],
  providers: [
    GitHubIntegrationService,
    {
      provide: DISCORD_ALERTS_REPOSITORY,
      inject: [RAIBITSERVERService],
      useFactory: (controlPlane: RAIBITSERVERService): DiscordAlertsRepository =>
        new DeferredPrismaDiscordAlertsRepository(() => controlPlane.requireOperationalPrismaClient()),
    },
    {
      provide: DISCORD_PROJECT_ACCESS,
      inject: [RAIBITSERVERService],
      useFactory: (controlPlane: RAIBITSERVERService): DiscordProjectAccess => new ControlPlaneDiscordProjectAccess(controlPlane),
    },
    {
      provide: DiscordAlertsService,
      inject: [DISCORD_ALERTS_REPOSITORY, DISCORD_PROJECT_ACCESS],
      useFactory: (repository: DiscordAlertsRepository, projectAccess: DiscordProjectAccess): DiscordAlertsService => new DiscordAlertsService(repository, projectAccess),
    },
  ],
})
export class IntegrationsModule {}
