/**
 * Productions v3: fields, derived status and episode counts, paging/visibility, atomic create — against a real
 * studio.db and engine core (see test/real-studio.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startEpisodeRun, startPlanRun } from '@ag-studio/engine';
import { countEpisodes, deriveStatus, ProductionsService } from './productions.service';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';

describe('deriveStatus', () => {
  const live = { status: 'draft' };
  it.each([
    ['archived wins', { status: 'archived' }, { state: 'RUNNING', waiting_gate: null }, [], 'archived'],
    ['no plan run', live, null, [], 'draft'],
    ['plan run working', live, { state: 'RUNNING', waiting_gate: null }, [], 'planning'],
    ['waiting at approve-plan', live, { state: 'WAITING', waiting_gate: 'approve-plan' }, [], 'waiting_approval'],
    ['plan failed before episodes', live, { state: 'FAILED', waiting_gate: null }, [], 'failed'],
    ['an episode producing', live, { state: 'SUCCEEDED', waiting_gate: null }, ['ready', 'producing'], 'producing'],
    ['every episode ready', live, { state: 'SUCCEEDED', waiting_gate: null }, ['ready', 'ready'], 'done'],
    ['an episode failed, none producing', live, { state: 'SUCCEEDED', waiting_gate: null }, ['ready', 'failed'], 'failed'],
  ] as const)('%s', (_name, row, run, episodes, expected) => {
    expect(deriveStatus(row, run, [...episodes])).toBe(expected);
  });

  it('counts episodes by status', () => {
    expect(countEpisodes(['ready', 'ready', 'failed', 'producing', 'planned'])).toEqual({ total: 5, ready: 2, producing: 1, failed: 1 });
  });
});

describe('ProductionsService (real studio.db)', () => {
  let s: RealStudio;
  let svc: ProductionsService;
  beforeEach(async () => {
    s = await realStudio();
    svc = new ProductionsService(s.db, s.engine);
    insertTeam(s.db, 'team-1', 'owner-1');
  });
  afterEach(() => s.close());

  const input = {
    title: 'Chợ nổi miền Tây',
    description: 'Series về chợ nổi',
    goal: 'Tăng người xem',
    audience: 'Khách du lịch',
    tone: 'Ấm áp',
    notes: '',
    sources: ['folder-1', 'folder-2'],
    youtubeChannels: ['@kenhA'],
    keywords: ['chợ nổi', 'miền tây'],
    episodeTargetSeconds: 300,
    maxEpisodes: 4,
  };

  it('creates a production with its sources and maps every v3 field', () => {
    const p = svc.createProduction('team-1', 'owner-1', input);
    expect(p).toMatchObject({
      teamId: 'team-1', teamName: 'Team team-1', title: 'Chợ nổi miền Tây', description: 'Series về chợ nổi',
      goal: 'Tăng người xem', audience: 'Khách du lịch', tone: 'Ấm áp', sources: ['folder-1', 'folder-2'],
      youtubeChannels: ['@kenhA'], keywords: ['chợ nổi', 'miền tây'], episodeTargetSeconds: 300, maxEpisodes: 4,
      status: 'draft', episodeCounts: { total: 0, ready: 0, producing: 0, failed: 0 },
    });
  });

  it('creates nothing when a source cannot be inserted (one transaction)', () => {
    expect(() => svc.createProduction('team-1', 'owner-1', { ...input, sources: ['same', 'same'] })).toThrow();
    expect(s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM productions')?.n).toBe(0);
  });

  it('defaults maxEpisodes to 10', () => {
    expect(svc.createProduction('team-1', 'owner-1', { ...input, maxEpisodes: undefined }).maxEpisodes).toBe(10);
  });

  it('derives planning from the plan run and counts episodes by their runs', () => {
    const p = svc.createProduction('team-1', 'owner-1', input);
    startPlanRun(s.engine.core, s.engine.db, p.id);
    const now = new Date().toISOString();
    s.db.run('INSERT INTO episodes (id, production_id, idx, title, hook, plan, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
      ['ep-1', p.id, 'Tập 1', 'hook', '{}', now, now]);
    s.db.run('INSERT INTO episodes (id, production_id, idx, title, hook, plan, created_at, updated_at) VALUES (?, ?, 2, ?, ?, ?, ?, ?)',
      ['ep-2', p.id, 'Tập 2', 'hook', '{}', now, now]);
    startEpisodeRun(s.engine.core, s.engine.db, 'ep-1');
    const view = svc.getProduction(p.id)!;
    expect(view.status).toBe('planning');
    expect(view.episodeCounts).toEqual({ total: 2, ready: 0, producing: 1, failed: 0 });
  });

  it('pages what the caller can see; admins see everything; a status filter pages after filtering', () => {
    insertTeam(s.db, 'team-2', 'someone-else');
    const a = svc.createProduction('team-1', 'owner-1', input);
    svc.createProduction('team-1', 'owner-1', { ...input, title: 'B' });
    svc.createProduction('team-2', 'someone-else', { ...input, title: 'C' });
    startPlanRun(s.engine.core, s.engine.db, a.id);

    const mine = svc.listProductionsPaged('owner-1', false, { page: 1, pageSize: 10, sortBy: 'title', sortOrder: 'asc' });
    expect(mine.total).toBe(2);
    expect(mine.items.map((p) => p.title)).toEqual(['B', 'Chợ nổi miền Tây']);
    expect(svc.listProductionsPaged('admin', true, { page: 1, pageSize: 10 }).total).toBe(3);
    const drafts = svc.listProductionsPaged('owner-1', false, { page: 1, pageSize: 1, status: 'draft' });
    expect(drafts.total).toBe(1);
    expect(drafts.items.map((p) => p.title)).toEqual(['B']);
    expect(svc.listProductionsPaged('owner-1', false, { page: 1, pageSize: 10, q: 'miền Tây' }).total).toBe(1);
  });

  it('getProduction returns null for a missing production', () => {
    expect(svc.getProduction('missing')).toBeNull();
  });
});
