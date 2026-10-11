import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, MessageEvent, Param, Patch, Post, Put, Query, Req, Sse, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { interval, map, merge, Observable, startWith, filter, distinctUntilChanged } from 'rxjs';
import { z } from 'zod';
import {
  agentActivity, archiveThread, createThread, getMessage, listMessages, listThreadRefs, listThreads, messageView, normalizeRelPath,
  postUserMessage, projectFingerprint, renameThread, requestCancel, requireProject, requireThread, setThreadLearning, StudioRunError,
  type Activity, type ActorRole, type MessageRecord, type MessageView, type ThreadListRow, type ThreadRecord,
} from '@ag-studio/engine';
import { RawResponse } from '../common/raw-response.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { parseBody } from './zod-body';

/** How often the thread stream looks for changed messages (a running turn writes every ~300 ms). */
const THREAD_EVENTS_MS = 400;
const PROJECT_EVENTS_MS = 1000;
const PING_MS = 20_000;

export const LearningSchema = z.object({
  /** Load the project's lessons (memory/lessons.md). */
  useLessons: z.boolean().default(true),
  /** Earlier threads of the project to learn from. */
  threads: z.array(z.object({ threadId: z.string().min(1), mode: z.enum(['summary', 'full']) }).strict()).max(20).default([]),
}).strict();

const CreateThreadSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  learning: LearningSchema.optional(),
}).strict();
const SendSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** Workspace paths the message points the agent at. */
  attachments: z.array(z.string().min(1).max(300)).max(20).optional(),
}).strict();
const RenameSchema = z.object({ title: z.string().trim().min(1).max(200) }).strict();

export interface ThreadView {
  id: string; projectId: string; videoId: string | null; kind: 'project' | 'video'; title: string; useLessons: boolean;
  createdAt: string; updatedAt: string; archivedAt: string | null;
  messageCount?: number; lastMessageAt?: string | null; busy?: boolean;
}

export function threadView(t: ThreadRecord | ThreadListRow): ThreadView {
  const list = 'message_count' in t ? { messageCount: t.message_count, lastMessageAt: t.last_message_at, busy: t.running > 0 } : {};
  return {
    id: t.id, projectId: t.project_id, videoId: t.video_id, kind: t.kind, title: t.title, useLessons: t.use_lessons !== 0,
    createdAt: t.created_at, updatedAt: t.updated_at, archivedAt: t.archived_at, ...list,
  };
}

/** The person's role in the team as a turn records it (a Studio admin acts as owner). */
export function actorRole(engine: EngineService, req: Request, teamId: string): ActorRole {
  if (req.authContext?.isAdmin) return 'owner';
  return engine.db.get<{ role: ActorRole }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, req.authContext!.userId])?.role ?? 'viewer';
}

/**
 * Chat threads with the agent (spec 2026-10-10 agent-workspace §3.2, §4): a project's threads, a thread's messages,
 * sending (it queues a turn the worker runs), stopping a turn, what to learn from earlier threads, and two
 * server-sent event streams (a thread's changed messages while a turn streams; a project's changes).
 */
@Controller()
@UseGuards(RolesGuard)
export class ThreadsController {
  constructor(private readonly engine: EngineService) {}

  @Get('projects/:projectId/threads')
  @Roles('viewer')
  list(@Param('projectId') projectId: string, @Query('videoId') videoId?: string): Promise<{ threads: ThreadView[] }> {
    return mapErrors(() => {
      requireProject(this.engine.db, projectId);
      return { threads: listThreads(this.engine.db, projectId, videoId ? { videoId } : {}).map(threadView) };
    });
  }

  /** A free thread of the project ("Chat mới"). Body `{title?, learning?}`. */
  @Post('projects/:projectId/threads')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  create(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request): Promise<ThreadView> {
    return mapErrors(() => {
      const body = parseBody(CreateThreadSchema, raw);
      requireProject(this.engine.db, projectId);
      const t = createThread(this.engine.db, { projectId, kind: 'project', title: body.title ?? 'Chat mới', createdBy: req.authContext!.userId });
      if (body.learning) this.learn(t.id, body.learning, req.authContext!.userId);
      return threadView(requireThread(this.engine.db, t.id));
    });
  }

  @Get('threads/:threadId')
  @Roles('viewer')
  get(@Param('threadId') threadId: string): Promise<ThreadView & { refs: { threadId: string; mode: 'summary' | 'full'; title: string }[]; messages: MessageView[] }> {
    return mapErrors(() => {
      const t = requireThread(this.engine.db, threadId);
      return {
        ...threadView(t),
        refs: listThreadRefs(this.engine.db, threadId).map((r) => ({ threadId: r.ref_thread_id, mode: r.mode, title: r.title })),
        messages: listMessages(this.engine.db, threadId).map(messageView),
      };
    });
  }

  @Get('threads/:threadId/messages')
  @Roles('viewer')
  messages(@Param('threadId') threadId: string, @Query('after') after?: string): Promise<{ messages: MessageView[] }> {
    return mapErrors(() => {
      requireThread(this.engine.db, threadId);
      return { messages: listMessages(this.engine.db, threadId, { afterSeq: Number(after) || 0 }).map(messageView) };
    });
  }

  /** Body `{text, attachments?}`: the message, and the turn queued to answer it (null while one runs: it comes next). */
  @Post('threads/:threadId/messages')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  send(@Param('threadId') threadId: string, @Body() raw: unknown, @Req() req: Request): Promise<{ message: MessageView; turn: MessageView | null }> {
    return mapErrors(() => {
      const body = parseBody(SendSchema, raw);
      const thread = requireThread(this.engine.db, threadId);
      const project = requireProject(this.engine.db, thread.project_id);
      const attachments = (body.attachments ?? []).map((p) => normalizeRelPath(p));
      const out = postUserMessage(this.engine.db, {
        threadId, text: body.text, attachments, actor: { id: req.authContext!.userId, role: actorRole(this.engine, req, project.team_id) },
      });
      return { message: messageView(out.user), turn: out.turn ? messageView(out.turn) : null };
    });
  }

  @Post('threads/:threadId/messages/:messageId/cancel')
  @Roles('editor')
  cancel(@Param('threadId') threadId: string, @Param('messageId') messageId: string): Promise<MessageView> {
    return mapErrors(() => {
      const m = getMessage(this.engine.db, messageId);
      if (!m || m.thread_id !== threadId) throw new StudioRunError('not_found', `không có lượt ${messageId}`);
      return messageView(requestCancel(this.engine.db, messageId));
    });
  }

  @Patch('threads/:threadId')
  @Roles('editor')
  rename(@Param('threadId') threadId: string, @Body() raw: unknown): Promise<ThreadView> {
    return mapErrors(() => threadView(renameThread(this.engine.db, threadId, parseBody(RenameSchema, raw).title)));
  }

  /** Body `{useLessons, threads: [{threadId, mode}]}`: what this thread learns from (replaces the earlier choice). */
  @Put('threads/:threadId/learning')
  @Roles('editor')
  setLearning(@Param('threadId') threadId: string, @Body() raw: unknown, @Req() req: Request): Promise<ThreadView> {
    return mapErrors(() => {
      requireThread(this.engine.db, threadId);
      this.learn(threadId, parseBody(LearningSchema, raw), req.authContext!.userId);
      return threadView(requireThread(this.engine.db, threadId));
    });
  }

  @Delete('threads/:threadId')
  @Roles('editor')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(@Param('threadId') threadId: string): Promise<void> {
    return mapErrors(() => archiveThread(this.engine.db, threadId));
  }

  /** What runs in the project now: agent turns and the tool each is in (jobs from phase 4). */
  @Get('projects/:projectId/activity')
  @Roles('viewer')
  activity(@Param('projectId') projectId: string): Promise<{ activity: Activity[] }> {
    return mapErrors(() => {
      requireProject(this.engine.db, projectId);
      return { activity: agentActivity(this.engine.db, projectId) };
    });
  }

  /**
   * Server-sent events of a thread: `message` with each message as it changes (a running turn streams its text and
   * tool calls), `ping` every 20 s. Read with fetch (the bearer token), like the chat stream.
   */
  @Sse('threads/:threadId/events')
  @Roles('viewer')
  @RawResponse()
  threadEvents(@Param('threadId') threadId: string): Observable<MessageEvent> {
    const sent = new Map<string, string>();
    let since = '';
    const changes = interval(THREAD_EVENTS_MS).pipe(
      startWith(0),
      map(() => {
        const rows = this.engine.db.all<MessageRecord>(
          'SELECT * FROM agent_messages WHERE thread_id = ? AND updated_at >= ? ORDER BY seq', [threadId, since],
        );
        const fresh = rows.filter((r) => sent.get(r.id) !== r.updated_at);
        for (const r of fresh) { sent.set(r.id, r.updated_at); if (r.updated_at > since) since = r.updated_at; }
        return fresh;
      }),
      filter((fresh) => fresh.length > 0),
      map((fresh): MessageEvent => ({ type: 'messages', data: { messages: fresh.map(messageView) } })),
    );
    return merge(changes, interval(PING_MS).pipe(map((): MessageEvent => ({ type: 'ping', data: '' }))));
  }

  /** Server-sent events of a project: `changed` whenever a thread, a turn or a video changes. */
  @Sse('projects/:projectId/events')
  @Roles('viewer')
  @RawResponse()
  projectEvents(@Param('projectId') projectId: string): Observable<MessageEvent> {
    const changes = interval(PROJECT_EVENTS_MS).pipe(
      startWith(0),
      map(() => projectFingerprint(this.engine.db, projectId)),
      distinctUntilChanged(),
      map((fingerprint): MessageEvent => ({ type: 'changed', data: { fingerprint } })),
    );
    return merge(changes, interval(PING_MS).pipe(map((): MessageEvent => ({ type: 'ping', data: '' }))));
  }

  private learn(threadId: string, learning: z.infer<typeof LearningSchema>, userId: string): void {
    setThreadLearning(this.engine.db, {
      threadId, useLessons: learning.useLessons, addedBy: userId,
      refs: learning.threads.map((r) => ({ threadId: r.threadId, mode: r.mode })),
    });
  }
}
