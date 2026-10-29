import { BadRequestException, Body, Controller, Get, Put, Req, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Request } from 'express';
import {
  assistantName, claudeMaxConcurrent, claudeUsage, claudeUsageByAccount, listClaudeAccounts, parseClaudeMaxConcurrent, referenceFetchNodes, setAssistantName, setClaudeMaxConcurrent, studioActivity,
  youtubeBlock,
} from '@ag-studio/engine';
import { StudioAdminService } from '../auth/studio-admin.service';
import { EngineService } from './engine.service';
import { mapErrors } from './http-errors';

export class StudioSettingsDto {
  /** Claude calls at once for the whole Studio (chat and steps that run on their own). */
  @IsOptional() @IsInt() @Min(1) @Max(100) claudeMaxConcurrent?: number;
  /** The name the web shows for the AI; blank goes back to "Claude". */
  @IsOptional() @IsString() @MaxLength(60) assistantName?: string;
}

/**
 * Studio-wide reads: Claude calls in use (the header chip), the Queue screen, the farm's machines, and the settings
 * only a Studio admin may change. No team in the path, so no `@Roles`: the Queue is filtered by team membership here.
 */
@Controller('studio')
export class StudioOverviewController {
  constructor(
    private readonly engine: EngineService,
    private readonly admin: StudioAdminService,
    private readonly config: ConfigService,
  ) {}

  /**
   * `running` counts agent turns and thread summaries holding a slot; `waiting` the turns in line for one;
   * `assistantName` is what the web calls the AI.
   */
  @Get('claude')
  async claude() {
    const cap = await claudeMaxConcurrent(this.engine.db, this.envCap());
    return {
      ...(await claudeUsage(this.engine.db, this.engine.core.clock.now())), max: cap.value, source: cap.source, assistantName: await assistantName(this.engine.db),
    };
  }

  /**
   * The Queue screen: what runs in the projects a person can see (agent turns, their tools, jobs with their farm
   * machine), Claude slots, and the farm's machines. The farm out of reach is `farm.ok = false`, not an error.
   * `youtube`: YouTube refusing to let the Studio server download (since when, until when Studio assumes so), else null;
   * `youtubeFarm`: the same for the farm's machines; `referenceFetchers`: names of the machines online that fetch
   * reference videos instead (`studio.reference_fetch`), null when the farm is out of reach.
   */
  @Get('queue')
  async queue(@Req() req: Request) {
    const isAdmin = await this.admin.isAdmin(req);
    const { items, hidden } = await studioActivity(this.engine.db, { userId: req.authContext!.userId, isAdmin });
    let machines = null;
    let farm: { ok: true } | { ok: false; error: string } = { ok: true };
    try { machines = (await this.engine.farmNodes()).nodes; } catch (e) { farm = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const now = this.engine.core.clock.now();
    // an admin sees each Claude account: turns on it now, and whether it waits for its plan's limit
    let claudeAccounts = null;
    if (isAdmin) {
      const running = await claudeUsageByAccount(this.engine.db, now);
      claudeAccounts = (await listClaudeAccounts(this.engine.db)).map((a) => ({
        id: a.id, name: a.name, isDefault: a.isDefault, enabled: a.enabled, maxConcurrent: a.maxConcurrent, running: running.get(a.id) ?? 0,
        rateLimitedUntil: a.rateLimitedUntil && a.rateLimitedUntil > now ? a.rateLimitedUntil : null, lastError: a.lastError, teams: a.teams,
      }));
    }
    return {
      claude: await this.claude(), claudeAccounts, items, hidden, machines, farm,
      youtube: await youtubeBlock(this.engine.db, now), youtubeFarm: await youtubeBlock(this.engine.db, now, 'farm'),
      referenceFetchers: machines ? referenceFetchNodes(machines).map((n) => n.name) : null,
    };
  }

  /** The farm machines a final render may be pinned to: those taking `studio.render_final`; none when out of reach. */
  @Get('farm/nodes')
  async farmNodes() {
    try {
      const { nodes } = await this.engine.farmNodes();
      return { nodes: nodes.filter((n) => n.kinds.includes('studio.render_final')) };
    } catch {
      return { nodes: [] };
    }
  }

  /** Studio admin: the farm's pools (`pool` of each machine) and how many machines each has; none when out of reach. */
  @Get('farm/pools')
  async farmPools(@Req() req: Request) {
    await this.admin.requireAdmin(req);
    try {
      const counts = new Map<string, number>();
      for (const n of (await this.engine.farmNodes()).nodes) if (n.pool) counts.set(n.pool, (counts.get(n.pool) ?? 0) + 1);
      return { pools: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([pool, machines]) => ({ pool, machines })) };
    } catch {
      return { pools: [] };
    }
  }

  @Put('settings')
  async settings(@Body() dto: StudioSettingsDto, @Req() req: Request) {
    await this.admin.requireAdmin(req);
    if (dto.claudeMaxConcurrent === undefined && dto.assistantName === undefined) {
      throw new BadRequestException('Send claudeMaxConcurrent or assistantName');
    }
    return mapErrors(async () => {
      const by = req.authContext!.userId;
      const now = this.engine.core.clock.now();
      // one transaction: a bad name does not leave the cap half saved
      try {
        await this.engine.db.tx(async () => {
          if (dto.claudeMaxConcurrent !== undefined) await setClaudeMaxConcurrent(this.engine.db, dto.claudeMaxConcurrent, by, now);
          if (dto.assistantName !== undefined) await setAssistantName(this.engine.db, dto.assistantName, by, now);
        });
      } catch (e) {
        // the engine's HarnessError (`@harness/contracts` is not a dependency of the API)
        const err = e as { code?: string; message?: string };
        if (err.code === 'CONFIG_INVALID') throw new UnprocessableEntityException({ message: err.message, code: 'invalid_setting' });
        throw e;
      }
      return this.claude();
    });
  }

  /** The worker's env default; the API does not need the key, so a missing or bad one reads as the default. */
  private envCap(): number {
    try { return parseClaudeMaxConcurrent(this.config.get<string>('STUDIO_CLAUDE_MAX_CONCURRENT')); } catch { return parseClaudeMaxConcurrent(undefined); }
  }
}
