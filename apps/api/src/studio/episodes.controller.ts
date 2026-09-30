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
  episodeRunView,
  getEpisode,
  listEpisodes,
  readStageDocument,
  rerenderEpisode,
  retryStage,
  submitStudioGate,
  YoutubeKitSchema,
  validateYoutubeKit,
  type EpisodeRecord,
  type RunView,
} from '@ag-studio/engine';
import { IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from './engine.service';
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
// Status derivation (episodes.status stored but derived from run state)
// ---------------------------------------------------------------------------

type EpisodeStatus = 'planned' | 'producing' | 'ready' | 'failed' | 'cancelled';

function deriveStatus(ep: EpisodeRecord): EpisodeStatus {
  switch (ep.status) {
    case 'pending':    return 'planned';
    case 'in_progress': return 'producing';
    case 'producing':  return 'producing';
    case 'succeeded':  return 'ready';
    case 'failed':     return 'failed';
    default:           return 'planned';
  }
}

function toSummary(ep: EpisodeRecord) {
  return {
    id: ep.id,
    idx: ep.idx,
    title: ep.title,
    hook: ep.hook,
    status: deriveStatus(ep),
    currentStage: ep.current_stage ?? null,
    progress: null,
    durationSeconds: null,
    thumbnailUrl: null,
    updatedAt: ep.updated_at,
  };
}

/**
 * Episodes list / detail / PATCH / rerender / cancel / retry routes (GĐ2).
 * Base route: `/productions/:id/episodes`
 */
@Controller('productions/:id/episodes')
@UseGuards(RolesGuard)
export class EpisodesController {
  constructor(private readonly engine: EngineService) {}

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
  ) {
    return mapErrors(() => {
      const all = listEpisodes(this.engine.db, prodId);
      const ps = Math.min(Math.max(1, parseInt(pageSize, 10) || 20), 100);
      const pg = Math.max(1, parseInt(page, 10) || 1);
      const items = all
        .sort((a, b) => {
          const order = sortOrder === 'desc' ? -1 : 1;
          if (sortBy === 'title') return order * a.title.localeCompare(b.title, 'vi');
          if (sortBy === 'status') return order * a.status.localeCompare(b.status);
          if (sortBy === 'updatedAt') return order * a.updated_at.localeCompare(b.updated_at);
          return order * (a.idx - b.idx); // default: idx asc
        })
        .slice((pg - 1) * ps, pg * ps)
        .map(toSummary);
      return { items, total: all.length, page: pg, pageSize: ps };
    });
  }

  @Get(':episodeId')
  @Roles('viewer')
  detail(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Req() _req: Request) {
    return mapErrors(() => {
      const ep = getEpisode(this.engine.db, episodeId);
      if (!ep || ep.production_id !== prodId) {
        throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
      }
      let run: RunView | null = null;
      if (ep.run_id) {
        try { run = episodeRunView(this.engine.core, this.engine.db, episodeId); } catch { run = null; }
      }
      const plan = ep.plan ? JSON.parse(ep.plan) : null;
      const youtube = ep.youtube ? JSON.parse(ep.youtube) : null;
      return {
        ...toSummary(ep),
        plan,
        run,
        youtube,
        selectedTitle: ep.selected_title ?? 0,
        selectedThumbnail: ep.selected_thumbnail ?? 0,
        thumbnails: [],
        exportFiles: [],
        finalVideoUrl: null,
        latestRevision: null,
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
      return this.detail(prodId, episodeId, {} as Request);
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
  // Gates
  // ---------------------------------------------------------------------------

  /**
   * Submit the `freeze-timeline` gate for an episode.
   * No document body required — the gate reads the episode's latest timeline revision automatically.
   * Returns `{accepted: true}` or 422 `{code: 'gate_rejected', failed: [...]}`.
   */
  @Post(':episodeId/gates/freeze-timeline')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  freezeTimeline(@Param('id') prodId: string, @Param('episodeId') episodeId: string) {
    return mapErrors(async () => {
      const ep = getEpisode(this.engine.db, episodeId);
      if (!ep || ep.production_id !== prodId) {
        throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
      }
      if (!ep.run_id) throw new NotFoundException({ code: 'no_run', message: `episode ${episodeId} has no run` });
      const report = await submitStudioGate(this.engine.core, this.engine.db, ep.run_id, 'freeze-timeline');
      return { accepted: true, stageState: report.stageState, runState: report.runState };
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
