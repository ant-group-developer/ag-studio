import { CanActivate, ExecutionContext, ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  getMessage, getProject, getThread, getVideo, StudioRunError, verifyAgentToken,
  type ActorRole, type AgentTokenClaims, type MessageRecord, type ProjectRecord, type ThreadRecord, type VideoRecord,
} from '@ag-studio/engine';
import { EngineService } from '../studio/engine.service';

/** What a checked agent token gives a route: the running turn and what it works on. */
export interface AgentCall {
  claims: AgentTokenClaims;
  message: MessageRecord;
  thread: ThreadRecord;
  project: ProjectRecord;
  video: VideoRecord | null;
  role: ActorRole;
}

declare module 'express' {
  interface Request {
    agentCall?: AgentCall;
  }
}

/**
 * Lets a turn's MCP server in (spec 2026-10-10 agent-workspace §3.3): a valid, unexpired token whose message is still
 * running, in the thread and project the token names. Revocation is the message leaving `running`. The role is the
 * one the person had when they asked (stored on the turn); a turn without one acts as a viewer.
 */
@Injectable()
export class AgentTokenGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly engine: EngineService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const secret = this.config.get<string>('STUDIO_AGENT_TOKEN_SECRET');
    if (!secret) throw new ServiceUnavailableException({ code: 'agent_disabled', message: 'STUDIO_AGENT_TOKEN_SECRET chưa đặt' });
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    let claims: AgentTokenClaims;
    try {
      claims = verifyAgentToken(token, secret);
    } catch (e) {
      throw new UnauthorizedException({ code: 'bad_agent_token', message: e instanceof StudioRunError ? e.message : 'token không hợp lệ' });
    }
    const db = this.engine.db;
    const message = await getMessage(db, claims.msg);
    if (!message || message.status !== 'running' || message.thread_id !== claims.thread) {
      throw new ForbiddenException({ code: 'turn_not_running', message: 'lượt này đã kết thúc' });
    }
    const thread = await getThread(db, claims.thread);
    const project = await getProject(db, claims.project);
    if (!thread || !project || thread.project_id !== project.id || project.archived_at) {
      throw new ForbiddenException({ code: 'bad_scope', message: 'token không khớp dự án' });
    }
    const video = thread.video_id ? (await getVideo(db, thread.video_id)) ?? null : null;
    req.agentCall = { claims, message, thread, project, video, role: message.actor_role ?? 'viewer' };
    return true;
  }
}
