import { Module } from '@nestjs/common';
import { StudioModule } from '../studio/studio.module';
import { FilesController } from './files.controller';
import { InputsController } from './inputs.controller';
import { ResearchController } from './research.controller';
import { ActionsController } from './actions.controller';
import { VideoMediaController } from './video-media.controller';
import { PlaybookController } from './playbook.controller';
import { ProjectsController } from './projects.controller';
import { ThreadsController } from './threads.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';
import { ProjectFootageService } from './project-footage.service';

/** Projects, videos and their workspace files (spec 2026-10-10 agent-workspace). */
@Module({
  imports: [StudioModule],
  controllers: [ProjectsController, VideosController, FilesController, ThreadsController, PlaybookController, InputsController, ResearchController, ActionsController, VideoMediaController],
  providers: [WorkspaceService, ProjectFootageService],
  exports: [WorkspaceService, ProjectFootageService],
})
export class WorkspaceModule {}
