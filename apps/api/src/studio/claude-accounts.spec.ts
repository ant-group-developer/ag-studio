import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AccountApiService } from '../auth/account-api.service';
import { StudioAdminService } from '../auth/studio-admin.service';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import { ClaudeAccountsController } from './claude-accounts.controller';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const accounts = { getUserProfile: async (_t: string, id: string) => ({ userType: id === 'auth0|admin' ? 'ADMIN' : 'USER' }) } as unknown as AccountApiService;
const config = (key?: string) => ({ get: (k: string) => (k === 'STUDIO_SECRET_KEY' ? key : undefined) }) as unknown as ConfigService;
const ADMIN = req('auth0|admin');

describe('ClaudeAccountsController (real database)', () => {
  let s: RealStudio;
  beforeEach(async () => { s = await realStudio(); await insertTeam(s.db, 'team-1', 'auth0|owner'); });
  afterEach(() => s.close());
  const ctl = (key?: string) => new ClaudeAccountsController(s.engine, new StudioAdminService(accounts, s.db), config(key));

  it('only an admin lists or adds accounts; the token never comes back', async () => {
    const c = ctl('a-long-enough-secret-key');
    await expect(c.list(req('auth0|owner'))).rejects.toBeInstanceOf(ForbiddenException);
    const made = await c.create({ name: 'HCM', token: 'sk-ant-oat01-secret-9876', maxConcurrent: 2 }, ADMIN);
    expect(made).toMatchObject({ name: 'HCM', tokenHint: '9876', maxConcurrent: 2, isDefault: false });
    const listed = await c.list(ADMIN);
    expect(listed.canStoreTokens).toBe(true);
    expect(listed.accounts.map((a) => [a.name, a.running])).toEqual([['Mặc định', 0], ['HCM', 0]]);
    expect(JSON.stringify(listed)).not.toContain('secret-9876');
    expect(await c.update(made.id, { maxConcurrent: null, enabled: false }, ADMIN)).toMatchObject({ maxConcurrent: null, enabled: false });
    expect((await c.check(made.id, ADMIN)).check.requestedAt).toBeTruthy();
    await c.remove(made.id, ADMIN);
    await expect(c.remove(made.id, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('without STUDIO_SECRET_KEY a token cannot be kept', async () => {
    const c = ctl();
    expect((await c.list(ADMIN)).canStoreTokens).toBe(false);
    await expect(c.create({ name: 'HCM', token: 'tok' }, ADMIN)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("a team's accounts and farm pool: set by an admin, read by its owner", async () => {
    const c = ctl('a-long-enough-secret-key');
    const a = await c.create({ name: 'HCM', token: 'tok-a' }, ADMIN);
    expect(await c.teamResources('team-1')).toEqual({ claudeAccounts: [], farmPool: null });
    await expect(c.setTeamResources('team-1', { farmPool: 'hcm' }, req('auth0|owner'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(await c.setTeamResources('team-1', { claudeAccountIds: [a.id], farmPool: 'hcm' }, ADMIN))
      .toEqual({ claudeAccounts: [{ id: a.id, name: 'HCM', enabled: true }], farmPool: 'hcm' });
    await expect(c.setTeamResources('team-1', { farmPool: 'Not A Pool' }, ADMIN)).rejects.toBeInstanceOf(UnprocessableEntityException);
    // a bad pool leaves the accounts as they were (one transaction)
    await expect(c.setTeamResources('team-1', { claudeAccountIds: [], farmPool: 'Bad!' }, ADMIN)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect((await c.teamResources('team-1')).claudeAccounts).toHaveLength(1);
  });
});
