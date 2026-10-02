import { Module } from '@nestjs/common';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { MeController } from './me.controller';
import { TeamSkillsController } from './team-skills.controller';
import { StudioModule } from '../studio/studio.module';

@Module({
  imports: [StudioModule],
  controllers: [TeamsController, TeamSkillsController, MeController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
