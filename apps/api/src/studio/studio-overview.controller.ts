import { Body, Controller, ForbiddenException, Get, Put, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsInt, Max, Min } from 'class-validator';
import { Request } from 'express';
import {
  claudeMaxConcurrent, claudeUsage, parseClaudeMaxConcurrent, setClaudeMaxConcurrent, studioOverview,
} from '@ag-studio/engine';
import { AccountApiService } from '../auth/account-api.service';
import { EngineService } from './engine.service';
import { mapErrors } from './http-errors';

export class StudioSettingsDto {
  /** Claude calls at once for the whole Studio (chat and steps that run on their own). */
  @IsInt() @Min(1) @Max(100) claudeMaxConcurrent!: number;
}

/**
 * Studio-wide reads for the chat UI: the videos a person can see (left column, home page), Claude calls in use (the
 * header chip), and the settings only a Studio admin may change. No team in the path, so no `@Roles`: the list is
 * filtered by team membership here.
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

  /** `running` counts stages and chat replies holding a slot; `waiting` the replies in line for one. */
  @Get('claude')
  claude() {
    const cap = claudeMaxConcurrent(this.engine.db, this.envCap());
    return { ...claudeUsage(this.engine.db, this.engine.core.clock.now()), max: cap.value, source: cap.source };
  }

  @Put('settings')
  async settings(@Body() dto: StudioSettingsDto, @Req() req: Request) {
    if (!(await this.isAdmin(req))) throw new ForbiddenException('Requires a Studio admin');
    return mapErrors(() => {
      setClaudeMaxConcurrent(this.engine.db, dto.claudeMaxConcurrent, req.authContext!.userId, this.engine.core.clock.now());
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
