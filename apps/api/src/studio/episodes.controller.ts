import {
  Body,
  Controller,
  ForbiddenException,
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
  buildYoutubePack,
  cancelEpisode,
  EPISODE_RENDER_STAGE,
  episodeExport,
  episodeKit,
  episodeRenderInfo,
  episodeRunView,
  episodeShots,
  EPISODE_RERUN_GATES,
  episodeState,
  episodeThumbnails,
  episodeTimelineSeconds,
  getEpisode,
  latestAcceptedCall,
  latestEpisodeRevision,
  listEpisodes,
  readStageDocument,
  recordHumanEdit,
  rerenderEpisode,
  rerunEpisodeFrom,
  retryStage,
  readStoredYoutubeKit,
  RENDER_MACHINES,
  selectedThumbnail,
  YoutubeKitSchema,
  validateYoutubeKit,
  type EpisodeRecord,
  type EpisodeRerunGate,
  type EpisodeStatus,
  type RenderMachine,
  type RunView,
  type ThumbnailActionDeps,
  setEpisodeNarration,
} from '@ag-studio/engine';
import { Logger } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from './engine.service';
import { FootageAccessService } from './footage-access.service';
import { mapErrors } from './http-errors';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export class RerenderDto {
  /** The farm machine type the final render runs on (phase 3); absent: the run's choice, or any machine. */
  @IsOptional() @IsIn(RENDER_MACHINES) renderMachine?: RenderMachine;
  /** …and the one farm node it must run on (`GET /api/studio/farm/nodes`); with `renderMachine` only. */
  @IsOptional() @IsUUID() renderNodeId?: string;
}

export class EpisodeNarrationDto {
  @IsBoolean() declined!: boolean;
}

/** Where a shot-cut episode runs again from: its scene selection or its edit plan gate (phase 5). */
export class RerunFromDto {
  @IsIn(EPISODE_RERUN_GATES) stage!: EpisodeRerunGate;
}

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
  /** `whole` (whole videos) or `cut` (shot by shot, phase 5). */
  editStyle: 'whole' | 'cut';
  /** Narration declined for this episode alone (a shot-cut episode). */
  narrationDeclined: boolean;
}

type StudioExport = NonNullable<ReturnType<typeof episodeExport>>;

const STATUS_ORDER: Record<EpisodeStatus, number> = { waiting_approval: 0, producing: 1, failed: 2, planned: 3, cancelled: 4, ready: 5 };

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

  /** The final render: machine type, where Render lại starts, and the farm status of the job while it renders. */
  private async renderInfo(episodeId: string) {
    const info = episodeRenderInfo(this.engine.core, this.engine.db, episodeId);
    const running = info.job && info.restartFrom === null && info.job.runId === getEpisode(this.engine.db, episodeId)?.run_id;
    let farmStatus: { status: string; progress: number | null } | null = null;
    if (running) {
      try {
        const job = await this.engine.editor.farm.getJob(info.job!.farmJobId);
        farmStatus = { status: job.status, progress: job.progress_percent ?? null };
      } catch (e) {
        this.logger.warn(`farm job ${info.job!.farmJobId} status unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { ...info, farmStatus };
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

  private get thumbs(): ThumbnailActionDeps {
    return { core: this.engine.core, db: this.engine.db, bucket: this.engine.bucket, urlTtlSeconds: this.engine.browserUrlTtl };
  }

  /** The picture the episode uses (an episode from before 1.2.0 gets its old pictures as rows on first sight). */
  private pickedThumbnail(ep: EpisodeRecord) {
    episodeThumbnails(this.thumbs, ep);
    return selectedThumbnail(this.engine.db, getEpisode(this.engine.db, ep.id) ?? ep);
  }

  /** A URL to show the object; with `downloadName`, one the browser saves under that name. */
  private sign(key: string, downloadName?: string): Promise<string> {
    return this.engine.bucket.signedGetUrl(key, this.engine.browserUrlTtl, downloadName ? { downloadName } : {});
  }

  private async summary(ep: EpisodeRecord, covers: boolean, state = episodeState(this.engine.core, this.engine.db, ep)): Promise<EpisodeSummary> {
    const exp = episodeExport(this.engine.core, ep);
    const thumb = covers ? this.pickedThumbnail(ep) : null;
    return {
      id: ep.id,
      idx: ep.idx,
      title: ep.title,
      hook: ep.hook,
      status: state.status,
      currentStage: state.current_stage,
      progress: await this.renderProgress(state.current_stage, state.render_job_id),
      durationSeconds: exp?.duration_seconds ?? episodeTimelineSeconds(this.engine.db, ep.id),
      thumbnailUrl: thumb ? await this.sign(thumb.image_key) : null,
      updatedAt: ep.updated_at,
      editStyle: ep.edit_style,
      narrationDeclined: ep.narration_override === 'none',
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
      // The person's edits, else the kit approved at its gate, else Claude's (episodeKit)
      const youtube = (ep.youtube || kitStage?.state === 'SUCCEEDED') ? episodeKit(this.engine.core, ep) : null;
      const exp = episodeExport(this.engine.core, ep);
      const exportFiles = await Promise.all((exp?.files ?? []).filter((f) => covers || !showsFootage(f.kind)).map(async (f) => {
        const name = f.key.split('/').pop() ?? f.key;
        return { kind: f.kind, url: await this.sign(f.key), downloadUrl: await this.sign(f.key, name), sizeBytes: f.size_bytes, name };
      }));
      const thumbnails = covers ? await Promise.all(exportThumbnails(exp).map(async (f, index) => ({ url: await this.sign(f.key), index }))) : [];
      const mp4 = covers ? exp?.files.find((f) => f.kind === 'mp4') : undefined;
      const release = ep.run_id ? this.engine.core.store.getRun(ep.run_id)?.workflow_release : undefined;
      return {
        ...(await this.summary(ep, covers)),
        footageHidden: !covers,
        plan: ep.plan ? JSON.parse(ep.plan) : null,
        run,
        /** The episode run's workflow as `id@version` (the web picks the steps it shows by it); null before a run. */
        workflow: release ? `${release.id}@${release.version}` : null,
        youtube,
        selectedTitle: ep.selected_title ?? 0,
        selectedThumbnail: ep.selected_thumbnail ?? 0,
        selectedThumbnailId: covers ? this.pickedThumbnail(ep)?.id ?? null : null,
        thumbnails,
        exportFiles,
        finalVideoUrl: mp4 ? await this.sign(mp4.key) : null,
        finalVideoDownloadUrl: mp4 ? await this.sign(mp4.key, mp4.key.split('/').pop()) : null,
        latestRevision: latestEpisodeRevision(this.engine.db, ep.id)?.revision ?? null,
        render: await this.renderInfo(ep.id),
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
        this.recordKitEdit(ep, req?.authContext?.userId);
      }
      return this.detail(prodId, episodeId, req);
    });
  }

  /** Claude's kit (first title and thumbnail) next to what the person saved (training dataset); never fails the save. */
  private recordKitEdit(before: EpisodeRecord, userId: string | undefined): void {
    if (!userId) return;
    try {
      const saved = getEpisode(this.engine.db, before.id);
      if (!saved) return;
      let proposed: unknown;
      if (saved.run_id) {
        try { proposed = readStoredYoutubeKit(readStageDocument(this.engine.core, saved.run_id, 'youtube-kit', 'youtube-kit.json')); } catch { proposed = undefined; }
      }
      recordHumanEdit(this.engine.db, {
        userId, productionId: saved.production_id, episodeId: saved.id, kind: 'youtube_kit',
        before: proposed === undefined ? undefined : { youtube: proposed, selectedTitle: 0, selectedThumbnail: 0 },
        after: {
          youtube: saved.youtube ? JSON.parse(saved.youtube) : proposed ?? null,
          selectedTitle: saved.selected_title ?? 0,
          selectedThumbnail: saved.selected_thumbnail ?? 0,
        },
        llmCallId: saved.run_id ? latestAcceptedCall(this.engine.db, saved.run_id, 'youtube-kit') : null,
      });
    } catch (e) {
      this.logger.warn(`could not record the YouTube kit edit of ${before.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** A person throwing an episode away or redoing it is a signal on the plan behind it; never fails the action. */
  private recordEpisodeDecision(ep: EpisodeRecord, kind: 'episode_rerender' | 'episode_cancel', userId: string | undefined): void {
    if (!userId) return;
    try {
      recordHumanEdit(this.engine.db, { userId, productionId: ep.production_id, episodeId: ep.id, kind });
    } catch (e) {
      this.logger.warn(`could not record ${kind} of ${ep.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Rerender / cancel / retry stage
  // ---------------------------------------------------------------------------

  @Post(':episodeId/rerender')
  @Roles('producer')
  @HttpCode(HttpStatus.ACCEPTED)
  rerender(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Body() dto: RerenderDto, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = getEpisode(this.engine.db, episodeId);
      if (!ep || ep.production_id !== prodId) {
        throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
      }
      const node = dto?.renderNodeId && dto.renderMachine !== undefined ? await this.engine.renderNode(dto.renderNodeId) : null;
      const out = rerenderEpisode(this.engine.core, this.engine.db, episodeId, {
        ...(dto?.renderMachine !== undefined ? { machine: dto.renderMachine, node } : {}),
        ...(req?.authContext?.userId ? { by: req.authContext.userId } : {}),
      });
      this.recordEpisodeDecision(ep, 'episode_rerender', req?.authContext?.userId);
      return out;
    });
  }

  /**
   * Runs a shot-cut episode again from its scene selection or edit plan gate (phase 5): when the run has ended or
   * waits at a later gate; the footage work before the gate is reused.
   */
  @Post(':episodeId/rerun-from')
  @Roles('producer')
  @HttpCode(HttpStatus.ACCEPTED)
  rerunFrom(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Body() dto: RerunFromDto) {
    return mapErrors(() => {
      this.requireEpisode(prodId, episodeId);
      return rerunEpisodeFrom(this.engine.core, this.engine.db, episodeId, dto.stage);
    });
  }

  @Post(':episodeId/cancel')
  @Roles('producer')
  @HttpCode(HttpStatus.ACCEPTED)
  cancel(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Req() req: Request) {
    return mapErrors(() => {
      const ep = getEpisode(this.engine.db, episodeId);
      if (!ep || ep.production_id !== prodId) {
        throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
      }
      cancelEpisode(this.engine.core, this.engine.db, episodeId);
      this.recordEpisodeDecision(ep, 'episode_cancel', req?.authContext?.userId);
      return { ok: true };
    });
  }

  /**
   * Narration of this episode alone: `declined: true` cuts it without lines whatever the production's voice (an
   * episode waiting for a voice runs on at once); `false` follows the production again.
   */
  @Post(':episodeId/narration')
  @Roles('producer')
  @HttpCode(HttpStatus.OK)
  episodeNarration(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Body() dto: EpisodeNarrationDto, @Req() req: Request) {
    return mapErrors(() => {
      const ep = getEpisode(this.engine.db, episodeId);
      if (!ep || ep.production_id !== prodId) {
        throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
      }
      const out = setEpisodeNarration(this.engine.core, this.engine.db, episodeId, { declined: dto.declined });
      const userId = req?.authContext?.userId;
      if (userId) {
        try {
          recordHumanEdit(this.engine.db, {
            userId, productionId: prodId, episodeId, kind: 'voice',
            before: { narration_override: ep.narration_override ?? null }, after: { narration_override: dto.declined ? 'none' : null },
          });
        } catch { /* the dataset never blocks a decision */ }
      }
      return out;
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

  /**
   * The YouTube pack as the episode is now (picked thumbnail, title, description with chapters, tags; no video),
   * built on demand: `{ url, name, sizeBytes }`, the URL saving the zip.
   */
  @Post(':episodeId/youtube-pack')
  @Roles('viewer')
  @HttpCode(HttpStatus.OK)
  youtubePack(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      if (!(await this.covers(req, prodId))) {
        throw new ForbiddenException({ code: 'footage_hidden', message: 'Bạn không có quyền xem footage của production này' });
      }
      const pack = await buildYoutubePack(this.thumbs, ep);
      return { url: await this.sign(pack.key, pack.name), name: pack.name, sizeBytes: pack.size_bytes };
    });
  }

  // ---------------------------------------------------------------------------
  // Shots (shot-cut episodes, phase 5)
  // ---------------------------------------------------------------------------

  /**
   * The scene selection of a shot-cut episode now (at its gate, chat edits included, or as approved), each shot
   * with a signed URL of its frame. Frames show footage: 403 for someone whose ag-go scope does not cover the
   * production.
   */
  @Get(':episodeId/shots')
  @Roles('viewer')
  shots(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Req() req: Request) {
    return mapErrors(async () => {
      this.requireEpisode(prodId, episodeId);
      if (!(await this.covers(req, prodId))) {
        throw new ForbiddenException({ code: 'footage_hidden', message: 'Bạn không có quyền xem footage của production này' });
      }
      const view = episodeShots(this.engine.core, this.engine.db, episodeId);
      return {
        state: view.state,
        turnId: view.turnId,
        shots: await Promise.all(view.shots.map(async ({ frame_key, source_id, shot_id, ...x }) => ({
          ...x, sourceId: source_id, shotId: shot_id, frameUrl: frame_key ? await this.sign(frame_key) : null,
        }))),
      };
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
