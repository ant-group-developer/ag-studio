import { Module } from '@nestjs/common';
import { EngineService } from './engine.service';
import { EpisodesController } from './episodes.controller';
import { FootageAccessService } from './footage-access.service';
import { LlmLogController } from './llm-log.controller';
import { ProductionDocsController } from './production-docs.controller';
import { ProductionFootageController } from './production-footage.controller';
import { StudioRunController } from './studio-run.controller';
import { ThumbnailWorkService } from './thumbnail-work.service';
import { ThumbnailsController } from './thumbnails.controller';
import { TimelineController } from './timeline.controller';

@Module({
  controllers: [
    StudioRunController, EpisodesController, ThumbnailsController, TimelineController, ProductionFootageController, ProductionDocsController,
    LlmLogController,
  ],
  providers: [EngineService, FootageAccessService, ThumbnailWorkService],
  exports: [EngineService],
})
export class StudioModule {}
