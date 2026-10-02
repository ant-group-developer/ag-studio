import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { createTeamSkill, deleteTeamSkill, listTeamSkills, updateTeamSkill, type TeamSkill } from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { CreateTeamSkillDto, UpdateTeamSkillDto } from './dto/team-skill.dto';

export interface TeamSkillDto {
  id: string; teamId: string; name: string; purpose: string; appliesTo: TeamSkill['applies_to']; content: string;
  enabled: boolean; position: number; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string;
}

function toDto(s: TeamSkill): TeamSkillDto {
  return {
    id: s.id, teamId: s.team_id, name: s.name, purpose: s.purpose, appliesTo: s.applies_to, content: s.content,
    enabled: s.enabled, position: s.position, createdBy: s.created_by, updatedBy: s.updated_by, createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

/** "Quy chuẩn & skill" of a team: everyone in the team reads them, producers and owners write them. */
@Controller('teams/:teamId/skills')
@UseGuards(RolesGuard)
export class TeamSkillsController {
  constructor(private readonly engine: EngineService) {}

  private requireTeam(teamId: string): void {
    if (!this.engine.db.get('SELECT id FROM teams WHERE id = ?', [teamId])) throw new NotFoundException(`Team ${teamId} not found`);
  }

  @Get()
  @Roles('viewer')
  async list(@Param('teamId') teamId: string): Promise<TeamSkillDto[]> {
    this.requireTeam(teamId);
    return listTeamSkills(this.engine.db, teamId).map(toDto);
  }

  @Post()
  @Roles('producer')
  @HttpCode(HttpStatus.CREATED)
  create(@Param('teamId') teamId: string, @Body() dto: CreateTeamSkillDto, @Req() req: Request): Promise<TeamSkillDto> {
    return mapErrors(() => {
      this.requireTeam(teamId);
      return toDto(createTeamSkill(this.engine.db, teamId, dto, req.authContext!.userId));
    });
  }

  @Patch(':skillId')
  @Roles('producer')
  update(@Param('teamId') teamId: string, @Param('skillId') skillId: string, @Body() dto: UpdateTeamSkillDto, @Req() req: Request): Promise<TeamSkillDto> {
    return mapErrors(() => toDto(updateTeamSkill(this.engine.db, teamId, skillId, dto, req.authContext!.userId)));
  }

  @Delete(':skillId')
  @Roles('producer')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('teamId') teamId: string, @Param('skillId') skillId: string): Promise<void> {
    return mapErrors(() => deleteTeamSkill(this.engine.db, teamId, skillId));
  }
}
