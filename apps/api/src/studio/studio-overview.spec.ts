import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { acquireClaudeSlot, clearYoutubeBlocked, createJob, createProject, noteYoutubeBlocked } from '@ag-studio/engine';
import type { AccountApiService } from '../auth/account-api.service';
import { StudioAdminService } from '../auth/studio-admin.service';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from './engine.service';
import { StudioOverviewController } from './studio-overview.controller';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const accounts = { getUserProfile: async (_t: string, id: string) => ({ userType: id === 'auth0|admin' ? 'ADMIN' : 'USER' }) } as unknown as AccountApiService;
const config = (v?: string) => ({ get: () => v }) as unknown as ConfigService;
const node = { id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', name: 'render-01', online: true, kinds: ['studio.render_final'], gpus: [], running_jobs: 0, last_seen_at: '2026-10-10T08:00:00.000Z' };

describe('StudioOverviewController (real studio.db)', () => {
  let s: RealStudio;
  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    insertTeam(s.db, 'team-2', 'auth0|other');
  });
  afterEach(() => s.close());

  it('the Queue: what runs in the projects of the teams a person is in, the farm machines; an admin sees every project', async () => {
    let farmUp = true;
    const engine = { ...s.engine, db: s.engine.db, core: s.engine.core, farmNodes: async () => { if (!farmUp) throw new Error('farm down'); return { nodes: [node] }; } };
    const ctl = new StudioOverviewController(engine as unknown as EngineService, new StudioAdminService(accounts, s.db), config());
    const mine = createProject(s.engine.db, 'team-1', { name: 'Du lịch chậm', description: '', language: 'vi', aspect: '16:9' }, 'auth0|owner', '2026-10-10T08:00:00.000Z');
    const theirs = createProject(s.engine.db, 'team-2', { name: 'Ẩm thực', description: '', language: 'vi', aspect: '16:9' }, 'auth0|other', '2026-10-10T09:00:00.000Z');
    createJob(s.engine.db, { projectId: mine.id, kind: 'research', title: 'Crawl', request: {}, createdBy: 'auth0|owner' });
    createJob(s.engine.db, { projectId: theirs.id, kind: 'render_preview', title: 'Xem trước', request: {}, createdBy: 'auth0|other' });

    const q = await ctl.queue(req('auth0|owner'));
    expect(q.items.map((i) => [i.projectName, i.title])).toEqual([['Du lịch chậm', 'Crawl']]);
    expect(q).toMatchObject({ hidden: 1, machines: [node], farm: { ok: true }, claude: { running: 0, waiting: 0, max: 20 } });
    expect((await ctl.queue(req('auth0|admin'))).items).toHaveLength(2);
    farmUp = false;
    expect(await ctl.queue(req('auth0|owner'))).toMatchObject({ machines: null, farm: { ok: false, error: 'farm down' } });
    expect(await ctl.farmNodes()).toEqual({ nodes: [] });
  });

  it('the Queue says when YouTube blocks the Studio server, and stops saying it once a download went through', async () => {
    const engine = { ...s.engine, db: s.engine.db, core: s.engine.core, farmNodes: async () => ({ nodes: [] }) };
    const ctl = new StudioOverviewController(engine as unknown as EngineService, new StudioAdminService(accounts, s.db), config());
    expect((await ctl.queue(req('auth0|admin'))).youtube).toBeNull();
    const now = new Date().toISOString();
    noteYoutubeBlocked(s.engine.db, now);
    expect((await ctl.queue(req('auth0|admin'))).youtube).toEqual({ blockedAt: now, until: new Date(Date.parse(now) + 6 * 3600_000).toISOString(), where: 'studio' });
    clearYoutubeBlocked(s.engine.db);
    expect((await ctl.queue(req('auth0|admin'))).youtube).toBeNull();
  });

  it('reports Claude slots against the cap: the env value until an admin saves one', async () => {
    const ctl = new StudioOverviewController(s.engine as EngineService, new StudioAdminService(accounts, s.db), config('5'));
    const now = new Date().toISOString();
    acquireClaudeSlot(s.engine.db, 'agent', 'turn-1', 1, now);
    acquireClaudeSlot(s.engine.db, 'agent', 'turn-2', 1, now);
    expect(ctl.claude()).toEqual({ running: 1, waiting: 1, max: 5, source: 'env', assistantName: 'Claude' });
    await expect(ctl.settings({ claudeMaxConcurrent: 3 }, req('auth0|owner'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(await ctl.settings({ claudeMaxConcurrent: 3 }, req('auth0|admin'))).toMatchObject({ max: 3, source: 'settings' });
  });

  it('names the AI: Claude until an admin saves a name, a blank one goes back to Claude', async () => {
    const ctl = new StudioOverviewController(s.engine as EngineService, new StudioAdminService(accounts, s.db), config('5'));
    await expect(ctl.settings({ assistantName: 'AG AI' }, req('auth0|owner'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(await ctl.settings({ assistantName: 'AG AI' }, req('auth0|admin'))).toMatchObject({ assistantName: 'AG AI', max: 5 });
    expect(ctl.claude().assistantName).toBe('AG AI');
    expect(await ctl.settings({ assistantName: '' }, req('auth0|admin'))).toMatchObject({ assistantName: 'Claude' });
    await expect(ctl.settings({}, req('auth0|admin'))).rejects.toMatchObject({ status: 400 });
    await expect(ctl.settings({ claudeMaxConcurrent: 4, assistantName: 'x'.repeat(41) }, req('auth0|admin'))).rejects.toMatchObject({ status: 422 });
    expect(ctl.claude()).toMatchObject({ max: 5, assistantName: 'Claude' });
  });
});
