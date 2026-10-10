import { Module } from '@nestjs/common';
import { StudioModule } from '../studio/studio.module';
import { FilesController } from './files.controller';
import { PlaybookController } from './playbook.controller';
import { ProjectsController } from './projects.controller';
import { ThreadsController } from './threads.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';

/** Projects, videos and their workspace files (spec 2026-10-10 agent-workspace). */
@Module({
  imports: [StudioModule],
  controllers: [ProjectsController, VideosController, FilesController, ThreadsController, PlaybookController],
  providers: [WorkspaceService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
