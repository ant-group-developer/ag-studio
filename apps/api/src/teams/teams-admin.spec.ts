/**
 * `GET /teams` through the real `RolesGuard` and controller: the route has no `@Roles`, so the guard returns before it
 * learns whether the caller is a Studio admin. The list must still give an admin every team, each with `isMember`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AccountApiService } from '../auth/account-api.service';
import type { AccountDirectoryService } from '../auth/account-directory.service';
import { RolesGuard } from '../auth/roles.guard';
import { StudioAdminService } from '../auth/studio-admin.service';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';

const accounts = {
  getUserProfile: async (_t: string, id: string) => ({ userId: id, userType: id === 'auth0|admin' ? 'ADMIN' : 'USER', permissions: [] }),
} as unknown as AccountApiService;

const req = (userId: string, params: Record<string, string> = {}) =>
  ({ authContext: { userId, accessToken: 't' }, params }) as unknown as Request;

/** The execution context Nest builds for `handler` of `TeamsController`, so the guard reads the real `@Roles`. */
function context(request: Request, handler: (...args: never[]) => unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => TeamsController,
  } as unknown as ExecutionContext;
}

describe('GET /teams (guard + controller, real studio.db)', () => {
  let s: RealStudio;
  let guard: RolesGuard;
  let ctl: TeamsController;
  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    insertTeam(s.db, 'team-2', 'auth0|other');
    insertTeam(s.db, 'team-3', 'auth0|admin');
    guard = new RolesGuard(new Reflector(), s.db, accounts);
    ctl = new TeamsController(new TeamsService(s.db), {} as AccountDirectoryService, new StudioAdminService(accounts, s.db));
  });
  afterEach(() => s.close());

  async function list(userId: string, query: Record<string, unknown> = {}) {
    const r = req(userId);
    expect(await guard.canActivate(context(r, TeamsController.prototype.listTeams))).toBe(true);
    return ctl.listTeams(query, r);
  }

  it('an admin lists every team, and sees which ones they belong to', async () => {
    const page = await list('auth0|admin', { pageSize: 100 });
    expect(page.total).toBe(3);
    expect(page.items.map((t) => [t.id, t.isMember, t.role])).toEqual([
      ['team-1', false, null],
      ['team-2', false, null],
      ['team-3', true, 'owner'],
    ]);
  });

  it('a member lists only their teams', async () => {
    const page = await list('auth0|owner');
    expect(page.items.map((t) => [t.id, t.isMember])).toEqual([['team-1', true]]);
  });

  it('an admin searches every team by name', async () => {
    s.db.run('UPDATE teams SET name = ? WHERE id = ?', ['Du lịch chậm', 'team-2']);
    const page = await list('auth0|admin', { q: 'lịch' });
    expect(page.items.map((t) => t.id)).toEqual(['team-2']);
  });

  it('an admin opens a team they are not in: the guard lets them through, the team says they are not a member', async () => {
    const r = req('auth0|admin', { teamId: 'team-2' });
    expect(await guard.canActivate(context(r, TeamsController.prototype.getTeam))).toBe(true);
    expect(ctl.getTeam('team-2', r)).toMatchObject({ id: 'team-2', name: 'Team team-2', role: null, isMember: false });
  });
});
