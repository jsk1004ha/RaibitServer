import { Controller, Get, Query } from '@nestjs/common';
import { ProjectsService } from './projects.service';

@Controller('public/sites')
export class PublicSitesController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    return this.projectsService.listPublicSites(limit);
  }
}
