/**
 * RolesGuard on workspace routes: the team of `:projectId` / `:videoId` comes from the database, so a member's role in
 * that team decides, and an id of another team's project never borrows this team's membership.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createProject, createVideo } from '@ag-studio/engine';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY, type TeamRole } from './roles.decorator';
import type { AccountApiService } from './account-api.service';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';

const accounts = { getUserProfile: async () => ({ userType: 'USER' }) } as unknown as AccountApiService;

function ctx(userId: string, params: Record<string, string>): ExecutionContext {
  const request = { authContext: { userId, accessToken: 't' }, params };
  return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
}

describe('RolesGuard on project and video routes (real database)', () => {
  let s: RealStudio;
  const guard = (role: TeamRole) => {
    const reflector = { getAllAndOverride: (key: string) => (key === ROLES_KEY ? [role] : undefined) } as unknown as Reflector;
    return new RolesGuard(reflector, s.db, accounts);
  };
  const outcome = async (p: Promise<boolean>) => p.then(() => 'ok', (e: unknown) => (e instanceof ForbiddenException ? 'forbidden' : String(e)));

  beforeEach(async () => { s = await realStudio(); });
  afterEach(() => s.close());

  it('finds the team of a project and of a video, and checks the role there', async () => {
    await insertTeam(s.db, 'team-a', 'auth0|owner-a');
    await insertTeam(s.db, 'team-b', 'auth0|owner-b');
    await s.db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-a', 'auth0|viewer', 'viewer', ?)", [new Date().toISOString()]);
    const p = await createProject(s.engine.db, 'team-a', { name: 'A', description: '', language: 'vi', aspect: '16:9' }, 'auth0|owner-a');
    const v = await createVideo(s.engine.db, p.id, { title: 'v', createdBy: 'auth0|owner-a' });

    expect(await outcome(guard('viewer').canActivate(ctx('auth0|viewer', { projectId: p.id })))).toBe('ok');
    expect(await outcome(guard('editor').canActivate(ctx('auth0|viewer', { projectId: p.id })))).toBe('forbidden');
    expect(await outcome(guard('producer').canActivate(ctx('auth0|owner-a', { videoId: v.id })))).toBe('ok');
    expect(await outcome(guard('viewer').canActivate(ctx('auth0|owner-b', { videoId: v.id })))).toBe('forbidden');
    expect(await outcome(guard('viewer').canActivate(ctx('auth0|owner-a', { projectId: 'unknown' })))).toBe('forbidden');
  });
});
