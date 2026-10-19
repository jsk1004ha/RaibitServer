import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/permissions.decorator';
import { DiscordAlertsService, type DiscordSubject } from './discord.service';

type DiscordRequest = { readonly raibitSubject: DiscordSubject };

@Controller('projects/:projectId/integrations/discord')
export class DiscordAlertsController {
  private readonly discordService: DiscordAlertsService;

  constructor(discordService: DiscordAlertsService) {
    this.discordService = discordService;
  }

  @RequirePermission('notifications:read')
  @Get()
  read(@Param('projectId') projectId: string, @Req() request: DiscordRequest) {
    return this.discordService.read(projectId, request.raibitSubject);
  }

  @RequirePermission('notifications:manage')
  @Put()
  configure(@Param('projectId') projectId: string, @Body() input: unknown, @Req() request: DiscordRequest) {
    return this.discordService.configure(projectId, input, request.raibitSubject);
  }

  @RequirePermission('notifications:manage')
  @Post('disable')
  @HttpCode(200)
  disable(@Param('projectId') projectId: string, @Body() input: unknown, @Req() request: DiscordRequest) {
    return this.discordService.disable(projectId, input, request.raibitSubject);
  }

  @RequirePermission('notifications:manage')
  @Delete()
  @HttpCode(200)
  delete(@Param('projectId') projectId: string, @Body() input: unknown, @Req() request: DiscordRequest) {
    return this.discordService.delete(projectId, input, request.raibitSubject);
  }

  @RequirePermission('notifications:manage')
  @Post('test')
  @HttpCode(202)
  test(@Param('projectId') projectId: string, @Body() input: unknown, @Req() request: DiscordRequest) {
    return this.discordService.test(projectId, input, request.raibitSubject);
  }

  @RequirePermission('notifications:read')
  @Get('deliveries')
  deliveries(@Param('projectId') projectId: string, @Query() input: Readonly<Record<string, unknown>>, @Req() request: DiscordRequest) {
    return this.discordService.deliveries(projectId, input, request.raibitSubject);
  }
}
