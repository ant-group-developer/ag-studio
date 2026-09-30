import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { IsIn } from 'class-validator';
import {
  getEpisode,
  getEpisodeRevision,
  latestEpisodeRevision,
  listEpisodeJobs,
  listEpisodeRevisions,
  pollEpisodeJob,
  saveEpisodeTimeline,
  startEpisodePreview,
  startPremiereExport,
  timelineIssues,
  type EditorJobView,
  type EpisodeRevision,
  type TimelineIssue,
} from '@ag-studio/engine';

import { AccountApiService, mayDownloadOriginals } from '../auth/account-api.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PreviewDto, SaveRevisionDto } from './dto';
import { EngineService } from './engine.service';
import { FootageAccessService } from './footage-access.service';
import { mapErrors } from './http-errors';

class PremiereExportDto {
  @IsIn(['proxy', 'original'])
  media!: 'proxy' | 'original';
}

const JOB_KINDS = ['render_preview', 'export_premiere'] as const;

/** Editor job as docs/studio-api-v3.md shows it. */
export interface EditorJobDto {
  id: string;
  kind: EditorJobView['kind'];
  status: EditorJobView['status'];
  progress: number | null;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  url?: string;
  /** The URL exists but carries footage pixels outside the caller's own ag-go scope (plan decision 9). */
  urlHidden?: 'footage_scope';
}

function revisionView(r: EpisodeRevision) {
  return { revision: r.revision, data: r.data, issues: timelineIssues(r.data), savedAt: r.created_at, authorId: r.author_id };
}

/**
 * Web editor: per-episode timeline revisions (autosave with `baseRevision`, 409 on conflict), render previews and
 * Adobe Premiere exports. Routes: `/productions/:id/episodes/:episodeId/...`. The role guard authorises against
 * the production in the URL, so every route first checks that the episode belongs to it.
 */
@Controller('productions/:id/episodes/:episodeId')
@UseGuards(RolesGuard)
export class TimelineController {
  constructor(
    private readonly engine: EngineService,
    private readonly access: FootageAccessService,
    private readonly account: AccountApiService,
  ) {}

  private requireEpisode(prodId: string, episodeId: string): void {
    const ep = getEpisode(this.engine.db, episodeId);
    if (!ep || ep.production_id !== prodId) throw new NotFoundException({ message: `episode ${episodeId} not found`, code: 'not_found' });
  }

  /** Videos and zips of footage go only to someone whose own ag-go scope covers the production. */
  private async jobDto(job: EditorJobView & { url?: string }, userId: string, prodId: string, covers?: boolean): Promise<EditorJobDto> {
    const { created_at, url, ...rest } = job;
    const dto: EditorJobDto = { ...rest, createdAt: created_at };
    if (url) {
      if (covers ?? (await this.access.coversProduction(userId, prodId))) dto.url = url;
      else dto.urlHidden = 'footage_scope';
    }
    return dto;
  }

  @Get('timeline')
  @Roles('viewer')
  latest(@Param('id') prodId: string, @Param('episodeId') episodeId: string) {
    return mapErrors(() => {
      this.requireEpisode(prodId, episodeId);
      const rev = latestEpisodeRevision(this.engine.db, episodeId);
      if (!rev) throw new NotFoundException({ message: 'no timeline revision yet', code: 'not_found' });
      return revisionView(rev);
    });
  }

  @Get('timeline/revisions')
  @Roles('viewer')
  revisions(@Param('id') prodId: string, @Param('episodeId') episodeId: string) {
    return mapErrors(() => {
      this.requireEpisode(prodId, episodeId);
      return listEpisodeRevisions(this.engine.db, episodeId).map((r) => ({
        revision: r.revision, baseRevision: r.base_revision, authorId: r.author_id, label: r.label, createdAt: r.created_at,
      }));
    });
  }

  @Get('timeline/revisions/:rev')
  @Roles('viewer')
  revision(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Param('rev', ParseIntPipe) rev: number) {
    return mapErrors(() => {
      this.requireEpisode(prodId, episodeId);
      const r = getEpisodeRevision(this.engine.db, episodeId, rev);
      if (!r) throw new NotFoundException({ message: `revision ${rev} not found`, code: 'not_found' });
      return revisionView(r);
    });
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
    return mapErrors(() => {
      this.requireEpisode(prodId, episodeId);
      return saveEpisodeTimeline(this.engine.db, episodeId, {
        baseRevision: dto.baseRevision,
        data: dto.data,
        authorId: req.authContext!.userId,
        label: dto.label ?? 'autosave',
      });
    });
  }

  /** Start a render-preview farm job for one episode revision. */
  @Post('editor/previews')
  @Roles('editor')
  @HttpCode(HttpStatus.ACCEPTED)
  preview(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Body() dto: PreviewDto, @Req() req: Request) {
    return mapErrors(async () => {
      this.requireEpisode(prodId, episodeId);
      const job = await startEpisodePreview(this.engine.editor, { productionId: prodId, episodeId, revision: dto.revision, userId: req.authContext!.userId });
      return this.jobDto(job, req.authContext!.userId, prodId);
    });
  }

  /**
   * Adobe Premiere project of the latest revision (GĐ6). `original` packs the original files: only for someone who
   * may download originals in ag-go (or a Studio admin) — sharing a production never widens that right.
   */
  @Post('exports/premiere')
  @Roles('editor')
  @HttpCode(HttpStatus.ACCEPTED)
  premiere(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Body() dto: PremiereExportDto, @Req() req: Request) {
    return mapErrors(async () => {
      this.requireEpisode(prodId, episodeId);
      const auth = req.authContext!;
      if (dto.media === 'original') {
        const profile = await this.account.getUserProfile(auth.accessToken, auth.userId);
        if (!mayDownloadOriginals(profile)) {
          throw new ForbiddenException({ code: 'original_forbidden', message: 'Bạn không có quyền tải bản gốc; hãy xuất bản proxy 720p' });
        }
      }
      const job = await startPremiereExport(this.engine.editor, { productionId: prodId, episodeId, media: dto.media, userId: auth.userId });
      return this.jobDto(job, auth.userId, prodId);
    });
  }

  /** The episode's editor jobs of one kind, latest first (the web lists Premiere exports with this). */
  @Get('editor/jobs')
  @Roles('viewer')
  jobs(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Query('kind') kind: string, @Req() req: Request) {
    return mapErrors(async () => {
      this.requireEpisode(prodId, episodeId);
      if (!(JOB_KINDS as readonly string[]).includes(kind)) throw new NotFoundException({ message: `unknown job kind ${kind}`, code: 'not_found' });
      const jobs = await listEpisodeJobs(this.engine.editor, {
        productionId: prodId, episodeId, kind: kind as EditorJobView['kind'], urlTtlSeconds: this.engine.browserUrlTtl,
      });
      const covers = await this.access.coversProduction(req.authContext!.userId, prodId);
      return Promise.all(jobs.map((j) => this.jobDto(j, req.authContext!.userId, prodId, covers)));
    });
  }

  /** Poll one editor job. The signed URL is included only within the caller's footage scope. */
  @Get('editor/jobs/:jobId')
  @Roles('viewer')
  job(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Param('jobId') jobId: string, @Req() req: Request) {
    return mapErrors(async () => {
      this.requireEpisode(prodId, episodeId);
      const job = await pollEpisodeJob(this.engine.editor, { productionId: prodId, episodeId, jobId, urlTtlSeconds: this.engine.browserUrlTtl });
      return this.jobDto(job, req.authContext!.userId, prodId);
    });
  }
}
