import { Body, Controller, Get, Inject, Param, Put, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/permissions.decorator';
import { BackupPolicyService } from './backup-policy.service';

type PolicyRequest = Readonly<{ raibitSubject: Readonly<Record<string, unknown>> }>;

@Controller('resources/:resourceId')
export class BackupPolicyController {
  constructor(@Inject(BackupPolicyService) private readonly backupPolicyService: BackupPolicyService) {}

  @RequirePermission('project:read')
  @Get('backup-policy')
  getPolicy(@Param('resourceId') resourceId: string, @Req() request: PolicyRequest) {
    return this.backupPolicyService.getPolicy(resourceId, request.raibitSubject);
  }

  @RequirePermission('project:read')
  @Put('backup-policy')
  updatePolicy(@Param('resourceId') resourceId: string, @Body() input: unknown, @Req() request: PolicyRequest) {
    return this.backupPolicyService.updatePolicy(resourceId, input, request.raibitSubject);
  }

  @RequirePermission('project:read')
  @Get('backup-runs')
  listRuns(@Param('resourceId') resourceId: string, @Query() query: Readonly<Record<string, unknown>>, @Req() request: PolicyRequest) {
    return this.backupPolicyService.listRuns(resourceId, query, request.raibitSubject);
  }
}
