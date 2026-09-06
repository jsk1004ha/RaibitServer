import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RbacGuard } from './auth/rbac.guard';
import { ControlPlaneModule } from './control-plane.module';
import { AdminModule } from './modules/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { DeploymentsModule } from './modules/deployments/deployments.module';
import { DeploymentAgentModule } from './modules/deployment-agent/deployment-agent.module';
import { EnvironmentModule } from './modules/environment/environment.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ResourcesModule } from './modules/resources/resources.module';
import { ServicesModule } from './modules/services/services.module';
import { UsageModule } from './modules/usage.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';

@Module({
  imports: [
    ControlPlaneModule,
    AuthModule,
    ProjectsModule,
    ServicesModule,
    DeploymentsModule,
    DeploymentAgentModule,
    ResourcesModule,
    EnvironmentModule,
    IntegrationsModule,
    AdminModule,
    UsageModule,
    OrganizationsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: RbacGuard }],
})
export class AppModule {}
