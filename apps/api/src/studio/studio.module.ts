import { Module } from '@nestjs/common';
import { EngineService } from './engine.service';
import { FootageAccessService } from './footage-access.service';
import { StudioRunController } from './studio-run.controller';
import { TimelineController } from './timeline.controller';

@Module({
  controllers: [StudioRunController, TimelineController],
  providers: [EngineService, FootageAccessService],
  exports: [EngineService],
})
export class StudioModule {}
