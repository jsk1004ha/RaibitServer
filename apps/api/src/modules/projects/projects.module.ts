import { Module } from '@nestjs/common';
import { ControlPlaneModule } from '../../control-plane.module';
import { ProjectsController } from './projects.controller';
import { PublicSitesController } from './public-sites.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [ControlPlaneModule],
  controllers: [ProjectsController, PublicSitesController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
