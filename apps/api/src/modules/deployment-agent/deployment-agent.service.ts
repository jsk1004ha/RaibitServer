import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { createDeploymentAgentPlan, type DeploymentAgentPlan } from '@raibitserver/core';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Injectable()
export class DeploymentAgentService {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  async plan(projectId: string, input: Record<string, any>, subject: Record<string, any>): Promise<DeploymentAgentPlan> {
    const overview = await this.controlPlane.projectOverview(projectId, subject);
    return createDeploymentAgentPlan(overview, {
      env: process.env,
      serviceIds: normalizedServiceIds(input?.serviceIds),
    });
  }

  async apply(projectId: string, input: Record<string, any>, subject: Record<string, any>) {
    const plan = await this.plan(projectId, input || {}, subject);
    if (plan.blocked) {
      throw new ForbiddenException({
        message: 'Agent-managed deployment is blocked by security policy.',
        plan,
      });
    }
    if (!plan.canApply || !plan.deploymentOrder.length) {
      throw new BadRequestException({ message: 'The deployment plan contains no eligible services.', plan });
    }

    // Re-read and deterministically reassess immediately before mutation. The
    // external advisor cannot approve a service that changed after its review.
    const currentOverview = await this.controlPlane.projectOverview(projectId, subject);
    const verification = await createDeploymentAgentPlan(currentOverview, {
      env: {},
      serviceIds: plan.deploymentOrder,
    });
    if (verification.blocked || verification.deploymentOrder.length !== plan.deploymentOrder.length) {
      throw new ForbiddenException({
        message: 'Service configuration changed or no longer passes deployment security policy.',
        plan: verification,
      });
    }

    const deployments = [];
    for (const serviceId of plan.deploymentOrder) {
      deployments.push(await this.controlPlane.createDeployment(projectId, serviceId, deploymentInput(input), subject));
    }
    return {
      accepted: true,
      generatedBy: plan.generatedBy,
      summary: plan.summary,
      deploymentOrder: plan.deploymentOrder,
      deployments,
    };
  }
}

function normalizedServiceIds(value: any) {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.map(String).map((id) => id.trim()).filter(Boolean))].slice(0, 100);
}

function deploymentInput(input: Record<string, any>) {
  return {
    deploymentType: input.deploymentType || input.type || 'production',
    branch: input.branch,
    commitSha: input.commitSha || input.commitHash,
    triggerType: 'ai-agent',
  };
}
