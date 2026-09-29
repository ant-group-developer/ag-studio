import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import { TeamsService } from './teams.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('teams')
@UseGuards(RolesGuard)
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Post()
  createTeam(@Body() dto: CreateTeamDto, @Req() req: Request) {
    const userId = req.authContext!.userId;
    return this.teamsService.createTeam(dto.name, userId);
  }

  @Get()
  listTeams(@Req() req: Request) {
    const userId = req.authContext!.userId;
    return this.teamsService.listTeams(userId);
  }

  @Get(':teamId/members')
  listMembers(@Param('teamId') teamId: string) {
    return this.teamsService.listMembers(teamId);
  }

  @Post(':teamId/members')
  @Roles('owner')
  @HttpCode(HttpStatus.CREATED)
  addMember(@Param('teamId') teamId: string, @Body() dto: AddMemberDto) {
    this.teamsService.addMember(teamId, dto.userId, dto.role as 'owner' | 'producer' | 'editor' | 'viewer');
    return { ok: true };
  }

  @Delete(':teamId/members/:userId')
  @Roles('owner')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeMember(@Param('teamId') teamId: string, @Param('userId') userId: string) {
    this.teamsService.removeMember(teamId, userId);
  }

  @Patch(':teamId/members/:userId')
  @Roles('owner')
  updateMemberRole(
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    this.teamsService.updateMemberRole(teamId, userId, dto.role as 'owner' | 'producer' | 'editor' | 'viewer');
    return { ok: true };
  }
}
