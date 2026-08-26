import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/permissions.decorator';
import { DeploymentAgentService } from './deployment-agent.service';

@Controller('projects/:projectId/deployment-agent')
export class DeploymentAgentController {
  constructor(private readonly deploymentAgent: DeploymentAgentService) {}

  @RequirePermission('project:read')
  @Post('plan')
  plan(@Param('projectId') projectId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.deploymentAgent.plan(projectId, input || {}, req.raibitSubject);
  }

  @RequirePermission('deploy:run')
  @Post('apply')
  @HttpCode(202)
  apply(@Param('projectId') projectId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.deploymentAgent.apply(projectId, input || {}, req.raibitSubject);
  }
}
