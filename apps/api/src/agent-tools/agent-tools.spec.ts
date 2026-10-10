/**
 * The agent-tool routes over a real studio.db: only a running turn's own token gets in, a finished turn's token stops
 * working, and the tool runs with the role the person had when they asked.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import {
  createProject, createThread, finishTurn, listVideos, markAgentTurnRunning, postUserMessage, signAgentToken, type ActorRole,
} from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { AgentTokenGuard } from './agent-token.guard';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';

const SECRET = 'x'.repeat(32);

describe('agent tools API (real studio.db)', () => {
  let s: RealStudio;
  let guard: AgentTokenGuard;
  let controller: AgentToolsController;
  const config = (env: Record<string, string>) => ({ get: (k: string, d?: unknown) => env[k] ?? d }) as unknown as ConfigService;

  beforeEach(async () => {
    s = await realStudio();
    const engine = s.engine as unknown as EngineService;
    const ws = new WorkspaceService(config({ STUDIO_WORKSPACES_ROOT: mkdtempSync(join(tmpdir(), 'agent-api-')) }), engine);
    guard = new AgentTokenGuard(config({ STUDIO_AGENT_TOKEN_SECRET: SECRET }), engine);
    controller = new AgentToolsController(engine, ws, new AgentToolsService());
    insertTeam(s.db, 'team-1', 'auth0|owner');
  });
  afterEach(() => s.close());

  function turn(role: ActorRole) {
    const project = createProject(s.engine.db, 'team-1', { name: 'Kênh A', description: '', language: 'vi', aspect: '16:9' }, 'auth0|owner');
    const thread = createThread(s.engine.db, { projectId: project.id, kind: 'project', title: 'Kênh', createdBy: 'auth0|owner' });
    const { turn: t } = postUserMessage(s.engine.db, { threadId: thread.id, text: 'tạo video', actor: { id: 'auth0|u', role } });
    markAgentTurnRunning(s.engine.db, t!.id, new Date().toISOString());
    const token = signAgentToken({ msg: t!.id, thread: thread.id, project: project.id, video: null, sub: 'auth0|u', exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
    return { project, thread, turn: t!, token };
  }
  const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as unknown as Request;
  const ctx = (r: Request) => ({ switchToHttp: () => ({ getRequest: () => r }) }) as unknown as ExecutionContext;
  const refusal = (fn: () => unknown) => {
    try { fn(); } catch (e) { return ((e as { getResponse?: () => { code?: string } }).getResponse?.() ?? {}).code ?? String(e); }
    return null;
  };

  it('lets a running turn in and runs a tool with the role of the person who asked', async () => {
    const { project, token } = turn('editor');
    const r = req(token);
    expect(guard.canActivate(ctx(r))).toBe(true);
    expect(controller.list().tools.map((t) => t.name)).toContain('video_create');
    const out = await controller.call({ name: 'video_create', arguments: { title: 'Hội An' } }, r);
    expect(out.isError).toBeUndefined();
    expect(listVideos(s.engine.db, project.id).map((v) => v.title)).toEqual(['Hội An']);
  });

  it('a viewer’s turn cannot create videos; a finished turn’s token is refused; a bad token too', async () => {
    const viewer = turn('viewer');
    const r = req(viewer.token);
    guard.canActivate(ctx(r));
    expect(await controller.call({ name: 'video_create', arguments: { title: 'x' } }, r)).toMatchObject({ isError: true });
    finishTurn(s.engine.db, viewer.turn.id, { status: 'done', text: '', parts: [] }, new Date().toISOString());
    expect(refusal(() => guard.canActivate(ctx(req(viewer.token))))).toBe('turn_not_running');
    expect(refusal(() => guard.canActivate(ctx(req('nope'))))).toBe('bad_agent_token');
    expect(refusal(() => guard.canActivate(ctx(req(`${viewer.token}x`))))).toBe('bad_agent_token');
  });

  it('is off without a secret', () => {
    const { token } = turn('editor');
    const off = new AgentTokenGuard(config({}), s.engine as unknown as EngineService);
    expect(refusal(() => off.canActivate(ctx(req(token))))).toBe('agent_disabled');
  });
});
