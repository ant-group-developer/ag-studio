import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  LOOK_CHOICES, parseOwnLook, projectLookView, requireProject, requireVideo, setProjectLook, setVideoOwnLook, videoLookToTimeline, videoLookView,
  type VideoLookView,
} from '@ag-studio/engine';
import { z } from 'zod';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { WorkspaceService } from './workspace.service';

export type VideoLookResponse = VideoLookView & { choices: typeof LOOK_CHOICES; revision: number | null };
export type ProjectLookResponse = Awaited<ReturnType<typeof projectLookView>> & {
  choices: typeof LOOK_CHOICES;
  /** After a save: the videos whose own pick was cleared ("apply to all") and how many timelines took it. */
  cleared?: string[]; timelines?: number;
};

/** `everyVideo`: apply to all videos (their own picks are cleared); otherwise a video with its own pick keeps it. */
const ProjectLookSchema = z.object({ everyVideo: z.boolean().optional() }).passthrough();

/**
 * A video's words and picture (plan 2026-10-28 P3): the font and colours of the text on screen, the colour of the
 * picture and colour matching that a person picks in its Style tab, over the edit plan's and the channel's branding.
 * A pick goes onto the latest timeline at once (a new revision), so the next preview shows it.
 */
@Controller()
@UseGuards(RolesGuard)
export class VideoLookController {
  constructor(private readonly engine: EngineService, private readonly workspace: WorkspaceService) {}

  /** What the video picked, the plan's and the channel's, what the timeline draws, and what can be picked. */
  @Get('videos/:videoId/look')
  @Roles('viewer')
  get(@Param('videoId') videoId: string): Promise<VideoLookResponse> {
    return mapErrors(() => this.lookOf(videoId, null));
  }

  /** Body `{text_look, look, color_match}`, each null to take the plan's or the channel's again (editor). */
  @Put('videos/:videoId/look')
  @Roles('editor')
  set(@Param('videoId') videoId: string, @Body() raw: unknown, @Req() req: Request): Promise<VideoLookResponse> {
    return mapErrors(async () => {
      const own = parseOwnLook(raw);
      const v = await requireVideo(this.engine.db, videoId);
      await setVideoOwnLook(this.engine.db, videoId, own);
      const revision = await videoLookToTimeline(this.engine.db, {
        workspaceDir: await this.workspace.dir(v.project_id), projectId: v.project_id, videoId, authorId: req.authContext!.userId,
      });
      return this.lookOf(videoId, revision);
    });
  }

  /** The project's own words and picture (plan 2026-10-29), the branding's, and which videos pick their own. */
  @Get('projects/:projectId/look')
  @Roles('viewer')
  getProject(@Param('projectId') projectId: string): Promise<ProjectLookResponse> {
    return mapErrors(async () => {
      await requireProject(this.engine.db, projectId);
      return { ...(await projectLookView(this.engine.db, await this.workspace.dir(projectId), projectId)), choices: LOOK_CHOICES };
    });
  }

  /**
   * Body `{text_look, look, color_match, everyVideo?}` (editor): the project's look, put on every video's latest
   * timeline that has no pick of its own; with `everyVideo`, the videos' own picks are cleared first so all draw it.
   */
  @Put('projects/:projectId/look')
  @Roles('editor')
  setProject(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request): Promise<ProjectLookResponse> {
    return mapErrors(async () => {
      const { everyVideo, ...rest } = ProjectLookSchema.parse(raw ?? {});
      const look = parseOwnLook(rest);
      await requireProject(this.engine.db, projectId);
      const dir = await this.workspace.dir(projectId);
      const r = await setProjectLook(this.engine.db, { workspaceDir: dir, projectId, look, everyVideo: !!everyVideo, authorId: req.authContext!.userId });
      return { ...(await projectLookView(this.engine.db, dir, projectId)), choices: LOOK_CHOICES, cleared: r.cleared, timelines: r.revisions.length };
    });
  }

  private async lookOf(videoId: string, revision: number | null): Promise<VideoLookResponse> {
    const v = await requireVideo(this.engine.db, videoId);
    return { ...(await videoLookView(this.engine.db, await this.workspace.dir(v.project_id), videoId)), choices: LOOK_CHOICES, revision };
  }
}
