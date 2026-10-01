import { Module } from '@nestjs/common';
import { EngineService } from './engine.service';
import { EpisodesController } from './episodes.controller';
import { FootageAccessService } from './footage-access.service';
import { LlmLogController } from './llm-log.controller';
import { ProductionFootageController } from './production-footage.controller';
import { StudioRunController } from './studio-run.controller';
import { TimelineController } from './timeline.controller';

@Module({
  controllers: [StudioRunController, EpisodesController, TimelineController, ProductionFootageController, LlmLogController],
  providers: [EngineService, FootageAccessService],
  exports: [EngineService],
})
export class StudioModule {}
