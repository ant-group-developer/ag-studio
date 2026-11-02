import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, Put, Req, UnprocessableEntityException, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { Request } from 'express';
import {
  claudeAccountView, claudeUsageByAccount, createClaudeAccount, deleteClaudeAccount, getClaudeAccount, listClaudeAccounts, requestClaudeAccountCheck,
  secretKey, setTeamClaudeAccounts, setTeamFarmPool, teamClaudeAccountIds, teamFarmPool, updateClaudeAccount,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { StudioAdminService } from '../auth/studio-admin.service';
import { EngineService } from './engine.service';

export class CreateClaudeAccountDto {
  @IsString() @MaxLength(60) name!: string;
  /** What `claude setup-token` prints. */
  @IsString() @MaxLength(2000) token!: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(100) maxConcurrent?: number | null;
}

export class UpdateClaudeAccountDto {
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) token?: string;
  /** null: only Studio's cap. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(100) maxConcurrent?: number | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class TeamResourcesDto {
  /** The team's Claude accounts in the order its turns try them; empty: the default account. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) claudeAccountIds?: string[];
  /** The farm pool its jobs run on; null or "": the shared machines. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40) farmPool?: string | null;
}

/** The engine's HarnessError (`@harness/contracts` is not a dependency of the API) → HTTP. */
async function engineErrors<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === 'CONFIG_INVALID') throw new UnprocessableEntityException({ message: err.message, code: 'invalid_setting' });
    if (err.code === 'NOT_FOUND') throw new NotFoundException({ message: err.message, code: 'not_found' });
    throw e;
  }
}

/**
 * Claude accounts (plan 2026-10-30): only a Studio admin sees or changes them; a token is never sent back. Which
 * accounts and which farm pool a team uses: the team's owners read it, only an admin sets it.
 */
@Controller()
@UseGuards(RolesGuard)
export class ClaudeAccountsController {
  constructor(
    private readonly engine: EngineService,
    private readonly admin: StudioAdminService,
    private readonly config: ConfigService,
  ) {}

  private key() { return secretKey(this.config.get<string>('STUDIO_SECRET_KEY')); }
  private now() { return this.engine.core.clock.now(); }

  /** Every account with the turns running on it now; `canStoreTokens`: STUDIO_SECRET_KEY is set. */
  @Get('studio/claude-accounts')
  async list(@Req() req: Request) {
    await this.admin.requireAdmin(req);
    const running = await claudeUsageByAccount(this.engine.db, this.now());
    const accounts = (await listClaudeAccounts(this.engine.db)).map((a) => ({ ...a, running: running.get(a.id) ?? 0 }));
    return { accounts, canStoreTokens: this.key() !== null };
  }

  @Post('studio/claude-accounts')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateClaudeAccountDto, @Req() req: Request) {
    await this.admin.requireAdmin(req);
    return engineErrors(async () => claudeAccountView(await createClaudeAccount(this.engine.db, this.key(), dto, req.authContext!.userId, this.now())));
  }

  @Patch('studio/claude-accounts/:id')
  async update(@Param('id') id: string, @Body() dto: UpdateClaudeAccountDto, @Req() req: Request) {
    await this.admin.requireAdmin(req);
    return engineErrors(async () => claudeAccountView(await updateClaudeAccount(this.engine.db, this.key(), id, dto, this.now())));
  }

  @Delete('studio/claude-accounts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @Req() req: Request) {
    await this.admin.requireAdmin(req);
    await engineErrors(() => deleteClaudeAccount(this.engine.db, id));
  }

  /** "Kiểm tra": a worker makes one tiny call on it; the list shows how it went. */
  @Post('studio/claude-accounts/:id/check')
  async check(@Param('id') id: string, @Req() req: Request) {
    await this.admin.requireAdmin(req);
    return engineErrors(async () => claudeAccountView(await requestClaudeAccountCheck(this.engine.db, id, this.now())));
  }

  @Get('teams/:teamId/resources')
  @Roles('owner')
  async teamResources(@Param('teamId') teamId: string) {
    const ids = await teamClaudeAccountIds(this.engine.db, teamId);
    const accounts = [];
    for (const id of ids) {
      const a = await getClaudeAccount(this.engine.db, id);
      if (a) accounts.push({ id: a.id, name: a.name, enabled: a.enabled });
    }
    return { claudeAccounts: accounts, farmPool: await teamFarmPool(this.engine.db, teamId) };
  }

  @Put('teams/:teamId/resources')
  @Roles('owner')
  async setTeamResources(@Param('teamId') teamId: string, @Body() dto: TeamResourcesDto, @Req() req: Request) {
    await this.admin.requireAdmin(req);
    await engineErrors(() => this.engine.db.tx(async () => {
      if (dto.claudeAccountIds !== undefined) await setTeamClaudeAccounts(this.engine.db, teamId, dto.claudeAccountIds);
      if (dto.farmPool !== undefined) await setTeamFarmPool(this.engine.db, teamId, dto.farmPool, this.now());
    }));
    return this.teamResources(teamId);
  }
}
