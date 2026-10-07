import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UnprocessableEntityException,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { distinctUntilChanged, interval, map, merge, Observable, startWith } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { Request } from 'express';
import {
  applyChatProposal,
  approveChatScope,
  chatFingerprint,
  chatScopeFor,
  chatThread,
  createDraftProduction,
  getTurn,
  messageMentions,
  retryStageWithFeedback,
  saveManualEdit,
  sendChatMessage,
  startFromIntake,
  type IntakeFolder,
  RENDER_MACHINES,
  type RenderMachine,
} from '@ag-studio/engine';
import { AgGoClient } from '../ag-go/client';
import { RawResponse } from '../common/raw-response.decorator';
import { Roles, type TeamRole } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { StudioDbService } from '../db/studio-db.service';
import { EngineService } from './engine.service';
import { mapErrors } from './http-errors';

const ORDER: TeamRole[] = ['viewer', 'editor', 'producer', 'owner'];
export const CHAT_MESSAGE_MAX = 4000;

export class ChatMessageDto {
  @IsString() @MinLength(1) @MaxLength(CHAT_MESSAGE_MAX) text!: string;
  @IsOptional() @IsString() episodeId?: string;
}

export class ChatDraftDto {
  @IsString() @MinLength(1) @MaxLength(CHAT_MESSAGE_MAX) text!: string;
}

export class ChatApproveDto {
  @IsString() stageKey!: string;
  @IsOptional() @IsString() episodeId?: string;
  /** The turn of the version on show (absent/null: what the stage wrote). A newer version answers 409 `stale_version`. */
  @IsOptional() @IsString() turnId?: string | null;
  /** Approving `approve-youtube-kit` starts the final render: the farm machine type it runs on (any other gate: 422). */
  @IsOptional() @IsIn(RENDER_MACHINES) renderMachine?: RenderMachine;
  /** …and the one farm node it must run on (`GET /api/studio/farm/nodes`); with `renderMachine` only. */
  @IsOptional() @IsUUID() renderNodeId?: string;
}

export class ChatStepDto {
  @IsString() stageKey!: string;
  @IsOptional() @IsString() episodeId?: string;
}

export class ChatManualEditDto extends ChatStepDto {
  @IsObject() document!: Record<string, unknown>;
}

export class ChatThreadQuery {
  @IsOptional() @IsString() episodeId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) after?: number;
}

/** The ag-go folders a person sees, for the intake prompt and to check `@folder` mentions. */
@Injectable()
export class ChatFolders {
  private readonly agGo: AgGoClient;
  constructor(config: ConfigService) {
    this.agGo = new AgGoClient({
      baseUrl: config.get<string>('AG_GO_API_URL') as string,
      serviceKey: config.get<string>('AG_GO_SERVICE_KEY') as string,
    });
  }
  async forUser(userId: string): Promise<IntakeFolder[]> {
    const r = await this.agGo.getFolders(userId);
    return r.folders.map((f) => ({ id: f.id, name: f.name, usableVideos: f.usableVideos }));
  }
}

/** How often the chat event stream looks at `studio.db`, and how often it says it is alive. */
const CHAT_EVENTS_CHECK_MS = 1000;
const CHAT_EVENTS_PING_MS = 20_000;

/**
 * Chat with Claude on a production (spec local-chat §3.1): one thread per production and one per episode. A message
 * goes to the step the production is at; Claude's reply is written by the worker. Approving, applying and starting
 * are buttons, never chat words.
 */
@Controller()
@UseGuards(RolesGuard)
export class ChatController {
  constructor(
    private readonly engine: EngineService,
    private readonly db: StudioDbService,
    private readonly folders: ChatFolders,
  ) {}

  /** A new video from one message: a draft production of the team and the first intake message. */
  @Post('teams/:teamId/drafts')
  @Roles('producer')
  @HttpCode(HttpStatus.CREATED)
  async createDraft(@Param('teamId') teamId: string, @Body() dto: ChatDraftDto, @Req() req: Request) {
    const userId = req.authContext!.userId;
    const folders = await this.checkedFolders(userId, dto.text);
    return mapErrors(() => {
      const productionId = createDraftProduction(this.engine.db, teamId, userId, this.engine.core.clock.now());
      const sent = sendChatMessage(this.engine.core, this.engine.db, { productionId, text: dto.text, userId, context: { folders } });
      return { productionId, user: sent.user, assistant: sent.assistant };
    });
  }

  @Get('productions/:id/chat')
  @Roles('viewer')
  thread(@Param('id') id: string, @Query() q: ChatThreadQuery) {
    return mapErrors(() => chatThread(this.engine.core, this.engine.db, id, {
      episodeId: q.episodeId ?? null, ...(q.after !== undefined ? { after: q.after } : {}),
    }));
  }

  /**
   * Server-sent events of the chat (deferred-items: "Không có SSE"): `changed` with the chat's fingerprint whenever
   * the thread may have changed (checked every second here, against `studio.db`), and `ping` every 20 s to keep
   * proxies from closing an idle stream. The web reads the thread on `changed` instead of polling it every 2–5 s.
   * Browsers cannot set headers on `EventSource`: the web reads this with `fetch`, which sends the bearer token.
   */
  @Sse('productions/:id/chat/events')
  @Roles('viewer')
  @RawResponse()
  events(@Param('id') id: string, @Query() q: ChatThreadQuery): Observable<MessageEvent> {
    const episodeId = q.episodeId ?? null;
    const changes = interval(CHAT_EVENTS_CHECK_MS).pipe(
      startWith(0),
      map(() => chatFingerprint(this.engine.db, id, episodeId)),
      distinctUntilChanged(),
      map((fingerprint): MessageEvent => ({ type: 'changed', data: { fingerprint } })),
    );
    const pings = interval(CHAT_EVENTS_PING_MS).pipe(map((): MessageEvent => ({ type: 'ping', data: '' })));
    return merge(changes, pings);
  }

  @Post('productions/:id/chat')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  async send(@Param('id') id: string, @Body() dto: ChatMessageDto, @Req() req: Request) {
    const userId = req.authContext!.userId;
    const key = await mapErrors(() => chatScopeFor(this.engine.core, this.engine.db, id, dto.episodeId ?? null));
    const needFolders = key.scope === 'intake' || messageMentions(dto.text).length > 0;
    const folders = needFolders ? await this.checkedFolders(userId, dto.text) : null;
    return mapErrors(() => {
      const sent = sendChatMessage(this.engine.core, this.engine.db, {
        productionId: id, episodeId: dto.episodeId ?? null, text: dto.text, userId, ...(folders ? { context: { folders } } : {}),
      });
      return { user: sent.user, assistant: sent.assistant };
    });
  }

  /** Áp dụng: the intake draft (producer) or timeline edits (editor). */
  @Post('productions/:id/chat/:turnId/apply')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  apply(@Param('id') id: string, @Param('turnId') turnId: string, @Req() req: Request) {
    return mapErrors(() => {
      const turn = getTurn(this.engine.db, turnId);
      if (turn?.scope === 'intake') this.requireRole(req, id, 'producer');
      return applyChatProposal(this.engine.core, this.engine.db, { productionId: id, turnId, userId: req.authContext!.userId });
    });
  }

  /** Bắt đầu: writes the newest intake draft and starts the series; 422 `intake_incomplete` with `missing`. */
  @Post('productions/:id/start')
  @Roles('producer')
  @HttpCode(HttpStatus.CREATED)
  start(@Param('id') id: string) {
    return mapErrors(() => startFromIntake(this.engine.core, this.engine.db, id));
  }

  /** Duyệt: the version on show at the waiting gate; 409 `stale_version` / `stale_step` when the screen is behind. */
  @Post('productions/:id/chat/approve')
  @Roles('producer')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id') id: string, @Body() dto: ChatApproveDto, @Req() req: Request) {
    return mapErrors(async () => {
      const renderNode = dto.renderNodeId && dto.renderMachine !== undefined ? await this.engine.renderNode(dto.renderNodeId) : null;
      return approveChatScope(this.engine.core, this.engine.db, {
        productionId: id, episodeId: dto.episodeId ?? null, stageKey: dto.stageKey, turnId: dto.turnId ?? null, userId: req.authContext!.userId,
        ...(dto.renderMachine !== undefined ? { renderMachine: dto.renderMachine, renderNode } : {}),
      });
    });
  }

  /** Chạy lại a Claude stage that failed its check, with what was said in the chat. */
  @Post('productions/:id/chat/retry')
  @Roles('producer')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(@Param('id') id: string, @Body() dto: ChatStepDto) {
    return mapErrors(() => {
      retryStageWithFeedback(this.engine.core, this.engine.db, id, { episodeId: dto.episodeId ?? null, stageKey: dto.stageKey });
      return { ok: true };
    });
  }

  /** Sửa tay: a version written by hand becomes the one on show. */
  @Post('productions/:id/chat/manual')
  @Roles('producer')
  @HttpCode(HttpStatus.CREATED)
  manual(@Param('id') id: string, @Body() dto: ChatManualEditDto, @Req() req: Request) {
    return mapErrors(() => saveManualEdit(this.engine.core, this.engine.db, {
      productionId: id, episodeId: dto.episodeId ?? null, stageKey: dto.stageKey, document: dto.document, userId: req.authContext!.userId,
    }));
  }

  // ---------------------------------------------------------------------------

  /** The person's folders; a `@folder` they cannot see is refused (422), like `POST productions/:id/sources`. */
  private async checkedFolders(userId: string, text: string): Promise<IntakeFolder[]> {
    const folders = await this.folders.forUser(userId);
    const known = new Set(folders.map((f) => f.id));
    const unknown = messageMentions(text).filter((m) => !known.has(m.id));
    if (unknown.length) {
      throw new UnprocessableEntityException({ code: 'folder_not_accessible', message: `Folder không truy cập được: ${unknown.map((m) => m.name).join(', ')}`, folderIds: unknown.map((m) => m.id) });
    }
    return folders;
  }

  private requireRole(req: Request, productionId: string, role: TeamRole): void {
    if (req.authContext?.isAdmin) return;
    const row = this.db.get<{ role: TeamRole }>(
      'SELECT tm.role FROM team_members tm JOIN productions p ON p.team_id = tm.team_id WHERE p.id = ? AND tm.user_id = ?',
      [productionId, req.authContext!.userId],
    );
    if (!row || ORDER.indexOf(row.role) < ORDER.indexOf(role)) throw new ForbiddenException(`Requires role: ${role}`);
  }
}
