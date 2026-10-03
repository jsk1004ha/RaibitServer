import { Module } from '@nestjs/common';
import { ControlPlaneModule } from '../../control-plane.module';
import { ProjectsController } from './projects.controller';
import { PublicSitesController } from './public-sites.controller';
import { ProjectsService } from './projects.service';
import { ProjectEnvironmentsController } from './environments.controller';
import { ProjectTemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  imports: [ControlPlaneModule],
  controllers: [ProjectsController, ProjectEnvironmentsController, PublicSitesController, ProjectTemplatesController],
  providers: [ProjectsService, TemplatesService],
})
export class ProjectsModule {}
