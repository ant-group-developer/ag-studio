import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  cancelEpisode,
  EPISODE_RENDER_STAGE,
  episodeExport,
  episodeRunView,
  episodeState,
  episodeTimelineSeconds,
  getEpisode,
  latestEpisodeRevision,
  listEpisodes,
  readStageDocument,
  rerenderEpisode,
  retryStage,
  YoutubeKitSchema,
  validateYoutubeKit,
  type EpisodeRecord,
  type EpisodeStatus,
  type RunView,
} from '@ag-studio/engine';
import { Logger } from '@nestjs/common';
import { IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from './engine.service';
import { FootageAccessService } from './footage-access.service';
import { mapErrors } from './http-errors';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

class PatchEpisodeDto {
  @IsOptional()
  @IsObject()
  youtube?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2)
  selectedTitle?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2)
  selectedThumbnail?: number;
}

// ---------------------------------------------------------------------------
// Views (docs/studio-api-v3.md "Episodes")
// ---------------------------------------------------------------------------

export interface EpisodeSummary {
  id: string; idx: number; title: string; hook: string; status: EpisodeStatus;
  currentStage: string | null; progress: number | null; durationSeconds: number | null;
  thumbnailUrl: string | null; updatedAt: string;
}

type StudioExport = NonNullable<ReturnType<typeof episodeExport>>;

const STATUS_ORDER: Record<EpisodeStatus, number> = { producing: 0, failed: 1, planned: 2, cancelled: 3, ready: 4 };

/** Thumbnails of an export in thumb-1..3 order. */
function exportThumbnails(exp: StudioExport | null) {
  return (exp?.files ?? []).filter((f) => f.kind === 'thumbnail').sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Episodes list / detail / PATCH / rerender / cancel / retry routes (GĐ2).
 * Base route: `/productions/:id/episodes`
 */
@Controller('productions/:id/episodes')
@UseGuards(RolesGuard)
export class EpisodesController {
  private readonly logger = new Logger(EpisodesController.name);

  constructor(
    private readonly engine: EngineService,
    private readonly access: FootageAccessService,
  ) {}

  /** Files that show footage (video, thumbnails, the pack) go only to someone whose own ag-go scope covers the
   *  production (plan decision 9: sharing a production never widens anyone's footage scope). */
  private covers(req: Request, prodId: string): Promise<boolean> {
    return this.access.coversProduction(req.authContext!.userId, prodId);
  }

  /** Farm progress of the episode's render, while it renders. The list must not fail because the farm is away. */
  private async renderProgress(stage: string | null, jobId: string | null): Promise<number | null> {
    if (stage !== EPISODE_RENDER_STAGE || !jobId) return null;
    try {
      const job = await this.engine.editor.farm.getJob(jobId);
      return job.progress_percent ?? null;
    } catch (e) {
      this.logger.warn(`farm job ${jobId} progress unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private sign(key: string): Promise<string> {
    return this.engine.bucket.signedGetUrl(key, this.engine.browserUrlTtl);
  }

  private async summary(ep: EpisodeRecord, covers: boolean, state = episodeState(this.engine.core, this.engine.db, ep)): Promise<EpisodeSummary> {
    const exp = episodeExport(this.engine.core, ep);
    const thumbs = exportThumbnails(exp);
    const thumb = thumbs[ep.selected_thumbnail ?? 0] ?? thumbs[0];
    return {
      id: ep.id,
      idx: ep.idx,
      title: ep.title,
      hook: ep.hook,
      status: state.status,
      currentStage: state.current_stage,
      progress: await this.renderProgress(state.current_stage, state.render_job_id),
      durationSeconds: exp?.duration_seconds ?? episodeTimelineSeconds(this.engine.db, ep.id),
      thumbnailUrl: thumb && covers ? await this.sign(thumb.key) : null,
      updatedAt: ep.updated_at,
    };
  }

  private requireEpisode(prodId: string, episodeId: string): EpisodeRecord {
    const ep = getEpisode(this.engine.db, episodeId);
    if (!ep || ep.production_id !== prodId) {
      throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
    }
    return ep;
  }

  // ---------------------------------------------------------------------------
  // List + detail
  // ---------------------------------------------------------------------------

  @Get()
  @Roles('viewer')
  list(
    @Param('id') prodId: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('sortBy') sortBy = 'idx',
    @Query('sortOrder') sortOrder = 'asc',
    @Req() req: Request,
  ) {
    return mapErrors(async () => {
      const covers = await this.covers(req, prodId);
      const ps = Math.min(Math.max(1, parseInt(pageSize, 10) || 20), 100);
      const pg = Math.max(1, parseInt(page, 10) || 1);
      const order = sortOrder === 'desc' ? -1 : 1;
      // States are cheap (local store); progress, exports and signed URLs only for the page shown.
      const all = listEpisodes(this.engine.db, prodId).map((ep) => ({ ep, state: episodeState(this.engine.core, this.engine.db, ep) }));
      all.sort((a, b) => {
        if (sortBy === 'title') return order * a.ep.title.localeCompare(b.ep.title, 'vi') || a.ep.idx - b.ep.idx;
        if (sortBy === 'status') return order * (STATUS_ORDER[a.state.status] - STATUS_ORDER[b.state.status]) || a.ep.idx - b.ep.idx;
        if (sortBy === 'updatedAt') return order * a.ep.updated_at.localeCompare(b.ep.updated_at) || a.ep.idx - b.ep.idx;
        return order * (a.ep.idx - b.ep.idx);
      });
      const items = await Promise.all(all.slice((pg - 1) * ps, pg * ps).map(({ ep, state }) => this.summary(ep, covers, state)));
      return { items, total: all.length, page: pg, pageSize: ps };
    });
  }

  @Get(':episodeId')
  @Roles('viewer')
  detail(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      const covers = await this.covers(req, prodId);
      const showsFootage = (kind: string) => kind === 'mp4' || kind === 'thumbnail' || kind === 'pack';
      const run: RunView | null = ep.run_id ? episodeRunView(this.engine.core, this.engine.db, episodeId) : null;
      const kitStage = run?.stages.find((s) => s.key === 'youtube-kit');
      // The person's edits win over Claude's kit
      const youtube = ep.youtube
        ? YoutubeKitSchema.parse(JSON.parse(ep.youtube))
        : kitStage?.state === 'SUCCEEDED' && ep.run_id
          ? YoutubeKitSchema.parse(readStageDocument(this.engine.core, ep.run_id, 'youtube-kit', 'youtube-kit.json'))
          : null;
      const exp = episodeExport(this.engine.core, ep);
      const exportFiles = await Promise.all((exp?.files ?? []).filter((f) => covers || !showsFootage(f.kind)).map(async (f) => ({
        kind: f.kind, url: await this.sign(f.key), sizeBytes: f.size_bytes, name: f.key.split('/').pop() ?? f.key,
      })));
      const thumbnails = covers ? await Promise.all(exportThumbnails(exp).map(async (f, index) => ({ url: await this.sign(f.key), index }))) : [];
      const mp4 = covers ? exp?.files.find((f) => f.kind === 'mp4') : undefined;
      return {
        ...(await this.summary(ep, covers)),
        footageHidden: !covers,
        plan: ep.plan ? JSON.parse(ep.plan) : null,
        run,
        youtube,
        selectedTitle: ep.selected_title ?? 0,
        selectedThumbnail: ep.selected_thumbnail ?? 0,
        thumbnails,
        exportFiles,
        finalVideoUrl: mp4 ? await this.sign(mp4.key) : null,
        latestRevision: latestEpisodeRevision(this.engine.db, ep.id)?.revision ?? null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // PATCH (YouTube kit + selections)
  // ---------------------------------------------------------------------------

  @Patch(':episodeId')
  @Roles('editor')
  patch(
    @Param('id') prodId: string,
    @Param('episodeId') episodeId: string,
    @Body() dto: PatchEpisodeDto,
    @Req() req: Request,
  ) {
    return mapErrors(() => {
      const ep = getEpisode(this.engine.db, episodeId);
      if (!ep || ep.production_id !== prodId) {
        throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
      }
      let youtubeJson: string | null = ep.youtube;
      if (dto.youtube !== undefined) {
        // Validate the kit against the episode plan
        const parsed = YoutubeKitSchema.safeParse(dto.youtube);
        if (!parsed.success) {
          throw new UnprocessableEntityException({ code: 'invalid', problems: parsed.error.issues.map((i: { path: unknown[]; message: string }) => ({ code: 'schema', message: `${i.path.join('.')}: ${i.message}` })) });
        }
        const plan = ep.plan ? JSON.parse(ep.plan) : {};
        const validation = validateYoutubeKit(parsed.data, { episode: plan });
        if (!validation.ok) {
          throw new UnprocessableEntityException({ code: 'invalid', problems: validation.problems });
        }
        youtubeJson = JSON.stringify(parsed.data);
      }
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (youtubeJson !== ep.youtube) { sets.push('youtube = ?'); vals.push(youtubeJson); }
      if (dto.selectedTitle !== undefined) { sets.push('selected_title = ?'); vals.push(dto.selectedTitle); }
      if (dto.selectedThumbnail !== undefined) { sets.push('selected_thumbnail = ?'); vals.push(dto.selectedThumbnail); }
      if (sets.length) {
        sets.push('updated_at = ?'); vals.push(new Date().toISOString()); vals.push(episodeId);
        this.engine.db.run(`UPDATE episodes SET ${sets.join(', ')} WHERE id = ?`, vals as string[]);
      }
      return this.detail(prodId, episodeId, req);
    });
  }

  // ---------------------------------------------------------------------------
  // Rerender / cancel / retry stage
  // ---------------------------------------------------------------------------

  @Post(':episodeId/rerender')
  @Roles('producer')
  @HttpCode(HttpStatus.ACCEPTED)
  rerender(@Param('id') prodId: string, @Param('episodeId') episodeId: string) {
    return mapErrors(() => {
      const ep = getEpisode(this.engine.db, episodeId);
      if (!ep || ep.production_id !== prodId) {
        throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
      }
      return rerenderEpisode(this.engine.core, this.engine.db, episodeId);
    });
  }

  @Post(':episodeId/cancel')
  @Roles('producer')
  @HttpCode(HttpStatus.ACCEPTED)
  cancel(@Param('id') prodId: string, @Param('episodeId') episodeId: string) {
    return mapErrors(() => {
      const ep = getEpisode(this.engine.db, episodeId);
      if (!ep || ep.production_id !== prodId) {
        throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
      }
      cancelEpisode(this.engine.core, this.engine.db, episodeId);
      return { ok: true };
    });
  }

  @Post(':episodeId/stages/:stage/retry')
  @Roles('producer')
  @HttpCode(HttpStatus.ACCEPTED)
  retryEpisodeStage(
    @Param('id') prodId: string,
    @Param('episodeId') episodeId: string,
    @Param('stage') stage: string,
  ) {
    return mapErrors(() => {
      const ep = getEpisode(this.engine.db, episodeId);
      if (!ep || ep.production_id !== prodId) {
        throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
      }
      if (!ep.run_id) throw new NotFoundException({ code: 'no_run', message: `episode ${episodeId} has no run` });
      retryStage(this.engine.core, ep.run_id, stage);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------

  @Get(':episodeId/documents/:stage/:name')
  @Roles('viewer')
  document(
    @Param('id') prodId: string,
    @Param('episodeId') episodeId: string,
    @Param('stage') stage: string,
    @Param('name') name: string,
  ) {
    return mapErrors(() => {
      const ep = getEpisode(this.engine.db, episodeId);
      if (!ep || ep.production_id !== prodId) {
        throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
      }
      if (!ep.run_id) throw new NotFoundException({ code: 'no_run', message: `episode ${episodeId} has no run` });
      return readStageDocument(this.engine.core, ep.run_id, stage, name);
    });
  }
}
