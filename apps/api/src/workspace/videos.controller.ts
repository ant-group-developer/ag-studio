import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { z } from 'zod';
import {
  archiveVideo, createVideo, listVideos, postUserMessage, requireProject, requireVideo, setThreadLearning, updateVideo, VIDEO_STATUSES, videoThread,
  videoView, type VideoView,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { WorkspaceService } from './workspace.service';
import { actorRole, LearningSchema } from './threads.controller';
import { parseBody } from './zod-body';

const CreateVideoSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  /** The first message to the agent in the video's thread (what the video is about). */
  prompt: z.string().trim().min(1).max(20_000).optional(),
  /** What the video's thread learns from earlier chats; default: the project's lessons, no earlier thread. */
  learning: LearningSchema.optional(),
}).strict();
const UpdateVideoSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  status: z.enum(VIDEO_STATUSES).optional(),
}).strict();

/** Videos of a project, added one at a time (each gets `videos/<id>/` in the workspace). */
@Controller()
@UseGuards(RolesGuard)
export class VideosController {
  constructor(
    private readonly engine: EngineService,
    private readonly workspace: WorkspaceService,
  ) {}

  @Get('projects/:projectId/videos')
  @Roles('viewer')
  list(@Param('projectId') projectId: string, @Query('archived') archived?: string): Promise<{ videos: VideoView[] }> {
    return mapErrors(async () => {
      await requireProject(this.engine.db, projectId);
      return { videos: (await listVideos(this.engine.db, projectId, { archived: archived === 'true' || archived === '1' })).map(videoView) };
    });
  }

  /**
   * Body `{title?, prompt?, learning?}` — a new video with its folder and its own thread (a fresh agent session); the
   * prompt, if any, is the thread's first message. Without a title the video is "Video <n>" until someone names it.
   */
  @Post('projects/:projectId/videos')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  create(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request): Promise<VideoView & { threadId: string }> {
    return mapErrors(async () => {
      const body = parseBody(CreateVideoSchema, raw);
      const project = await requireProject(this.engine.db, projectId);
      const userId = req.authContext!.userId;
      const video = await createVideo(this.engine.db, projectId, { title: body.title ?? 'Video mới', createdBy: userId });
      const named = body.title ? video : await updateVideo(this.engine.db, video.id, { title: `Video ${video.idx}` });
      mkdirSync(join(await this.workspace.dir(projectId), 'videos', video.id), { recursive: true });
      const thread = await videoThread(this.engine.db, { projectId, videoId: video.id, title: named.title, createdBy: userId });
      if (body.learning) {
        await setThreadLearning(this.engine.db, { threadId: thread.id, useLessons: body.learning.useLessons, refs: body.learning.threads, addedBy: userId });
      }
      if (body.prompt) {
        await postUserMessage(this.engine.db, { threadId: thread.id, text: body.prompt, actor: { id: userId, role: await actorRole(this.engine, req, project.team_id) } });
      }
      return { ...videoView(named), threadId: thread.id };
    });
  }

  /** The video and its main thread (made on first use). */
  @Get('videos/:videoId')
  @Roles('viewer')
  get(@Param('videoId') videoId: string, @Req() req: Request): Promise<VideoView & { threadId: string }> {
    return mapErrors(async () => {
      const v = await requireVideo(this.engine.db, videoId);
      const thread = await videoThread(this.engine.db, { projectId: v.project_id, videoId, title: v.title, createdBy: req.authContext!.userId });
      return { ...videoView(v), threadId: thread.id };
    });
  }

  @Patch('videos/:videoId')
  @Roles('editor')
  update(@Param('videoId') videoId: string, @Body() raw: unknown): Promise<VideoView> {
    return mapErrors(async () => videoView(await updateVideo(this.engine.db, videoId, parseBody(UpdateVideoSchema, raw))));
  }

  /** Archives the video (its folder stays in the workspace). */
  @Delete('videos/:videoId')
  @Roles('producer')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(@Param('videoId') videoId: string): Promise<void> {
    return mapErrors(() => archiveVideo(this.engine.db, videoId));
  }
}
