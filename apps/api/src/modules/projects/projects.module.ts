import { Module } from '@nestjs/common';
import { ControlPlaneModule } from '../../control-plane.module';
import { ProjectsController } from './projects.controller';
import { PublicSitesController } from './public-sites.controller';
import { ProjectsService } from './projects.service';
import { ProjectEnvironmentsController } from './environments.controller';

@Module({
  imports: [ControlPlaneModule],
  controllers: [ProjectsController, ProjectEnvironmentsController, PublicSitesController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
