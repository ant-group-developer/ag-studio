import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { createProject } from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { AccountApiService } from '../auth/account-api.service';
import { StudioAdminService } from '../auth/studio-admin.service';
import type { EngineService } from '../studio/engine.service';
import type { WorkspaceService } from '../workspace/workspace.service';
import { DiagnosticsController } from './diagnostics.controller';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const accounts = { getUserProfile: async (_t: string, id: string) => ({ userType: id === 'auth0|admin' ? 'ADMIN' : 'USER' }) } as unknown as AccountApiService;

describe('DiagnosticsController (real database)', () => {
  let s: RealStudio;
  let ctl: DiagnosticsController;
  beforeEach(async () => {
    s = await realStudio();
    await insertTeam(s.db, 'team-1', 'auth0|owner');
    ctl = new DiagnosticsController(s.engine as EngineService, new StudioAdminService(accounts, s.db), { root: '/nowhere' } as WorkspaceService);
    const p = await createProject(s.engine.db, 'team-1', { name: 'Kênh', description: '', language: 'vi', aspect: '16:9' }, 'auth0|owner');
    const at = new Date(Date.now() - 3_600_000).toISOString();
    await s.engine.db.run(
      `INSERT INTO project_jobs (id, project_id, kind, status, title, request, error, created_by, created_at, updated_at)
       VALUES (?, ?, 'fit', 'failed', 'Khớp', '{}', 'boom 12', 'auth0|owner', ?, ?)`,
      [randomUUID(), p.id, at, at],
    );
  });
  afterEach(() => s.close());

  it('an admin reads the last 14 days by default: counts and grouped errors', async () => {
    const o = await ctl.overview({ tz: '420' }, req('auth0|admin'));
    expect(Date.parse(o.to) - Date.parse(o.from)).toBe(14 * 86_400_000);
    expect(o.jobs).toEqual([{ kind: 'fit', status: 'failed', n: 1 }]);
    const e = await ctl.errors({}, req('auth0|admin'));
    expect(await ctl.videos({}, req('auth0|admin'))).toMatchObject({ rows: [], summary: { videos: 0 }, truncated: false });
    expect(e.groups.map((g) => [g.signature, g.count, g.trend])).toEqual([['boom N', 1, 'new']]);
  });

  it('only an admin; the period is checked', async () => {
    await expect(ctl.overview({}, req('auth0|owner'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.errors({ from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' }, req('auth0|admin'))).rejects.toMatchObject({ status: 400 });
    await expect(ctl.errors({ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, req('auth0|admin'))).rejects.toMatchObject({ status: 400 });
    await expect(ctl.errors({ when: 'today' }, req('auth0|admin'))).rejects.toMatchObject({ status: 400 });
  });
});

describe('DiagnosticsController renders', () => {
  it('names machines from the farm and sums its jobs; a farm out of reach is said, not thrown', async () => {
    const s = await realStudio();
    try {
      const at = new Date(Date.now() - 3_600_000).toISOString();
      const engine = {
        ...s.engine, core: s.engine.core, db: s.engine.db,
        farmNodes: async () => ({ nodes: [{ id: 'n1', name: 'AG-189' }] }),
        farmJobsSince: async () => ({ jobs: [{ id: 'f1', type: 'studio.render', status: 'failed', attempt_count: 1, node_id: 'n1', created_at: at, finished_at: at, error: { code: 'lease_expired', message: 'Lease expired', retryable: false } }], truncated: false }),
      } as unknown as EngineService;
      const ctl = new DiagnosticsController(engine, new StudioAdminService(accounts, s.db), { root: '/nowhere' } as WorkspaceService);
      const out = await ctl.renders({}, req('auth0|admin'));
      expect(out.farmError).toBeNull();
      expect(out.farm?.errors).toEqual([expect.objectContaining({ code: 'lease_expired', count: 1, nodes: ['AG-189'] })]);
      const down = new DiagnosticsController({ ...engine, farmNodes: async () => { throw new Error('farm down'); } } as unknown as EngineService, new StudioAdminService(accounts, s.db), { root: '/nowhere' } as WorkspaceService);
      expect(await down.renders({}, req('auth0|admin'))).toMatchObject({ farm: null, farmError: 'farm down' });
    } finally {
      await s.close();
    }
  });
});
