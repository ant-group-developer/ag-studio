import { Module } from '@nestjs/common';
import { CanvaController } from '../canva/canva.controller';
import { CanvaService } from '../canva/canva.service';
import { ChatController, ChatFolders } from './chat.controller';
import { EngineService } from './engine.service';
import { EpisodesController } from './episodes.controller';
import { FootageAccessService } from './footage-access.service';
import { LlmLogController } from './llm-log.controller';
import { ProductionAudioController } from './production-audio.controller';
import { ProductionDocsController } from './production-docs.controller';
import { StepDocsController } from './step-docs.controller';
import { ProductionFootageController } from './production-footage.controller';
import { StudioOverviewController } from './studio-overview.controller';
import { StudioRunController } from './studio-run.controller';
import { ThumbnailWorkService } from './thumbnail-work.service';
import { ThumbnailsController } from './thumbnails.controller';
import { TimelineController } from './timeline.controller';

@Module({
  controllers: [
    StudioRunController, EpisodesController, ThumbnailsController, TimelineController, ProductionFootageController, ProductionDocsController, StepDocsController,
    LlmLogController, CanvaController, ChatController, StudioOverviewController, ProductionAudioController,
  ],
  providers: [EngineService, FootageAccessService, ThumbnailWorkService, CanvaService, ChatFolders],
  exports: [EngineService],
})
export class StudioModule {}
