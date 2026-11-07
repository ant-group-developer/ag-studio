import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  DIAGNOSTICS_MAX_DAYS, diagnosticsErrors, diagnosticsOverview, diagnosticsRenders, farmJobsSummary, periodDays, type DiagnosticsPeriod, type FarmJobsSummary,
} from '@ag-studio/engine';
import { StudioAdminService } from '../auth/studio-admin.service';
import { EngineService } from '../studio/engine.service';
import { parseBody } from '../workspace/zod-body';

const DAY_MS = 86_400_000;
const PeriodQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  /** Minutes east of UTC of the viewer, for the days of the series. */
  tz: z.coerce.number().int().min(-14 * 60).max(14 * 60).optional(),
}).strict();

/**
 * Diagnostics of a period for a Studio admin (plan 2026-11-07): what failed and how renders ran, against the period
 * just before. Default period: the last 14 days; at most 90.
 */
@Controller('studio/diagnostics')
export class DiagnosticsController {
  constructor(
    private readonly engine: EngineService,
    private readonly admin: StudioAdminService,
  ) {}

  protected async period(raw: unknown, req: Request): Promise<DiagnosticsPeriod> {
    await this.admin.requireAdmin(req);
    const q = parseBody(PeriodQuerySchema, raw);
    const to = q.to ? new Date(q.to) : new Date(this.engine.core.clock.now());
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 14 * DAY_MS);
    const p: DiagnosticsPeriod = { from: from.toISOString(), to: to.toISOString(), ...(q.tz !== undefined ? { tzOffsetMinutes: q.tz } : {}) };
    const days = periodDays(p);
    if (!(days > 0)) throw new BadRequestException('"from" phải trước "to"');
    if (days > DIAGNOSTICS_MAX_DAYS + 1e-9) throw new BadRequestException(`khoảng thời gian tối đa ${DIAGNOSTICS_MAX_DAYS} ngày`);
    return p;
  }

  @Get('overview')
  async overview(@Query() raw: unknown, @Req() req: Request) {
    const p = await this.period(raw, req);
    return { ...p, ...(await diagnosticsOverview(this.engine.db, p, new Date(this.engine.core.clock.now()).toISOString())) };
  }

  /**
   * How renders ran (Studio's jobs, by kind and by machine, machines named from the farm) and the farm's own view of
   * its jobs of the period: counts, retries, failures by code. The farm out of reach: `farm` null, `farmError` says why.
   */
  @Get('renders')
  async renders(@Query() raw: unknown, @Req() req: Request) {
    const p = await this.period(raw, req);
    const stats = await diagnosticsRenders(this.engine.db, p);
    let farm: (FarmJobsSummary & { truncated: boolean }) | null = null;
    let farmError: string | null = null;
    const names = new Map<string, string>();
    try {
      for (const n of (await this.engine.farmNodes()).nodes) names.set(n.id, n.name);
      const { jobs, truncated } = await this.engine.farmJobsSince(p.from);
      farm = { ...farmJobsSummary(jobs, p), truncated };
    } catch (e) {
      farmError = e instanceof Error ? e.message : String(e);
    }
    const name = (id: string) => names.get(id) ?? null;
    return {
      ...p, ...stats, nodes: stats.nodes.map((n) => ({ ...n, name: name(n.nodeId) })),
      farm: farm && { ...farm, errors: farm.errors.map((g) => ({ ...g, nodes: g.nodes.map((id) => name(id) ?? id) })) }, farmError,
    };
  }

  @Get('errors')
  async errors(@Query() raw: unknown, @Req() req: Request) {
    const p = await this.period(raw, req);
    return { ...p, ...(await diagnosticsErrors(this.engine.db, p)) };
  }
}
