import { Module } from '@nestjs/common';
import { EngineService } from './engine.service';
import { StudioOverviewController } from './studio-overview.controller';
import { MusicLibraryController } from './music-library.controller';
import { StatsController } from './stats.controller';

@Module({
  controllers: [StudioOverviewController, MusicLibraryController, StatsController],
  providers: [EngineService],
  exports: [EngineService],
})
export class StudioModule {}
