import { BadRequestException, Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  DIAGNOSTICS_MAX_DAYS, diagnosticsErrors, diagnosticsReportMarkdown, videoChats, type DiagnosticsBundle, diagnosticsOverview, diagnosticsRenders, farmJobsSummary, periodDayRange, periodDays, videoQuality, type DiagnosticsPeriod, type FarmJobsSummary,
} from '@ag-studio/engine';
import { StudioAdminService } from '../auth/studio-admin.service';
import { EngineService } from '../studio/engine.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { parseBody } from '../workspace/zod-body';

const DAY_MS = 86_400_000;
const PeriodQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  /** Minutes east of UTC of the viewer, for the days of the series. */
  tz: z.coerce.number().int().min(-14 * 60).max(14 * 60).optional(),
}).strict();
const ExportQuerySchema = PeriodQuerySchema.extend({
  /** `md`: the summary alone; `json` (default): every section's data with the summary in `report`. */
  format: z.enum(['json', 'md']).default('json'),
  /** `1`: also the chats of the videos measured (people's messages: only when asked). */
  chats: z.enum(['0', '1']).default('0'),
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
    private readonly workspace: WorkspaceService,
  ) {}

  protected async period(raw: unknown, req: Request, schema: z.ZodType<z.infer<typeof PeriodQuerySchema>> = PeriodQuerySchema): Promise<DiagnosticsPeriod> {
    await this.admin.requireAdmin(req);
    const q = parseBody(schema, raw);
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

  /**
   * How the videos rendered in the period are made (one row each: its latest final, else its latest preview): the cut,
   * the voice, the render worker's check of the file, the asks after the first render; flags and how many videos
   * have each. At most 300 videos, the newest.
   */
  @Get('videos')
  async videos(@Query() raw: unknown, @Req() req: Request) {
    const p = await this.period(raw, req);
    return { ...p, ...(await videoQuality(this.engine.db, p, { workspacesRoot: this.workspace.root })) };
  }

  /**
   * Every section of the period in one file to keep or give to Claude: JSON with the Markdown summary in `report`
   * (`format=md`: the summary alone), the chats of the videos measured with `chats=1`.
   */
  @Get('export')
  async export(@Query() raw: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const q = parseBody(ExportQuerySchema, raw);
    const { format, chats, ...period } = q;
    const p = await this.period(period, req);
    const [overview, errors, renders, videos] = [
      await this.overview(period, req), await this.errors(period, req), await this.renders(period, req), await this.videos(period, req),
    ];
    const bundle: DiagnosticsBundle = {
      period: p, generatedAt: new Date(this.engine.core.clock.now()).toISOString(), overview, errors, renders, videos,
      ...(chats === '1' ? { chats: await videoChats(this.engine.db, videos.rows.map((v) => v.videoId), p) } : {}),
    };
    const report = diagnosticsReportMarkdown(bundle);
    const days = periodDayRange(p);
    const name = `chan-doan-${days.first}-${days.last}`;
    if (format === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.md"`);
      res.send(report);
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.json"`);
    res.send(JSON.stringify({ report, ...bundle }, null, 2));
  }

  @Get('errors')
  async errors(@Query() raw: unknown, @Req() req: Request) {
    const p = await this.period(raw, req);
    return { ...p, ...(await diagnosticsErrors(this.engine.db, p)) };
  }
}
