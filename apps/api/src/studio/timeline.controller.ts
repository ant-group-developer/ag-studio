import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  getEpisodeRevision,
  latestEpisodeRevision,
  listEpisodeRevisions,
  pollEpisodeJob,
  saveEpisodeTimeline,
  startEpisodePreview,
  timelineIssues,
  type EditorJobView,
  type TimelineIssue,
} from '@ag-studio/engine';

import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PreviewDto, SaveRevisionDto } from './dto';
import { EngineService } from './engine.service';
import { FootageAccessService } from './footage-access.service';
import { mapErrors } from './http-errors';

/**
 * Web editor (GĐ2): per-episode timeline revisions (autosave with `baseRevision`, 409 on conflict)
 * and render-preview farm jobs.
 * Routes: `/productions/:id/episodes/:episodeId/...`
 */
@Controller('productions/:id/episodes/:episodeId')
@UseGuards(RolesGuard)
export class TimelineController {
  constructor(
    private readonly engine: EngineService,
    private readonly access: FootageAccessService,
  ) {}

  @Get('timeline')
  @Roles('viewer')
  latest(@Param('id') _prodId: string, @Param('episodeId') episodeId: string) {
    const rev = latestEpisodeRevision(this.engine.db, episodeId);
    if (!rev) throw new NotFoundException({ message: 'no timeline revision yet', code: 'not_found' });
    return { ...rev, issues: timelineIssues(rev.data) };
  }

  @Get('timeline/revisions')
  @Roles('viewer')
  revisions(@Param('episodeId') episodeId: string) {
    return listEpisodeRevisions(this.engine.db, episodeId);
  }

  @Get('timeline/revisions/:rev')
  @Roles('viewer')
  revision(
    @Param('episodeId') episodeId: string,
    @Param('rev', ParseIntPipe) rev: number,
  ) {
    const r = getEpisodeRevision(this.engine.db, episodeId, rev);
    if (!r) throw new NotFoundException({ message: `revision ${rev} not found`, code: 'not_found' });
    return { ...r, issues: timelineIssues(r.data) };
  }

  /** Autosave. 201 `{ revision, issues }`; 409 `{ currentRevision }` when `baseRevision` is not the latest. */
  @Post('timeline/revisions')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  save(
    @Param('id') prodId: string,
    @Param('episodeId') episodeId: string,
    @Body() dto: SaveRevisionDto,
    @Req() req: Request,
  ): Promise<{ revision: number; issues: TimelineIssue[] }> {
    return mapErrors(() =>
      saveEpisodeTimeline(this.engine.db, episodeId, {
        baseRevision: dto.baseRevision,
        data: dto.data,
        authorId: req.authContext!.userId,
        label: dto.label ?? 'autosave',
      }),
    );
  }

  /** Start a render-preview farm job for one episode revision. */
  @Post('editor/previews')
  @Roles('editor')
  @HttpCode(HttpStatus.ACCEPTED)
  preview(
    @Param('id') prodId: string,
    @Param('episodeId') episodeId: string,
    @Body() dto: PreviewDto,
    @Req() req: Request,
  ): Promise<EditorJobView> {
    return mapErrors(() =>
      startEpisodePreview(this.engine.editor, {
        productionId: prodId,
        episodeId,
        revision: dto.revision,
        userId: req.authContext!.userId,
      }),
    );
  }

  /** Poll one editor job.  The signed video URL is included only within the user's footage scope. */
  @Get('editor/jobs/:jobId')
  @Roles('viewer')
  job(
    @Param('id') prodId: string,
    @Param('episodeId') episodeId: string,
    @Param('jobId') jobId: string,
    @Req() req: Request,
  ) {
    return mapErrors(async () => {
      const job = await pollEpisodeJob(this.engine.editor, {
        productionId: prodId,
        episodeId,
        jobId,
        urlTtlSeconds: this.engine.browserUrlTtl,
      });
      if (job.url && !(await this.access.coversProduction(req.authContext!.userId, prodId))) {
        const { url: _hidden, ...rest } = job;
        return { ...rest, urlHidden: 'footage_scope' };
      }
      return job;
    });
  }
}
