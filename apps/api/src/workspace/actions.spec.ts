/**
 * Confirmation cards over a real database: a thread lists its cards, an editor cannot confirm a final render, a
 * producer can (a job is queued), and a card of another project is not found.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { getJob, noteYoutubeBlocked, proposeAction, saveVideoRevision } from '@ag-studio/engine';
import { insertTeam, NO_DIRECTORY, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import { ActionsController } from './actions.controller';
import { ProjectsController } from './projects.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const OWNER = 'auth0|owner';
const EDITOR = 'auth0|editor';
const code = (e: unknown) => (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? String(e);

describe('actions (real database)', () => {
  let s: RealStudio;
  let projects: ProjectsController;
  let videos: VideosController;
  let actions: ActionsController;

  beforeEach(async () => {
    s = await realStudio();
    const engine = s.engine as unknown as EngineService;
    const root = mkdtempSync(join(tmpdir(), 'actions-api-'));
    const ws = new WorkspaceService({ get: (k: string, d?: unknown) => (k === 'STUDIO_WORKSPACES_ROOT' ? root : d) } as unknown as ConfigService, engine);
    projects = new ProjectsController(engine, ws, NO_DIRECTORY);
    videos = new VideosController(engine, ws);
    actions = new ActionsController(engine);
    await insertTeam(s.db, 'team-1', OWNER);
    await s.engine.db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', ?, 'editor', ?)", [EDITOR, new Date().toISOString()]);
  });
  afterEach(async () => { await s.close(); });

  it('lists a thread\'s cards; a final render needs a producer; confirmed, its job is queued', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Huế' }, req(OWNER));
    await saveVideoRevision(s.engine.db, v.id, { baseRevision: 0, authorId: 'u', data: {
      schema_version: 'studio.timeline/v4', production_id: p.id, episode_id: v.id, canvas: { width: 1920, height: 1080 }, fps: 30, language: 'vi', edit_style: 'cut',
      clips: [{ clip_id: 'C001', asset_id: 'a1', section_title: null, in: 0, out: 4, shot_id: null, line_id: null, transition_out: { kind: 'cut', seconds: 0 } }],
      texts: [], narration: { voice: 'none', lead_seconds: 0.3, lines: [] }, captions: { mode: 'none' }, music: null, source_audio: { muted: false },
      assets: { a1: { title: 'Phố', summary_vi: '…', duration_s: 10, orientation: 'landscape' } }, alternates: [],
    } });
    const a = await proposeAction(s.engine.db, { projectId: p.id, threadId: v.threadId, messageId: null, kind: 'render_final', title: 'Render bản cuối', summary: 'Đã duyệt', params: { video_id: v.id }, createdBy: 'agent' });
    expect((await actions.list(v.threadId)).actions).toEqual([expect.objectContaining({ id: a.id, status: 'proposed', needs: 'producer', revision: 1 })]);
    expect(await actions.confirm(p.id, a.id, req(EDITOR)).catch(code)).toBe('role');
    expect(await actions.confirm('other', a.id, req(OWNER)).catch(code)).toBe('not_found');
    const done = await actions.confirm(p.id, a.id, req(OWNER));
    expect(done).toMatchObject({ status: 'confirmed', decidedBy: OWNER });
    expect(await getJob(s.engine.db, done.jobId!)).toMatchObject({ kind: 'render_final', status: 'queued' });
    expect(await actions.reject(p.id, a.id, req(OWNER)).catch(code)).toBe('decided');
  });

  it('cards come with whether YouTube blocks the Studio server now (a pending reference download would fail)', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const thread = (await s.engine.db.get<{ id: string }>('SELECT id FROM agent_threads WHERE project_id = ? LIMIT 1', [p.id]))!;
    await proposeAction(s.engine.db, { projectId: p.id, threadId: thread.id, messageId: null, kind: 'reference_download', title: 'Tải video mẫu', summary: 'nhịp', params: { video_ids: ['U_17EqTHUIo'], purpose: 'nhịp' }, createdBy: 'agent' });
    expect(await actions.list(thread.id)).toMatchObject({ youtubeBlocked: null });
    await noteYoutubeBlocked(s.engine.db, new Date().toISOString());
    expect((await actions.list(thread.id)).youtubeBlocked).toMatchObject({ where: 'studio' });
  });

  it('a farm machine that fetches reference videos lifts the warning (the card goes through the farm), unless the farm is blocked too', async () => {
    const node = { id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', name: 'PC-01', online: true, kinds: ['studio.reference_fetch'], gpus: [], running_jobs: 0, last_seen_at: null };
    const engine = { ...s.engine, db: s.engine.db, core: s.engine.core, farmNodes: async () => ({ nodes: [node] }) } as unknown as EngineService;
    const viaFarm = new ActionsController(engine);
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const thread = (await s.engine.db.get<{ id: string }>('SELECT id FROM agent_threads WHERE project_id = ? LIMIT 1', [p.id]))!;
    const now = new Date().toISOString();
    await noteYoutubeBlocked(s.engine.db, now);
    expect((await viaFarm.list(thread.id)).youtubeBlocked).toBeNull();
    expect((await actions.list(thread.id)).youtubeBlocked).toMatchObject({ where: 'studio' }); // no farm machines reachable here
    await noteYoutubeBlocked(s.engine.db, now, 'farm');
    expect((await viaFarm.list(thread.id)).youtubeBlocked).toMatchObject({ where: 'farm' });
  });
});
