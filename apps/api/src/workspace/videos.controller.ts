import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { z } from 'zod';
import {
  archiveVideo, createVideo, listVideos, requireProject, requireVideo, updateVideo, VIDEO_STATUSES, videoView, type VideoView,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { WorkspaceService } from './workspace.service';
import { parseBody } from './zod-body';

const CreateVideoSchema = z.object({ title: z.string().trim().min(1).max(200).optional() }).strict();
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
    return mapErrors(() => {
      requireProject(this.engine.db, projectId);
      return { videos: listVideos(this.engine.db, projectId, { archived: archived === 'true' || archived === '1' }).map(videoView) };
    });
  }

  /** Body: `{title?}` — without one the video is "Video <n>" until someone (or the agent) names it. */
  @Post('projects/:projectId/videos')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  create(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request): Promise<VideoView> {
    return mapErrors(() => {
      const body = parseBody(CreateVideoSchema, raw);
      const video = createVideo(this.engine.db, projectId, { title: body.title ?? 'Video mới', createdBy: req.authContext!.userId });
      const named = body.title ? video : updateVideo(this.engine.db, video.id, { title: `Video ${video.idx}` });
      mkdirSync(join(this.workspace.dir(projectId), 'videos', video.id), { recursive: true });
      return videoView(named);
    });
  }

  @Get('videos/:videoId')
  @Roles('viewer')
  get(@Param('videoId') videoId: string): Promise<VideoView> {
    return mapErrors(() => videoView(requireVideo(this.engine.db, videoId)));
  }

  @Patch('videos/:videoId')
  @Roles('editor')
  update(@Param('videoId') videoId: string, @Body() raw: unknown): Promise<VideoView> {
    return mapErrors(() => videoView(updateVideo(this.engine.db, videoId, parseBody(UpdateVideoSchema, raw))));
  }

  /** Archives the video (its folder stays in the workspace). */
  @Delete('videos/:videoId')
  @Roles('producer')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(@Param('videoId') videoId: string): Promise<void> {
    return mapErrors(() => archiveVideo(this.engine.db, videoId));
  }
}
