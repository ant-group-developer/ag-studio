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
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Request } from 'express';
import { TeamsService } from './teams.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AccountDirectoryService } from '../auth/account-directory.service';

class ListTeamsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsIn(['name', 'createdAt'])
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

class ListMembersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsIn(['role', 'joinedAt', 'name'])
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

class UpdateTeamDto {
  @IsString()
  @MaxLength(200)
  name!: string;
}

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

  /** Paged list of teams visible to the caller (admins see all). */
  @Get()
  listTeams(@Query() query: ListTeamsQueryDto, @Req() req: Request) {
    const { userId, isAdmin } = req.authContext!;
    return this.teamsService.listTeamsPaged(userId, isAdmin ?? false, query);
  }

  /** One team: name, the caller's role and counts (the team page header). */
  @Get(':teamId')
  @Roles('viewer')
  getTeam(@Param('teamId') teamId: string, @Req() req: Request) {
    return this.teamsService.getTeam(teamId, req.authContext!.userId);
  }

  @Patch(':teamId')
  @Roles('owner')
  updateTeam(@Param('teamId') teamId: string, @Body() dto: UpdateTeamDto) {
    return this.teamsService.updateTeam(teamId, dto.name);
  }

  @Delete(':teamId')
  @Roles('owner')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteTeam(@Param('teamId') teamId: string) {
    this.teamsService.deleteTeam(teamId);
  }

  /** Paged members list with name/email/avatar from Account API. */
  @Get(':teamId/members')
  @Roles('viewer')
  async listMembers(@Param('teamId') teamId: string, @Query() query: ListMembersQueryDto) {
    const paged = this.teamsService.listMembersPaged(teamId, query);
    const people = await this.directory.summaries(paged.items.map((m) => m.userId));
    return {
      ...paged,
      items: paged.items.map((m) => {
        const p = people.get(m.userId);
        return { ...m, name: p?.name ?? null, email: p?.email ?? null, avatar: p?.avatar ?? null };
      }),
    };
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
