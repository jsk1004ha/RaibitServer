import { Module } from '@nestjs/common';
import { ControlPlaneModule } from '../../control-plane.module';
import { DeploymentAgentController } from './deployment-agent.controller';
import { DeploymentAgentService } from './deployment-agent.service';

@Module({
  imports: [ControlPlaneModule],
  controllers: [DeploymentAgentController],
  providers: [DeploymentAgentService],
})
export class DeploymentAgentModule {}
