import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  actionView, decideAction, getAction, listActions, referenceDownloadBlock, requireProject, requireThread, StudioRunError, type ActionView, type ActorRole,
  type YoutubeBlock,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService, referenceFetcherNames } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';

/**
 * Cards of work with a real effect the agent proposed (spec 2026-10-10 agent-workspace §3.5): a thread's cards, and a
 * person confirming or rejecting one. Viewers see them; the role each needs (producer for renders, exports and
 * deletions, editor for crawls and reference downloads) is checked when deciding.
 */
@Controller()
@UseGuards(RolesGuard)
export class ActionsController {
  constructor(private readonly engine: EngineService) {}

  /**
   * `youtubeBlocked`: a pending reference download would fail now (`referenceDownloadBlock`), else null: YouTube blocks
   * the Studio server and no farm machine can fetch instead (`where: 'studio'`), or the farm's machines are blocked too
   * (`where: 'farm'`). Blocked server but a machine able to fetch: null, the card goes through the farm.
   */
  @Get('threads/:threadId/actions')
  @Roles('viewer')
  async list(@Param('threadId') threadId: string): Promise<{ actions: ActionView[]; youtubeBlocked: YoutubeBlock | null }> {
    const fetchers = await referenceFetcherNames(this.engine);
    return mapErrors(() => {
      requireThread(this.engine.db, threadId);
      return {
        actions: listActions(this.engine.db, { threadId }).map(actionView),
        youtubeBlocked: referenceDownloadBlock(this.engine.db, this.engine.core.clock.now(), fetchers.length),
      };
    });
  }

  @Post('projects/:projectId/actions/:actionId/confirm')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  confirm(@Param('projectId') projectId: string, @Param('actionId') actionId: string, @Req() req: Request): Promise<ActionView> {
    return this.decide(projectId, actionId, 'confirm', req);
  }

  @Post('projects/:projectId/actions/:actionId/reject')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  reject(@Param('projectId') projectId: string, @Param('actionId') actionId: string, @Req() req: Request): Promise<ActionView> {
    return this.decide(projectId, actionId, 'reject', req);
  }

  private decide(projectId: string, actionId: string, decision: 'confirm' | 'reject', req: Request): Promise<ActionView> {
    return mapErrors(() => {
      const project = requireProject(this.engine.db, projectId);
      const a = getAction(this.engine.db, actionId);
      if (!a || a.project_id !== projectId) throw new StudioRunError('not_found', `không có thẻ ${actionId}`);
      const role: ActorRole = req.authContext?.isAdmin ? 'owner'
        : this.engine.db.get<{ role: ActorRole }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', [project.team_id, req.authContext!.userId])?.role ?? 'viewer';
      return actionView(decideAction(this.engine.db, { actionId, decision, userId: req.authContext!.userId, role }));
    });
  }
}
