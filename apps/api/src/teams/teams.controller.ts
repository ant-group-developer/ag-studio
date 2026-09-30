import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Body,
  Req,
  Query,
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
import { AccountDirectoryService } from '../auth/account-directory.service';

@Controller('teams')
@UseGuards(RolesGuard)
export class TeamsController {
  constructor(
    private readonly teamsService: TeamsService,
    private readonly directory: AccountDirectoryService,
  ) {}

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

  /** Members with their name, email and avatar from Account API (empty when Account API has no match). */
  @Get(':teamId/members')
  @Roles('viewer')
  async listMembers(@Param('teamId') teamId: string) {
    const members = this.teamsService.listMembers(teamId);
    const people = await this.directory.summaries(members.map((m) => m.userId));
    return members.map((m) => {
      const p = people.get(m.userId);
      return { ...m, name: p?.name ?? null, email: p?.email ?? null, avatar: p?.avatar ?? null };
    });
  }

  /** People the owner can add: Account API search by name or email with the owner's own token, minus members. */
  @Get(':teamId/member-candidates')
  @Roles('owner')
  async memberCandidates(@Param('teamId') teamId: string, @Query('keyword') keyword: string | undefined, @Req() req: Request) {
    const members = new Set(this.teamsService.listMembers(teamId).map((m) => m.userId));
    const people = await this.directory.search(req.authContext!.accessToken, (keyword ?? '').slice(0, 200));
    return people.filter((p) => !members.has(p.userId));
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
