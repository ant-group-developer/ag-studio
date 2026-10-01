import { Controller, ForbiddenException, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import {
  getEpisode,
  getLlmCall,
  listHumanEdits,
  listLlmCalls,
  readLlmCallPayload,
  type HumanEditRow,
  type LlmCallRow,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from './engine.service';
import { FootageAccessService } from './footage-access.service';
import { mapErrors } from './http-errors';

interface Problem { code: string; message: string }

function pageOf(page: string, pageSize: string): { page: number; pageSize: number } {
  return { page: Math.max(1, parseInt(page, 10) || 1), pageSize: Math.min(Math.max(1, parseInt(pageSize, 10) || 20), 100) };
}

/**
 * The production's call log: every Claude call (prompt, answer, what the check said) and every human edit of a
 * model answer. Prompts carry the footage catalog, so the log is for editors whose own ag-go scope covers the
 * production (or admins). Base route: `/productions/:id`.
 */
@Controller('productions/:id')
@UseGuards(RolesGuard)
export class LlmLogController {
  constructor(
    private readonly engine: EngineService,
    private readonly access: FootageAccessService,
  ) {}

  private async requireScope(req: Request, prodId: string): Promise<void> {
    if (req.authContext?.isAdmin) return;
    if (!(await this.access.coversProduction(req.authContext!.userId, prodId))) {
      throw new ForbiddenException({ code: 'footage_scope', message: 'the log shows footage outside your ag-go scope' });
    }
  }

  private episodeIdx(episodeId: string | null): number | null {
    return episodeId ? getEpisode(this.engine.db, episodeId)?.idx ?? null : null;
  }

  private callView(r: LlmCallRow) {
    return {
      id: r.id, createdAt: r.created_at, episodeId: r.episode_id, episodeIdx: this.episodeIdx(r.episode_id),
      stageKey: r.stage_key, skill: r.skill, model: r.model, round: r.round, outcome: r.outcome,
      problems: JSON.parse(r.problems) as Problem[],
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUsd: r.cost_usd, wallSeconds: r.wall_seconds,
      hasPayload: r.payload_key !== null,
    };
  }

  private editView(e: HumanEditRow) {
    return {
      id: e.id, createdAt: e.created_at, userId: e.user_id, episodeId: e.episode_id, episodeIdx: this.episodeIdx(e.episode_id),
      kind: e.kind, llmCallId: e.llm_call_id, changed: e.changed === 1,
      before: e.before ? JSON.parse(e.before) : null, after: e.after ? JSON.parse(e.after) : null,
    };
  }

  @Get('llm-calls')
  @Roles('editor')
  list(
    @Param('id') prodId: string,
    @Req() req: Request,
    @Query('episodeId') episodeId?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return mapErrors(async () => {
      await this.requireScope(req, prodId);
      const p = pageOf(page, pageSize);
      const out = listLlmCalls(this.engine.db, { productionId: prodId, ...(episodeId ? { episodeId } : {}), ...p });
      return { items: out.items.map((r) => this.callView(r)), total: out.total, ...p };
    });
  }

  @Get('llm-calls/:callId')
  @Roles('editor')
  detail(@Param('id') prodId: string, @Param('callId') callId: string, @Req() req: Request) {
    return mapErrors(async () => {
      await this.requireScope(req, prodId);
      const row = getLlmCall(this.engine.db, callId);
      if (!row || row.production_id !== prodId) throw new NotFoundException({ code: 'not_found', message: `call ${callId} not found` });
      const payload = row.payload_key ? await readLlmCallPayload(this.engine.bucket, row.payload_key) : null;
      return {
        ...this.callView(row),
        prompt: payload?.prompt ?? null,
        response: payload?.response ?? null,
        structuredOutput: payload?.structured_output ?? null,
        warnings: (payload?.warnings ?? []).map((w) => ({ code: w.code, message: w.message })) as Problem[],
      };
    });
  }

  @Get('human-edits')
  @Roles('editor')
  edits(@Param('id') prodId: string, @Req() req: Request, @Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return mapErrors(async () => {
      await this.requireScope(req, prodId);
      const p = pageOf(page, pageSize);
      const out = listHumanEdits(this.engine.db, { productionId: prodId, ...p });
      return { items: out.items.map((e) => this.editView(e)), total: out.total, ...p };
    });
  }
}
