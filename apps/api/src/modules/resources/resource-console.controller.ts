import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/permissions.decorator';
import { ResourcesService } from './resources.service';

@Controller('resources/:resourceId/console')
export class ResourceConsoleController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @RequirePermission('db:schema:read')
  @Get('schema')
  schema(@Param('resourceId') resourceId: string, @Query() input: Record<string, any>, @Req() req: any) {
    return this.resourcesService.resourceConsoleView(resourceId, 'schema', input || {}, req.raibitSubject);
  }

  @RequirePermission('db:schema:read')
  @Get('tables')
  tables(@Param('resourceId') resourceId: string, @Query() input: Record<string, any>, @Req() req: any) {
    return this.resourcesService.resourceConsoleView(resourceId, 'tables', input || {}, req.raibitSubject);
  }

  @RequirePermission('db:data:read')
  @Get('tables/:table')
  tableRows(@Param('resourceId') resourceId: string, @Param('table') table: string, @Query() input: Record<string, any>, @Req() req: any) {
    return this.resourcesService.resourceConsoleView(resourceId, 'table', { ...(input || {}), table }, req.raibitSubject);
  }

  @RequirePermission('db:schema:read')
  @Get('collections')
  collections(@Param('resourceId') resourceId: string, @Query() input: Record<string, any>, @Req() req: any) {
    return this.resourcesService.resourceConsoleView(resourceId, 'collections', input || {}, req.raibitSubject);
  }

  @RequirePermission('db:schema:read')
  @Get('keys')
  keys(@Param('resourceId') resourceId: string, @Query() input: Record<string, any>, @Req() req: any) {
    return this.resourcesService.resourceConsoleView(resourceId, 'keys', input || {}, req.raibitSubject);
  }

  @RequirePermission('db:data:read')
  @Post('query')
  query(@Param('resourceId') resourceId: string, @Body() input: Record<string, any>, @Query() selector: Record<string, any>, @Req() req: any) {
    return this.resourcesService.queryResource(resourceId, input || {}, req.raibitSubject, selector);
  }

  @RequirePermission('db:query:write')
  @Post('command')
  command(@Param('resourceId') resourceId: string, @Body() input: Record<string, any>, @Query() selector: Record<string, any>, @Req() req: any) {
    return this.resourcesService.commandResource(resourceId, input || {}, req.raibitSubject, selector);
  }

  @RequirePermission('db:data:read')
  @Post('browse')
  browse(@Param('resourceId') resourceId: string, @Body() input: Record<string, any>, @Query() selector: Record<string, any>, @Req() req: any) {
    return this.resourcesService.browseResource(resourceId, input || {}, req.raibitSubject, selector);
  }
}
