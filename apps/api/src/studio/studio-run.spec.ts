/**
 * Plan-run routes: the gate routes check the role a second time; a Studio admin passes that check like the guard.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from './engine.service';
import { StudioRunController } from './studio-run.controller';

const PROD = '33333333-3333-4333-8333-333333333333';
const req = (userId: string, isAdmin = false) => ({ authContext: { userId, isAdmin } }) as unknown as Request;

describe('StudioRunController gate roles (real studio.db)', () => {
  let s: RealStudio;
  let ctl: StudioRunController;
  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    s.db.run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', ['team-1', 'auth0|editor', 'editor', new Date().toISOString()]);
    const now = new Date().toISOString();
    s.db.run(`INSERT INTO productions (id, team_id, title, status, created_at, updated_at, owner_user_id) VALUES (?, 'team-1', 'P', 'draft', ?, ?, 'auth0|owner')`, [PROD, now, now]);
    ctl = new StudioRunController(s.engine as EngineService, s.db);
  });
  afterEach(() => s.close());

  it('lets a Studio admin who is not a member through to the gate (here: no run yet -> 404, not 403)', async () => {
    await expect(ctl.approvePlan(PROD, { document: {} }, req('auth0|admin', true))).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.submitGate(PROD, 'approve-plan', { document: {} }, req('auth0|admin', true))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still refuses an editor and someone outside the team', () => {
    expect(() => ctl.approvePlan(PROD, { document: {} }, req('auth0|editor'))).toThrow(ForbiddenException);
    expect(() => ctl.approvePlan(PROD, { document: {} }, req('auth0|stranger'))).toThrow(ForbiddenException);
  });
});
