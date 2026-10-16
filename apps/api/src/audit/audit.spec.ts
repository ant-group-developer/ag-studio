import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { createProject, logAudit } from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { AccountApiService } from '../auth/account-api.service';
import type { AccountDirectoryService } from '../auth/account-directory.service';
import { StudioAdminService } from '../auth/studio-admin.service';
import type { EngineService } from '../studio/engine.service';
import { AuditController } from './audit.controller';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const accounts = { getUserProfile: async (_t: string, id: string) => ({ userType: id === 'auth0|admin' ? 'ADMIN' : 'USER' }) } as unknown as AccountApiService;
const directory = {
  summaries: async (ids: string[]) => new Map(ids.filter((i) => i === 'auth0|owner').map((i) => [i, { userId: i, name: 'Lan', email: 'lan@x', avatar: null }])),
} as unknown as AccountDirectoryService;

describe('AuditController (real database)', () => {
  let s: RealStudio;
  let ctl: AuditController;
  beforeEach(async () => {
    s = await realStudio();
    await insertTeam(s.db, 'team-1', 'auth0|owner');
    await insertTeam(s.db, 'team-2', 'auth0|other');
    ctl = new AuditController(s.engine as EngineService, new StudioAdminService(accounts, s.db), directory);
    const p1 = await createProject(s.engine.db, 'team-1', { name: 'Kênh A', description: '', language: 'vi', aspect: '16:9' }, 'auth0|owner');
    const p2 = await createProject(s.engine.db, 'team-2', { name: 'Kênh B', description: '', language: 'vi', aspect: '16:9' }, 'auth0|other');
    await logAudit(s.engine.db, { at: '2026-10-10T08:00:00.000Z', actorKind: 'user', actorId: 'auth0|owner', kind: 'http', action: 'VideosController.create', outcome: 'ok', projectId: p1.id });
    await logAudit(s.engine.db, { at: '2026-10-10T09:00:00.000Z', actorKind: 'agent', actorId: 'auth0|owner', kind: 'tool', action: 'Write', outcome: 'error', projectId: p1.id });
    await logAudit(s.engine.db, { at: '2026-10-10T10:00:00.000Z', actorKind: 'user', actorId: 'auth0|other', kind: 'http', action: 'ProjectsController.update', outcome: 'ok', projectId: p2.id });
    await logAudit(s.engine.db, { at: '2026-10-10T11:00:00.000Z', actorKind: 'user', actorId: 'auth0|admin', kind: 'http', action: 'StudioOverviewController.settings', outcome: 'ok' });
  });
  afterEach(() => s.close());

  it('an admin reads every row, Studio-wide ones too; names come from the Account API', async () => {
    const all = await ctl.list({}, req('auth0|admin'));
    expect(all.total).toBe(4);
    expect(all.items[0]).toMatchObject({ action: 'StudioOverviewController.settings', team: null, actor: { userId: 'auth0|admin', name: null } });
    expect(all.items.at(-1)).toMatchObject({ actor: { name: 'Lan' }, project: { name: 'Kênh A' } });
    expect((await ctl.list({ teamId: 'team-2' }, req('auth0|admin'))).items.map((i) => i.action)).toEqual(['ProjectsController.update']);
    expect(await ctl.scope(req('auth0|admin'))).toEqual({ all: true, teams: [{ id: 'team-1', name: 'Team team-1' }, { id: 'team-2', name: 'Team team-2' }] });
  });

  it("an owner reads their teams' rows only, filtered; others are refused", async () => {
    const mine = await ctl.list({}, req('auth0|owner'));
    expect(mine.items.map((i) => i.action)).toEqual(['Write', 'VideosController.create']);
    expect((await ctl.list({ kind: 'tool', outcome: 'error' }, req('auth0|owner'))).total).toBe(1);
    expect((await ctl.list({ from: '2026-10-10T08:30:00Z', pageSize: '1' }, req('auth0|owner'))).items.map((i) => i.action)).toEqual(['Write']);
    await expect(ctl.list({ teamId: 'team-2' }, req('auth0|owner'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.list({}, req('auth0|nobody'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.list({ kind: 'nope' }, req('auth0|owner'))).rejects.toMatchObject({ status: 400 });
    expect(await ctl.scope(req('auth0|owner'))).toEqual({ all: false, teams: [{ id: 'team-1', name: 'Team team-1' }] });
    expect((await ctl.actors(undefined, req('auth0|owner'))).actors).toEqual([{ userId: 'auth0|owner', name: 'Lan', email: 'lan@x', avatar: null }]);
  });
});
