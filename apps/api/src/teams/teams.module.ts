import { Module } from '@nestjs/common';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { MeController } from './me.controller';

@Module({
  controllers: [TeamsController, MeController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
