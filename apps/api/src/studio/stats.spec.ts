import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { createProject, createThread } from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { AccountApiService } from '../auth/account-api.service';
import type { AccountDirectoryService } from '../auth/account-directory.service';
import { StudioAdminService } from '../auth/studio-admin.service';
import type { EngineService } from './engine.service';
import { StatsController } from './stats.controller';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const accounts = { getUserProfile: async (_t: string, id: string) => ({ userType: id === 'auth0|admin' ? 'ADMIN' : 'USER' }) } as unknown as AccountApiService;
const directory = {
  summaries: async (ids: string[]) => new Map(ids.filter((i) => i === 'auth0|owner').map((i) => [i, { userId: i, name: 'Lan', email: 'lan@x', avatar: null }])),
} as unknown as AccountDirectoryService;

describe('StatsController (real studio.db)', () => {
  let s: RealStudio;
  let ctl: StatsController;
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    insertTeam(s.db, 'team-2', 'auth0|other');
    ctl = new StatsController(s.engine as EngineService, new StudioAdminService(accounts, s.db), directory);
    for (const [team, user, cost] of [['team-1', 'auth0|owner', 0.5], ['team-2', 'auth0|other', 2]] as const) {
      const p = createProject(s.engine.db, team, { name: `Kênh ${team}`, description: '', language: 'vi', aspect: '16:9' }, user);
      const t = createThread(s.engine.db, { projectId: p.id, kind: 'project', title: 'Kênh', createdBy: user });
      s.engine.db.run(
        `INSERT INTO llm_calls (id, created_at, source, production_id, run_id, stage_key, attempt_id, skill, model, round, outcome, problems, input_tokens,
           output_tokens, cost_usd, wall_seconds, user_id, team_id) VALUES (?, ?, 'claude-agent', ?, ?, 'agent', ?, 'agent', 'sonnet', 1, 'accepted', '[]', 100, 10, ?, 5, ?, ?)`,
        [randomUUID(), recent, p.id, t.id, randomUUID(), cost, user, team],
      );
    }
  });
  afterEach(() => s.close());

  it('an admin sees every team over the last 30 days by default', async () => {
    const out = await ctl.claude({}, req('auth0|admin'));
    expect(out.groupBy).toBe('team');
    expect(out.totals).toMatchObject({ turns: 2, costUsd: 2.5 });
    expect(out.rows.map((r) => r.label)).toEqual(['Team team-2', 'Team team-1']);
    expect(Date.parse(out.to) - Date.parse(out.from)).toBe(30 * 86_400_000);
  });

  it('an owner sees their teams; people are named; another team or no team owned is refused', async () => {
    const out = await ctl.claude({ groupBy: 'user', tz: '420' }, req('auth0|owner'));
    expect(out.rows).toEqual([expect.objectContaining({ key: 'auth0|owner', label: 'Lan', turns: 1, costUsd: 0.5, user: expect.objectContaining({ name: 'Lan' }) })]);
    expect(out.daily).toHaveLength(1);
    await expect(ctl.claude({ teamId: 'team-2' }, req('auth0|owner'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.claude({}, req('auth0|nobody'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.claude({ groupBy: 'month' }, req('auth0|owner'))).rejects.toMatchObject({ status: 400 });
  });

  it('lists the turns one by one in the same scope, people named; a turn opens in full only within it', async () => {
    const all = await ctl.turns({}, req('auth0|admin'));
    expect(all.total).toBe(2);
    const mine = await ctl.turns({ sortBy: 'cost' }, req('auth0|owner'));
    expect(mine.items).toEqual([expect.objectContaining({ teamId: 'team-1', costUsd: 0.5, projectName: 'Kênh team-1', user: expect.objectContaining({ name: 'Lan' }) })]);
    const turn = await ctl.turn(mine.items[0]!.id, req('auth0|owner'));
    expect(turn).toMatchObject({ id: mine.items[0]!.id, tools: [], changed: [], user: expect.objectContaining({ name: 'Lan' }) });
    const theirs = all.items.find((r) => r.teamId === 'team-2')!;
    await expect(ctl.turn(theirs.id, req('auth0|owner'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.turns({ outcome: 'great' }, req('auth0|owner'))).rejects.toMatchObject({ status: 400 });
  });
});
