import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CLAUDE_STATS_GROUPS, CLAUDE_TURN_OUTCOMES, CLAUDE_TURN_SORTS, claudeStats, claudeTurn, claudeTurns } from '@ag-studio/engine';
import { AccountDirectoryService } from '../auth/account-directory.service';
import { StudioAdminService } from '../auth/studio-admin.service';
import { parseBody } from '../workspace/zod-body';
import { EngineService } from './engine.service';

const DAY_MS = 86_400_000;
const StatsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  groupBy: z.enum(CLAUDE_STATS_GROUPS).default('team'),
  teamId: z.string().min(1).max(200).optional(),
  projectId: z.string().min(1).max(200).optional(),
  /** Minutes east of UTC of the viewer, for the days of the series. */
  tz: z.coerce.number().int().min(-14 * 60).max(14 * 60).optional(),
}).strict();
const TurnsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  teamId: z.string().min(1).max(200).optional(),
  projectId: z.string().min(1).max(200).optional(),
  /** A video's turns; empty: the project's own chats. */
  videoId: z.string().max(200).optional(),
  userId: z.string().min(1).max(200).optional(),
  threadId: z.string().min(1).max(200).optional(),
  outcome: z.enum(CLAUDE_TURN_OUTCOMES).optional(),
  sortBy: z.enum(CLAUDE_TURN_SORTS).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

/**
 * Claude chat statistics by team, project, video or person over a period (default: the last 30 days): a Studio admin
 * sees every team, a team owner the teams they own. People are named from the Account API.
 */
@Controller('studio/stats')
export class StatsController {
  constructor(
    private readonly engine: EngineService,
    private readonly admin: StudioAdminService,
    private readonly directory: AccountDirectoryService,
  ) {}

  @Get('claude')
  async claude(@Query() raw: unknown, @Req() req: Request) {
    const q = parseBody(StatsQuerySchema, raw);
    const scope = await this.admin.viewScope(req, q.teamId);
    const to = q.to ? new Date(q.to) : new Date(this.engine.core.clock.now());
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY_MS);
    const stats = claudeStats(this.engine.db, {
      from: from.toISOString(), to: to.toISOString(), groupBy: q.groupBy,
      ...(scope.all ? {} : { teamIds: scope.teamIds }), ...(q.projectId ? { projectId: q.projectId } : {}), ...(q.tz !== undefined ? { tzOffsetMinutes: q.tz } : {}),
    });
    let rows = stats.rows;
    if (q.groupBy === 'user') {
      const people = await this.directory.summaries(rows.map((r) => r.key).filter((k): k is string => !!k));
      rows = rows.map((r) => ({ ...r, label: r.key ? people.get(r.key)?.name ?? people.get(r.key)?.email ?? null : null, user: r.key ? people.get(r.key) ?? null : null }));
    }
    return { from: from.toISOString(), to: to.toISOString(), groupBy: q.groupBy, ...stats, rows };
  }

  /** The turns behind the numbers, one by one (same scope and default period), each named with its person. */
  @Get('claude/turns')
  async turns(@Query() raw: unknown, @Req() req: Request) {
    const q = parseBody(TurnsQuerySchema, raw);
    const scope = await this.admin.viewScope(req, q.teamId);
    const to = q.to ? new Date(q.to) : new Date(this.engine.core.clock.now());
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY_MS);
    const { from: _f, to: _t, teamId: _team, ...filters } = q;
    const page = claudeTurns(this.engine.db, { from: from.toISOString(), to: to.toISOString(), ...(scope.all ? {} : { teamIds: scope.teamIds }), ...filters });
    const people = await this.directory.summaries([...new Set(page.items.map((r) => r.userId).filter((k): k is string => !!k))]);
    return { from: from.toISOString(), to: to.toISOString(), ...page, items: page.items.map((r) => ({ ...r, user: r.userId ? people.get(r.userId) ?? null : null })) };
  }

  /** One turn in full: what asked for it, its answer, every tool it called, the files it changed. */
  @Get('claude/turns/:turnId')
  async turn(@Param('turnId') turnId: string, @Req() req: Request) {
    const scope = await this.admin.viewScope(req);
    const turn = claudeTurn(this.engine.db, turnId, scope.all ? {} : { teamIds: scope.teamIds });
    if (!turn) throw new NotFoundException(`không có lượt ${turnId}`);
    const people = await this.directory.summaries([turn.userId, turn.promptBy].filter((k): k is string => !!k));
    return { ...turn, user: turn.userId ? people.get(turn.userId) ?? null : null, promptUser: turn.promptBy ? people.get(turn.promptBy) ?? null : null };
  }
}
