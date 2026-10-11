import { CallHandler, ExecutionContext, HttpException, Injectable, SetMetadata, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { tap, type Observable } from 'rxjs';
import { logAudit, scopeOf } from '@ag-studio/engine';
import { EngineService } from '../studio/engine.service';

const NO_AUDIT_KEY = 'audit:skip';
/** A POST that only reads (an estimate): not written to the activity log. */
export const NoAudit = () => SetMetadata(NO_AUDIT_KEY, true);

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Body fields short and safe enough to keep as they are. */
const KEEP = new Set([
  'kind', 'ref', 'label', 'name', 'title', 'role', 'userId', 'videoId', 'threadId', 'nodeId', 'media', 'path', 'status', 'decision', 'again', 'prepare',
  'active', 'displayName', 'moods', 'origin', 'assistantName', 'claudeMaxConcurrent', 'learning', 'gainDb', 'ducking', 'stepKey', 'mode', 'language',
  'aspect', 'channelUrl', 'crawl', 'loopOk', 'assetIds', 'archived', 'useLessons', 'revision',
]);
/** Body fields kept only as their size: what people wrote is not the log's to keep. */
const SIZE_ONLY = new Set(['text', 'content', 'prompt', 'referenceText', 'originNote', 'description', 'attachments', 'summary']);
/** What a route is about, in a few words. */
const TARGET = ['name', 'title', 'label', 'displayName', 'path', 'ref'];

/** Ids a write's answer carries: the new thing's id, and the team or project it belongs to. */
function answerIds(body: unknown): { id?: string; projectId?: string; teamId?: string } {
  let b = body as Record<string, unknown> | null;
  if (b && typeof b === 'object' && 'success' in b && 'data' in b) b = b.data as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return {};
  const nested = ['source', 'job', 'thread', 'message', 'video', 'project', 'team'].map((k) => b![k]).find((x) => x && typeof x === 'object') as Record<string, unknown> | undefined;
  const pick = (o: Record<string, unknown> | undefined, k: string) => (o && typeof o[k] === 'string' ? (o[k] as string) : undefined);
  return { id: pick(b, 'id') ?? pick(nested, 'id'), projectId: pick(b, 'projectId') ?? pick(nested, 'projectId'), teamId: pick(b, 'teamId') ?? pick(nested, 'teamId') };
}

function bodyDetails(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (KEEP.has(k)) out[k] = v;
    else if (SIZE_ONLY.has(k)) out[`${k}Size`] = typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : 1;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Writes every change a person makes through the API to the activity log: method, route pattern, the handler, status,
 * time taken, the team/project/video it touched (found before the handler runs, so a delete still knows its team),
 * and a few safe fields of the body. Reads, Studio's own routes (the agent's tools, farm signing) and refusals by the
 * guards are not written here.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly engine: EngineService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const skip = this.reflector.getAllAndOverride<boolean>(NO_AUDIT_KEY, [context.getHandler(), context.getClass()]);
    if (!WRITES.has(req.method) || !req.authContext || skip) return next.handle();

    const started = Date.now();
    const params = (req.params ?? {}) as Record<string, string>;
    let before: ReturnType<typeof scopeOf> | null = null;
    try {
      before = scopeOf(this.engine.db, {
        teamId: params.teamId ?? null, projectId: params.projectId ?? null, videoId: params.videoId ?? null, threadId: params.threadId ?? null,
        jobId: params.jobId ?? null, actionId: params.actionId ?? null,
      });
    } catch { /* logged without a scope */ }
    const action = `${context.getClass().name}.${context.getHandler().name}`;
    const okStatus = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ?? (req.method === 'POST' ? 201 : 200);

    const write = (outcome: 'ok' | 'error', status: number, answer?: unknown, error?: unknown) => {
      const ids = answerIds(answer);
      const body = bodyDetails(req.body);
      const file = (req as Request & { file?: { originalname?: string; size?: number } }).file;
      let scope = before;
      if (!scope?.teamId && (ids.projectId || ids.teamId)) scope = scopeOf(this.engine.db, { teamId: ids.teamId ?? null, projectId: ids.projectId ?? null });
      // a new team is its own team; a new project its own project
      if (!scope?.teamId && action === 'TeamsController.createTeam' && ids.id) scope = { teamId: ids.id, projectId: null, videoId: null, threadId: null };
      if (scope && !scope.projectId && action === 'ProjectsController.create' && ids.id) scope = scopeOf(this.engine.db, { projectId: ids.id });
      const target = TARGET.map((k) => (req.body as Record<string, unknown> | undefined)?.[k]).find((v) => typeof v === 'string') as string | undefined;
      logAudit(this.engine.db, {
        actorKind: 'user', actorId: req.authContext!.userId, kind: 'http', action, outcome, method: req.method,
        route: (req.route as { path?: string } | undefined)?.path ?? req.path, statusCode: status, durationMs: Date.now() - started,
        teamId: scope?.teamId ?? null, projectId: scope?.projectId ?? null, videoId: scope?.videoId ?? null, threadId: scope?.threadId ?? null,
        jobId: params.jobId ?? null, target: target ?? file?.originalname ?? null,
        summary: error ? (error instanceof Error ? error.message : String(error)) : null,
        details: {
          params, ...(body ? { body } : {}), ...(file ? { file: { name: file.originalname, size: file.size } } : {}),
          ...(ids.id ? { created: ids.id } : {}), ...(error instanceof HttpException ? { error: (error.getResponse() as { code?: string })?.code ?? undefined } : {}),
        },
        requestId: req.requestId ?? null,
      });
    };

    return next.handle().pipe(tap({
      next: (answer) => write('ok', okStatus, answer),
      error: (e: unknown) => write('error', e instanceof HttpException ? e.getStatus() : typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 500, undefined, e),
    }));
  }
}
