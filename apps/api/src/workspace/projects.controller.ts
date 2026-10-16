import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  archiveProject, createProject, CreateProjectSchema, createThread, listProjects, listVideos, projectView, requireProject, scanWorkspace, seedWorkspace,
  updateProject, UpdateProjectSchema, videoView, type ProjectView, type VideoView,
} from '@ag-studio/engine';
import { AccountDirectoryService, unknownPerson, type UserSummary } from '../auth/account-directory.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { WorkspaceService } from './workspace.service';
import { parseBody } from './zod-body';

/** A project as the team's list shows it: who made it (name and avatar from the Account API), its videos, when touched. */
type ProjectListItem = ProjectView & { videoCount: number; lastActivityAt: string; creator: UserSummary };

/**
 * A team's projects — one YouTube channel each (spec 2026-10-10 agent-workspace). Creating one also makes its
 * workspace folder (CLAUDE.md about the channel, lessons, folders), versioned as written by Studio.
 */
@Controller()
@UseGuards(RolesGuard)
export class ProjectsController {
  constructor(
    private readonly engine: EngineService,
    private readonly workspace: WorkspaceService,
    private readonly directory: AccountDirectoryService,
  ) {}

  @Get('teams/:teamId/projects')
  @Roles('viewer')
  async list(@Param('teamId') teamId: string, @Query('archived') archived?: string): Promise<{ projects: ProjectListItem[] }> {
    const rows = await listProjects(this.engine.db, teamId, { archived: archived === 'true' || archived === '1' });
    const people = await this.directory.summaries(rows.map((r) => r.created_by));
    return {
      projects: rows.map((r) => ({
        ...projectView(r), videoCount: r.video_count, lastActivityAt: r.last_activity_at, creator: people.get(r.created_by) ?? unknownPerson(r.created_by),
      })),
    };
  }

  /** Body: `{name, channelUrl?, description?, language?, aspect?}`. */
  @Post('teams/:teamId/projects')
  @Roles('producer')
  @HttpCode(HttpStatus.CREATED)
  create(@Param('teamId') teamId: string, @Body() raw: unknown, @Req() req: Request): Promise<ProjectView> {
    return mapErrors(async () => {
      const body = parseBody(CreateProjectSchema, raw);
      const now = new Date().toISOString();
      const project = await createProject(this.engine.db, teamId, body, req.authContext!.userId, now);
      const dir = seedWorkspace(this.workspace.root, project, now);
      await scanWorkspace(this.engine.db, { projectId: project.id, dir, author: { kind: 'studio', id: null }, now });
      await createThread(this.engine.db, { projectId: project.id, kind: 'project', title: 'Kênh', createdBy: req.authContext!.userId }, now);
      return projectView(project);
    });
  }

  @Get('projects/:projectId')
  @Roles('viewer')
  get(@Param('projectId') projectId: string): Promise<ProjectView & { videos: VideoView[] }> {
    return mapErrors(async () => {
      const project = await requireProject(this.engine.db, projectId);
      return { ...projectView(project), videos: (await listVideos(this.engine.db, projectId)).map(videoView) };
    });
  }

  /** Body: any of `{name, channelUrl, description, language, aspect, settings}`. */
  @Patch('projects/:projectId')
  @Roles('producer')
  update(@Param('projectId') projectId: string, @Body() raw: unknown): Promise<ProjectView> {
    return mapErrors(async () => projectView(await updateProject(this.engine.db, projectId, parseBody(UpdateProjectSchema, raw))));
  }

  /** Archives the project (its videos and files stay; it leaves the team's list). */
  @Delete('projects/:projectId')
  @Roles('owner')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(@Param('projectId') projectId: string): Promise<void> {
    return mapErrors(() => archiveProject(this.engine.db, projectId));
  }
}
