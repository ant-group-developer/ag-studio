import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { AccountApiService } from './account-api.service';
import { StudioAdminService } from './studio-admin.service';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;

describe('StudioAdminService (real studio.db)', () => {
  let s: RealStudio;
  let asked = 0;
  let svc: StudioAdminService;
  beforeEach(async () => {
    s = await realStudio();
    asked = 0;
    const accounts = {
      getUserProfile: async (_t: string, id: string) => { asked++; return { userType: id === 'auth0|admin' ? 'ADMIN' : 'USER' }; },
    } as unknown as AccountApiService;
    svc = new StudioAdminService(accounts, s.db);
    insertTeam(s.db, 'team-1', 'auth0|owner');
    insertTeam(s.db, 'team-2', 'auth0|other');
    s.db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-2', 'auth0|owner', 'editor', ?)", [new Date().toISOString()]);
  });
  afterEach(() => s.close());

  it('asks the Account API once per request', async () => {
    const r = req('auth0|admin');
    expect(await svc.isAdmin(r)).toBe(true);
    expect(await svc.isAdmin(r)).toBe(true);
    expect(asked).toBe(1);
    await expect(svc.requireAdmin(req('auth0|owner'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the Account API out of reach reads as not an admin', async () => {
    const down = new StudioAdminService({ getUserProfile: async () => { throw new Error('down'); } } as unknown as AccountApiService, s.db);
    expect(await down.isAdmin(req('auth0|admin'))).toBe(false);
  });

  it('owners see the teams they own; an admin sees all; others are refused', async () => {
    expect(svc.ownedTeamIds('auth0|owner')).toEqual(['team-1']);
    expect(await svc.viewScope(req('auth0|admin'))).toEqual({ all: true });
    expect(await svc.viewScope(req('auth0|admin'), 'team-2')).toEqual({ all: false, teamIds: ['team-2'] });
    expect(await svc.viewScope(req('auth0|owner'))).toEqual({ all: false, teamIds: ['team-1'] });
    expect(await svc.viewScope(req('auth0|owner'), 'team-1')).toEqual({ all: false, teamIds: ['team-1'] });
    await expect(svc.viewScope(req('auth0|owner'), 'team-2')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.viewScope(req('auth0|nobody'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
