import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../auth/permissions.decorator';
import { AdminService } from './admin.service';

@Controller('admin/users')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @RequirePermission('audit:read')
  @Post(':userId/approve')
  approve(@Param('userId') userId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.adminService.approveUser(userId, input || {}, req.raibitSubject);
  }

  @RequirePermission('audit:read')
  @Post(':userId/reject')
  reject(@Param('userId') userId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.adminService.rejectUser(userId, input || {}, req.raibitSubject);
  }

  @RequirePermission('audit:read')
  @Patch(':userId/quota')
  quota(@Param('userId') userId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.adminService.setUserQuota(userId, input || {}, req.raibitSubject);
  }

  @RequirePermission('audit:read')
  @Post(':userId/quota')
  quotaPost(@Param('userId') userId: string, @Body() input: Record<string, any>, @Req() req: any) {
    return this.adminService.setUserQuota(userId, input || {}, req.raibitSubject);
  }
}

@Controller()
export class AdminOverviewController {
  constructor(private readonly adminService: AdminService) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'raibitserver-api', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @RequirePermission('audit:read')
  @Get('snapshot')
  snapshot(@Query() query: Record<string, any>, @Req() req: any) {
    return this.adminService.overview(req.raibitSubject, query);
  }
}
