import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { z } from 'zod';
import {
  acceptLesson, defaultPlaybookYaml, dismissLesson, PLAYBOOK_PATH, listLessonProposals, loadPlaybook, playbookStatus, requireProject, requireVideo, stepPath, StudioRunError,
  writeFrontmatter, writeWorkspaceFile, type LessonProposal, type PlaybookStatus,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { WorkspaceService } from './workspace.service';
import { parseBody } from './zod-body';

const MarkSchema = z.object({
  videoId: z.string().min(1).optional(),
  status: z.enum(['done', 'skipped', 'draft']),
}).strict();
const AcceptSchema = z.object({ text: z.string().trim().min(5).max(240).optional() }).strict();

/**
 * The suggested steps (spec 2026-10-10 agent-workspace §6): where the project and a video stand, marking a step's
 * document done/skipped/draft (its frontmatter `status`), and the lessons threads proposed (§4).
 */
@Controller('projects/:projectId')
@UseGuards(RolesGuard)
export class PlaybookController {
  constructor(
    private readonly engine: EngineService,
    private readonly workspace: WorkspaceService,
  ) {}

  @Get('playbook')
  @Roles('viewer')
  status(@Param('projectId') projectId: string, @Query('videoId') videoId?: string): Promise<PlaybookStatus> {
    return mapErrors(() => {
      requireProject(this.engine.db, projectId);
      if (videoId && requireVideo(this.engine.db, videoId).project_id !== projectId) throw new StudioRunError('not_found', `không có video ${videoId}`);
      return playbookStatus(this.engine.db, this.workspace.dir(projectId), { projectId, videoId: videoId ?? null });
    });
  }

  /** Body `{videoId?, status}`: sets the step document's frontmatter status (made with a title when it is missing). */
  @Post('playbook/steps/:stepKey/mark')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  mark(@Param('projectId') projectId: string, @Param('stepKey') stepKey: string, @Body() raw: unknown, @Req() req: Request) {
    return mapErrors(() => {
      const body = parseBody(MarkSchema, raw);
      const dir = this.workspace.dir(projectId);
      const step = loadPlaybook(dir).playbook.steps.find((s) => s.key === stepKey);
      if (!step) throw new StudioRunError('not_found', `không có bước ${stepKey}`);
      if (step.scope === 'video' && !body.videoId) throw new StudioRunError('invalid', 'bước của video cần videoId', { code: 'video_required' });
      const doc = step.outputs.find((o) => o.role === 'doc');
      if (!doc) throw new StudioRunError('rejected', 'bước này do Studio làm, không đánh dấu tay được', { code: 'studio_step' });
      const path = stepPath(doc.path, body.videoId ?? null);
      const abs = join(dir, ...path.split('/'));
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : `# ${step.title}\n`;
      return writeWorkspaceFile(this.engine.db, {
        projectId, dir, path, content: writeFrontmatter(current, { status: body.status }), author: { kind: 'user', id: req.authContext!.userId },
      });
    });
  }

  /** Writes the default playbook to .studio/playbook.yaml (when the project has none) for people to edit. */
  @Post('playbook/customize')
  @Roles('producer')
  @HttpCode(HttpStatus.OK)
  customize(@Param('projectId') projectId: string, @Req() req: Request): Promise<{ path: string; created: boolean }> {
    return mapErrors(() => {
      const dir = this.workspace.dir(projectId);
      if (existsSync(join(dir, ...PLAYBOOK_PATH.split('/')))) return { path: PLAYBOOK_PATH, created: false };
      const text = defaultPlaybookYaml();
      writeWorkspaceFile(this.engine.db, { projectId, dir, path: PLAYBOOK_PATH, content: text, baseSha256: null, author: { kind: 'user', id: req.authContext!.userId } });
      return { path: PLAYBOOK_PATH, created: true };
    });
  }

  @Get('lessons')
  @Roles('viewer')
  lessons(@Param('projectId') projectId: string, @Query('status') status?: string, @Query('threadId') threadId?: string): Promise<{ lessons: LessonProposal[] }> {
    return mapErrors(() => {
      requireProject(this.engine.db, projectId);
      const st = status === 'proposed' || status === 'accepted' || status === 'dismissed' ? status : undefined;
      return { lessons: listLessonProposals(this.engine.db, projectId, { ...(st ? { status: st } : {}), ...(threadId ? { threadId } : {}) }) };
    });
  }

  /** Body `{text?}` (the person may reword it): appends the lesson to memory/lessons.md. */
  @Post('lessons/:lessonId/accept')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  accept(@Param('projectId') projectId: string, @Param('lessonId') lessonId: string, @Body() raw: unknown, @Req() req: Request): Promise<LessonProposal> {
    return mapErrors(() => {
      const body = parseBody(AcceptSchema, raw);
      return acceptLesson(this.engine.db, { projectId, lessonId, dir: this.workspace.dir(projectId), userId: req.authContext!.userId, ...(body.text ? { text: body.text } : {}) });
    });
  }

  @Post('lessons/:lessonId/dismiss')
  @Roles('editor')
  @HttpCode(HttpStatus.NO_CONTENT)
  dismiss(@Param('projectId') projectId: string, @Param('lessonId') lessonId: string, @Req() req: Request): Promise<void> {
    return mapErrors(() => dismissLesson(this.engine.db, { projectId, lessonId, userId: req.authContext!.userId }));
  }
}
