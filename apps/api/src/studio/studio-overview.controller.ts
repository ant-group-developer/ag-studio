import { BadRequestException, Body, Controller, ForbiddenException, Get, Put, Req, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Request } from 'express';
import {
  assistantName, claudeMaxConcurrent, claudeUsage, parseClaudeMaxConcurrent, setAssistantName, setClaudeMaxConcurrent, studioOverview,
  studioQueue,
} from '@ag-studio/engine';
import { AccountApiService } from '../auth/account-api.service';
import { EngineService } from './engine.service';
import { mapErrors } from './http-errors';

export class StudioSettingsDto {
  /** Claude calls at once for the whole Studio (chat and steps that run on their own). */
  @IsOptional() @IsInt() @Min(1) @Max(100) claudeMaxConcurrent?: number;
  /** The name the web shows for the AI; blank goes back to "Claude". */
  @IsOptional() @IsString() @MaxLength(60) assistantName?: string;
}

/**
 * Studio-wide reads for the chat UI: the videos a person can see (left column, home page), Claude calls in use (the
 * header chip), the Queue screen, and the settings only a Studio admin may change. No team in the path, so no
 * `@Roles`: lists are filtered by team membership here.
 */
@Controller('studio')
export class StudioOverviewController {
  constructor(
    private readonly engine: EngineService,
    private readonly accountApi: AccountApiService,
    private readonly config: ConfigService,
  ) {}

  @Get('overview')
  async overview(@Req() req: Request) {
    const isAdmin = await this.isAdmin(req);
    return { items: studioOverview(this.engine.core, this.engine.db, { userId: req.authContext!.userId, isAdmin }) };
  }

  /**
   * `running` counts stages and chat replies holding a slot; `waiting` the replies in line for one; `assistantName` is
   * what the web calls the AI.
   */
  @Get('claude')
  claude() {
    const cap = claudeMaxConcurrent(this.engine.db, this.envCap());
    return {
      ...claudeUsage(this.engine.db, this.engine.core.clock.now()), max: cap.value, source: cap.source, assistantName: assistantName(this.engine.db),
    };
  }

  /**
   * The Queue screen: Claude calls running and waiting, and the farm jobs not done (from ag-farm's owner API, which
   * lists no machines). The farm out of reach is `farm.ok = false`, not an error.
   */
  @Get('queue')
  async queue(@Req() req: Request) {
    const isAdmin = await this.isAdmin(req);
    const cap = claudeMaxConcurrent(this.engine.db, this.envCap());
    return studioQueue(this.engine.core, this.engine.db, this.engine.queueFarm, {
      userId: req.authContext!.userId, isAdmin, now: this.engine.core.clock.now(), claudeMax: cap.value,
    });
  }

  @Put('settings')
  async settings(@Body() dto: StudioSettingsDto, @Req() req: Request) {
    if (!(await this.isAdmin(req))) throw new ForbiddenException('Requires a Studio admin');
    if (dto.claudeMaxConcurrent === undefined && dto.assistantName === undefined) {
      throw new BadRequestException('Send claudeMaxConcurrent or assistantName');
    }
    return mapErrors(() => {
      const by = req.authContext!.userId;
      const now = this.engine.core.clock.now();
      // one transaction: a bad name does not leave the cap half saved
      try {
        this.engine.db.immediate(() => {
          if (dto.claudeMaxConcurrent !== undefined) setClaudeMaxConcurrent(this.engine.db, dto.claudeMaxConcurrent, by, now);
          if (dto.assistantName !== undefined) setAssistantName(this.engine.db, dto.assistantName, by, now);
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

  private async isAdmin(req: Request): Promise<boolean> {
    const ctx = req.authContext!;
    if (ctx.isAdmin === undefined) {
      try { ctx.isAdmin = (await this.accountApi.getUserProfile(ctx.accessToken, ctx.userId)).userType === 'ADMIN'; }
      catch { ctx.isAdmin = false; }
    }
    return ctx.isAdmin;
  }
}
