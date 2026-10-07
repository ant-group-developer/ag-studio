import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { acquireChatSlot, createDraftProduction } from '@ag-studio/engine';
import type { AccountApiService } from '../auth/account-api.service';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from './engine.service';
import { StudioOverviewController } from './studio-overview.controller';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const accounts = { getUserProfile: async (_t: string, id: string) => ({ userType: id === 'auth0|admin' ? 'ADMIN' : 'USER' }) } as unknown as AccountApiService;
const config = (v?: string) => ({ get: () => v }) as unknown as ConfigService;

describe('StudioOverviewController (real studio.db)', () => {
  let s: RealStudio;
  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    insertTeam(s.db, 'team-2', 'auth0|other');
  });
  afterEach(() => s.close());

  it('lists the videos of the teams a person is in; an admin sees every one', async () => {
    const ctl = new StudioOverviewController(s.engine as EngineService, accounts, config());
    const mine = createDraftProduction(s.engine.db, 'team-1', 'auth0|owner', new Date().toISOString());
    createDraftProduction(s.engine.db, 'team-2', 'auth0|other', new Date().toISOString());
    expect((await ctl.overview(req('auth0|owner'))).items.map((p) => [p.id, p.group, p.step])).toEqual([[mine, 'waiting_you', 'intake']]);
    expect((await ctl.overview(req('auth0|admin'))).items).toHaveLength(2);
  });

  it('reports Claude slots against the cap: the env value until an admin saves one', async () => {
    const ctl = new StudioOverviewController(s.engine as EngineService, accounts, config('5'));
    const now = new Date().toISOString();
    acquireChatSlot(s.engine.db, 'turn-1', 1, now);
    acquireChatSlot(s.engine.db, 'turn-2', 1, now);
    expect(ctl.claude()).toEqual({ running: 1, waiting: 1, max: 5, source: 'env' });
    await expect(ctl.settings({ claudeMaxConcurrent: 3 }, req('auth0|owner'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(await ctl.settings({ claudeMaxConcurrent: 3 }, req('auth0|admin'))).toMatchObject({ max: 3, source: 'settings' });
  });
});
