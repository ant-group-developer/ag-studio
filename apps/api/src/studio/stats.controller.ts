import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CLAUDE_STATS_GROUPS, claudeStats } from '@ag-studio/engine';
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
}
