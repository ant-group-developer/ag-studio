import { Module } from '@nestjs/common';
import { EngineService } from './engine.service';
import { StudioOverviewController } from './studio-overview.controller';
import { MusicLibraryController } from './music-library.controller';

@Module({
  controllers: [StudioOverviewController, MusicLibraryController],
  providers: [EngineService],
  exports: [EngineService],
})
export class StudioModule {}
