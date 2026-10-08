/**
 * Machine type of a final render (phase 3) over a real studio.db: the DTOs, approving the kit only, Render lại with a
 * type, and what the episode detail says about the render.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request } from 'express';
import { MemoryBucket, renderChoiceFor, renderNodeFor, resolveRenderNode } from '@ag-studio/engine';
import { ROLES_KEY } from '../auth/roles.decorator';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import { ChatApproveDto, ChatController, type ChatFolders } from './chat.controller';
import type { EngineService } from './engine.service';
import { EpisodesController, RerenderDto } from './episodes.controller';
import type { FootageAccessService } from './footage-access.service';

const PROD = '22222222-2222-4222-8222-222222222222';
const NODE = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a41';
const req = (userId: string, isAdmin = false) => ({ authContext: { userId, isAdmin } }) as unknown as Request;

async function invalid(cls: new () => object, body: object): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body) as object, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((e) => e.property);
}

describe('render machine routes (real studio.db)', () => {
  let s: RealStudio;
  let engine: EngineService;
  const access = { coversProduction: async () => true } as unknown as FootageAccessService;

  beforeEach(async () => {
    s = await realStudio();
    const bucket = new MemoryBucket();
    const farm = { getJob: async () => ({ status: 'queued', progress_percent: null }) };
    const nodes = { listNodes: async () => ({ nodes: [{ id: NODE, name: 'render-01', online: true, kinds: ['studio.render_final'], gpus: [], running_jobs: 0, last_seen_at: null }] }) };
    engine = {
      ...s.engine, core: s.engine.core, db: s.engine.db, bucket, editor: { db: s.engine.db, bucket, farm }, browserUrlTtl: 60,
      renderNode: (id: string) => resolveRenderNode(nodes as never, id),
    } as unknown as EngineService;
    insertTeam(s.db, 'team-1', 'auth0|owner');
    const now = new Date().toISOString();
    s.db.run(`INSERT INTO productions (id, team_id, title, status, created_at, updated_at, owner_user_id, keywords, aspect, language)
              VALUES (?, 'team-1', 'Phở', 'draft', ?, ?, 'auth0|owner', '["phở"]', '16:9', 'vi')`, [PROD, now, now]);
    s.db.run(`INSERT INTO episodes (id, production_id, idx, title, hook, created_at, updated_at)
              VALUES ('ep-1', ?, 1, 'Tập 1', 'Mở đầu', ?, ?)`, [PROD, now, now]);
  });
  afterEach(() => s.close());

  it('the DTOs take only the three machine types, and none at all', async () => {
    expect(await invalid(ChatApproveDto, { stageKey: 'approve-youtube-kit', renderMachine: 'gpu' })).toEqual([]);
    expect(await invalid(ChatApproveDto, { stageKey: 'approve-youtube-kit' })).toEqual([]);
    expect(await invalid(ChatApproveDto, { stageKey: 'approve-youtube-kit', renderMachine: 'render-01' })).toEqual(['renderMachine']);
    expect(await invalid(RerenderDto, {})).toEqual([]);
    expect(await invalid(RerenderDto, { renderMachine: 'nvenc' })).toEqual([]);
    expect(await invalid(RerenderDto, { renderMachine: { gpu: true } })).toEqual(['renderMachine']);
  });

  it('a machine type on a gate other than the kit is 422, before anything is looked at', async () => {
    const ctl = new ChatController(engine, s.db, { forUser: async () => [] } as unknown as ChatFolders);
    const err = await ctl.approve(PROD, { stageKey: 'approve-timeline', episodeId: 'ep-1', renderMachine: 'gpu' }, req('auth0|owner')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'no_render_here', stage: 'approve-timeline' });
  });

  it('Render lại with a type starts the run and keeps the type for its render; still a producer route', async () => {
    const ctl = new EpisodesController(engine, access);
    const out = await ctl.rerender(PROD, 'ep-1', { renderMachine: 'nvenc' }, req('auth0|owner'));
    expect(out.from).toBe('start');
    expect(renderChoiceFor(s.engine.db, out.runId, 'render-final')).toBe('nvenc');
    expect(Reflect.getMetadata(ROLES_KEY, EpisodesController.prototype.rerender)).toEqual(['producer']);
  });

  it('Render lại pinned to a node keeps it for the render; a node the farm does not list is 422 unknown_node', async () => {
    const ctl = new EpisodesController(engine, access);
    expect(await invalid(RerenderDto, { renderMachine: 'any', renderNodeId: 'render-01' })).toEqual(['renderNodeId']);
    const out = await ctl.rerender(PROD, 'ep-1', { renderMachine: 'any', renderNodeId: NODE }, req('auth0|owner'));
    expect(renderNodeFor(s.engine.db, out.runId, 'render-final')).toEqual({ id: NODE, name: 'render-01' });
    const err = await ctl.rerender(PROD, 'ep-1', { renderMachine: 'any', renderNodeId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a49' }, req('auth0|owner')).catch((e: unknown) => e);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'unknown_node' });
  });

  it('narration of one shot-cut episode is declined and wanted again; a whole-video episode has none to decline', async () => {
    const ctl = new EpisodesController(engine, access);
    expect(await ctl.episodeNarration(PROD, 'ep-1', { declined: true }, req('auth0|owner')).catch((e: unknown) => (e as UnprocessableEntityException).getResponse()))
      .toMatchObject({ code: 'no_narration_here' });
    s.db.run("UPDATE episodes SET edit_style = 'cut' WHERE id = 'ep-1'");
    expect(await ctl.episodeNarration(PROD, 'ep-1', { declined: true }, req('auth0|owner'))).toEqual({ resumed: false });
    expect((await ctl.detail(PROD, 'ep-1', req('auth0|owner'))).narrationDeclined).toBe(true);
    await ctl.episodeNarration(PROD, 'ep-1', { declined: false }, req('auth0|owner'));
    expect((await ctl.detail(PROD, 'ep-1', req('auth0|owner'))).narrationDeclined).toBe(false);
    expect(Reflect.getMetadata(ROLES_KEY, EpisodesController.prototype.episodeNarration)).toEqual(['producer']);
  });

  it('Chạy lại từ bước: an ended run goes again from the stage asked; a run still going is 409, an unknown stage 404', async () => {
    const ctl = new EpisodesController(engine, access);
    const first = await ctl.rerender(PROD, 'ep-1', {}, req('auth0|owner'));
    expect((await ctl.resumeEpisodeStage(PROD, 'ep-1', 'youtube-kit', req('auth0|owner')).catch((e: unknown) => e)) as Error)
      .toMatchObject({ status: 409 });
    s.engine.core.planner.cancel(first.runId);
    expect(((await ctl.resumeEpisodeStage(PROD, 'ep-1', 'nope', req('auth0|owner')).catch((e: unknown) => e)) as { status: number }).status).toBe(404);
    const again = await ctl.resumeEpisodeStage(PROD, 'ep-1', 'episode-intake', req('auth0|owner'));
    expect(again.runId).not.toBe(first.runId);
    expect(s.db.get<{ run_id: string }>("SELECT run_id FROM episodes WHERE id = 'ep-1'")?.run_id).toBe(again.runId);
    expect(Reflect.getMetadata(ROLES_KEY, EpisodesController.prototype.resumeEpisodeStage)).toEqual(['producer']);
  });

  it('Render lại with an empty body works as before', async () => {
    const ctl = new EpisodesController(engine, access);
    const out = await ctl.rerender(PROD, 'ep-1', {}, req('auth0|owner'));
    expect(out.from).toBe('start');
    expect(renderChoiceFor(s.engine.db, out.runId, 'render-final')).toBeNull();
  });

  it('the episode detail says the type, the default and where Render lại would start', async () => {
    const ctl = new EpisodesController(engine, access);
    expect((await ctl.detail(PROD, 'ep-1', req('auth0|owner'))).render)
      .toEqual({ machine: null, node: null, defaultMachine: 'any', restartFrom: 'start', job: null, farmStatus: null });
    await ctl.rerender(PROD, 'ep-1', { renderMachine: 'gpu' }, req('auth0|owner'));
    expect((await ctl.detail(PROD, 'ep-1', req('auth0|owner'))).render)
      .toMatchObject({ machine: 'gpu', defaultMachine: 'gpu', restartFrom: null, job: null, farmStatus: null });
  });
});
