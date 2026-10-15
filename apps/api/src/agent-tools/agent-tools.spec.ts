/**
 * The agent-tool routes over a real database: only a running turn's own token gets in, a finished turn's token stops
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
import type { SiteNameService } from '../ag-go/site-name.service';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';
import type { ProjectFootageService } from '../workspace/project-footage.service';
import { addSource, listAudit } from '@ag-studio/engine';

const SECRET = 'x'.repeat(32);

describe('agent tools API (real database)', () => {
  let s: RealStudio;
  let guard: AgentTokenGuard;
  let controller: AgentToolsController;
  const searched: unknown[] = [];
  const config = (env: Record<string, string>) => ({ get: (k: string, d?: unknown) => env[k] ?? d }) as unknown as ConfigService;

  beforeEach(async () => {
    s = await realStudio();
    const engine = s.engine as unknown as EngineService;
    const ws = new WorkspaceService(config({ STUDIO_WORKSPACES_ROOT: mkdtempSync(join(tmpdir(), 'agent-api-')) }), engine);
    guard = new AgentTokenGuard(config({ STUDIO_AGENT_TOKEN_SECRET: SECRET }), engine);
    searched.length = 0;
    const footage = {
      search: async (actAs: string, q: unknown) => { searched.push([actAs, q]); return { items: [], nextCursor: null, total: 0 }; },
      check: async (_actAs: string, ids: string[]) => ({ ok: ids, missing: [] }),
    } as unknown as ProjectFootageService;
    controller = new AgentToolsController(engine, ws, new AgentToolsService(), footage, ({ current: () => 'Kho Footage' }) as unknown as SiteNameService);
    await insertTeam(s.db, 'team-1', 'auth0|owner');
  });
  afterEach(() => s.close());

  async function turn(role: ActorRole) {
    const project = await createProject(s.engine.db, 'team-1', { name: 'Kênh A', description: '', language: 'vi', aspect: '16:9' }, 'auth0|owner');
    const thread = await createThread(s.engine.db, { projectId: project.id, kind: 'project', title: 'Kênh', createdBy: 'auth0|owner' });
    const { turn: t } = await postUserMessage(s.engine.db, { threadId: thread.id, text: 'tạo video', actor: { id: 'auth0|u', role } });
    await markAgentTurnRunning(s.engine.db, t!.id, new Date().toISOString());
    const token = signAgentToken({ msg: t!.id, thread: thread.id, project: project.id, video: null, sub: 'auth0|u', exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
    return { project, thread, turn: t!, token };
  }
  const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as unknown as Request;
  const ctx = (r: Request) => ({ switchToHttp: () => ({ getRequest: () => r }) }) as unknown as ExecutionContext;
  const admitted = async (token: string) => { const r = req(token); await guard.canActivate(ctx(r)); return r; };
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return ((e as { getResponse?: () => { code?: string } }).getResponse?.() ?? {}).code ?? String(e); }
    return null;
  };

  it("describes the tools and answers with ag-go's own name", async () => {
    const { token } = await turn('viewer');
    expect(controller.list().tools.find((t) => t.name === 'footage_search')!.description).toContain('các project Kho Footage');
    const out = await controller.call({ name: 'footage_search', arguments: {} }, await admitted(token));
    expect(out).toMatchObject({ isError: true, text: expect.stringContaining('chưa có project Kho Footage') });
  });

  it("searches the project's ag-go projects as the project's owner", async () => {
    const { project, token } = await turn('viewer');
    await addSource(s.engine.db, { projectId: project.id, kind: 'ag_go_project', ref: 'agp-1', mediaType: 'mixed', label: 'Ninh Bình', addedBy: 'auth0|owner' });
    const out = await controller.call({ name: 'footage_search', arguments: { q: 'thuyền' } }, await admitted(token));
    expect(out.isError).toBeUndefined();
    expect(searched).toEqual([['auth0|owner', { projectIds: ['agp-1'], q: 'thuyền', limit: 30 }]]);
  });

  it('lets a running turn in and runs a tool with the role of the person who asked', async () => {
    const { project, token } = await turn('editor');
    const r = req(token);
    expect(await guard.canActivate(ctx(r))).toBe(true);
    expect(controller.list().tools.map((t) => t.name)).toContain('video_create');
    const out = await controller.call({ name: 'video_create', arguments: { title: 'Hội An' } }, r);
    expect(out.isError).toBeUndefined();
    expect((await listVideos(s.engine.db, project.id)).map((v) => v.title)).toEqual(['Hội An']);
    const [row] = (await listAudit(s.engine.db, {})).items;
    expect(row).toMatchObject({
      actorKind: 'agent', actorId: 'auth0|u', kind: 'tool', action: 'video_create', outcome: 'ok', team: { id: 'team-1' }, project: { id: project.id },
      details: { args: { title: 'Hội An' } },
    });
    expect(row!.threadId).toBeTruthy();
    expect(row!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('a viewer’s turn cannot create videos; a finished turn’s token is refused; a bad token too', async () => {
    const viewer = await turn('viewer');
    const r = await admitted(viewer.token);
    expect(await controller.call({ name: 'video_create', arguments: { title: 'x' } }, r)).toMatchObject({ isError: true });
    expect((await listAudit(s.engine.db, { kind: 'tool' })).items[0]).toMatchObject({ action: 'video_create', outcome: 'error', summary: expect.stringContaining('cần vai editor') });
    await finishTurn(s.engine.db, viewer.turn.id, { status: 'done', text: '', parts: [] }, new Date().toISOString());
    expect(await refusal(guard.canActivate(ctx(req(viewer.token))))).toBe('turn_not_running');
    expect(await refusal(guard.canActivate(ctx(req('nope'))))).toBe('bad_agent_token');
    expect(await refusal(guard.canActivate(ctx(req(`${viewer.token}x`))))).toBe('bad_agent_token');
  });

  it('is off without a secret', async () => {
    const { token } = await turn('editor');
    const off = new AgentTokenGuard(config({}), s.engine as unknown as EngineService);
    expect(await refusal(off.canActivate(ctx(req(token))))).toBe('agent_disabled');
  });
});
