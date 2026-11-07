import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { createProject } from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { AccountApiService } from '../auth/account-api.service';
import { StudioAdminService } from '../auth/studio-admin.service';
import type { EngineService } from '../studio/engine.service';
import { DiagnosticsController } from './diagnostics.controller';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const accounts = { getUserProfile: async (_t: string, id: string) => ({ userType: id === 'auth0|admin' ? 'ADMIN' : 'USER' }) } as unknown as AccountApiService;

describe('DiagnosticsController (real database)', () => {
  let s: RealStudio;
  let ctl: DiagnosticsController;
  beforeEach(async () => {
    s = await realStudio();
    await insertTeam(s.db, 'team-1', 'auth0|owner');
    ctl = new DiagnosticsController(s.engine as EngineService, new StudioAdminService(accounts, s.db));
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
    expect(e.groups.map((g) => [g.signature, g.count, g.trend])).toEqual([['boom N', 1, 'new']]);
  });

  it('only an admin; the period is checked', async () => {
    await expect(ctl.overview({}, req('auth0|owner'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.errors({ from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' }, req('auth0|admin'))).rejects.toMatchObject({ status: 400 });
    await expect(ctl.errors({ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, req('auth0|admin'))).rejects.toMatchObject({ status: 400 });
    await expect(ctl.errors({ when: 'today' }, req('auth0|admin'))).rejects.toMatchObject({ status: 400 });
  });
});
