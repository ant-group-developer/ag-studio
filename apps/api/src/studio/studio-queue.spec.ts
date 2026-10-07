import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { QueueFarm } from '@ag-studio/engine';
import type { AccountApiService } from '../auth/account-api.service';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from './engine.service';
import { StudioOverviewController } from './studio-overview.controller';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const accounts = { getUserProfile: async (_t: string, id: string) => ({ userType: id === 'auth0|admin' ? 'ADMIN' : 'USER' }) } as unknown as AccountApiService;
const config = { get: () => '4' } as unknown as ConfigService;

describe('GET studio/queue (real studio.db)', () => {
  let s: RealStudio;
  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    insertTeam(s.db, 'team-2', 'auth0|other');
    const now = new Date().toISOString();
    for (const [id, team] of [['p1', 'team-1'], ['p2', 'team-2']] as const) {
      s.db.run("INSERT INTO productions (id, team_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)", [id, team, `Video ${id}`, now, now]);
      s.db.run("INSERT INTO studio_farm_jobs (id, farm_job_id, run_id, stage_key, attempt_id, production_id, job_type, requirements, created_at) VALUES (?, ?, 'r', 'render-final', 'a', ?, 'studio.render_final', '{\"gpu\":true}', ?)",
        [`row-${id}`, `job-${id}`, id, now]);
    }
  });
  afterEach(() => s.close());

  function ctl(farm: QueueFarm) {
    return new StudioOverviewController({ ...s.engine, core: s.engine.core, db: s.engine.db, queueFarm: farm } as unknown as EngineService, accounts, config);
  }
  const jobs = (ids: string[]) => ({ jobs: ids.map((id) => ({ id, status: 'leased', progress_percent: 50, progress_stage: null, attempt_count: 1, created_at: new Date().toISOString() })) as never, next_cursor: null });

  it('a person sees the jobs of their teams, an admin all; the Claude cap is the one in force', async () => {
    const farm: QueueFarm = { listJobs: async () => jobs(['job-p1', 'job-p2']) };
    const mine = await ctl(farm).queue(req('auth0|owner'));
    expect(mine.renders.map((r) => [r.farmJobId, r.machine])).toEqual([['job-p1', 'gpu']]);
    expect(mine.hiddenRenders).toBe(1);
    expect(mine.claude).toMatchObject({ running: 0, waiting: 0, max: 4 });
    expect((await ctl(farm).queue(req('auth0|admin'))).renders).toHaveLength(2);
  });

  it('the farm down is a 200 that says so', async () => {
    const out = await ctl({ listJobs: async () => { throw new Error('farm unreachable'); } }).queue(req('auth0|owner'));
    expect(out.farm).toEqual({ ok: false, error: 'farm unreachable' });
    expect(out.renders).toEqual([]);
  });
});
