/**
 * Teams GĐ3 against a real studio.db and engine core: rename, delete (409 while a production of the team has an
 * active plan or episode run), last-owner protection, paged lists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { cancelPlan, startEpisodeRun, startPlanRun } from '@ag-studio/engine';
import { TeamsService } from './teams.service';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';

function conflictCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConflictException) return (e.getResponse() as { code?: string }).code;
    throw e;
  }
  return undefined;
}

describe('TeamsService (real studio.db)', () => {
  let s: RealStudio;
  let svc: TeamsService;
  beforeEach(async () => {
    s = await realStudio();
    svc = new TeamsService(s.db, s.engine);
    insertTeam(s.db, 'team-1', 'owner-1');
  });
  afterEach(() => s.close());

  /** A production of team-1 that can start a plan run. */
  function production(id: string): void {
    const now = new Date().toISOString();
    s.db.run(
      `INSERT INTO productions (id, team_id, title, brief, created_at, updated_at, owner_user_id, episode_target_seconds, max_episodes)
       VALUES (?, 'team-1', 'P', 'mô tả', ?, ?, 'owner-1', 300, 3)`,
      [id, now, now],
    );
    s.db.run('INSERT INTO production_sources (production_id, source_id, added_at) VALUES (?, ?, ?)', [id, 'folder-1', now]);
  }

  it('renames a team and 404s on a missing one', () => {
    expect(svc.updateTeam('team-1', 'Đội mới').name).toBe('Đội mới');
    expect(() => svc.updateTeam('missing', 'x')).toThrow(NotFoundException);
  });

  it('refuses to delete a team while a plan run of its production is active, then deletes it', () => {
    production('p1');
    startPlanRun(s.engine.core, s.engine.db, 'p1');
    expect(conflictCode(() => svc.deleteTeam('team-1'))).toBe('team_has_active_runs');
    cancelPlan(s.engine.core, s.engine.db, 'p1');
    svc.deleteTeam('team-1');
    expect(s.db.get('SELECT id FROM teams WHERE id = ?', ['team-1'])).toBeUndefined();
  });

  it('counts an active episode run as well', () => {
    production('p1');
    const now = new Date().toISOString();
    s.db.run("INSERT INTO episodes (id, production_id, idx, title, hook, plan, created_at, updated_at) VALUES ('e1', 'p1', 1, 'T', 'h', '{}', ?, ?)", [now, now]);
    startEpisodeRun(s.engine.core, s.engine.db, 'e1');
    expect(conflictCode(() => svc.deleteTeam('team-1'))).toBe('team_has_active_runs');
  });

  it('protects the last owner from removal and demotion', () => {
    svc.addMember('team-1', 'editor-1', 'editor');
    expect(conflictCode(() => svc.removeMember('team-1', 'owner-1'))).toBe('last_owner');
    expect(conflictCode(() => svc.updateMemberRole('team-1', 'owner-1', 'editor'))).toBe('last_owner');
    svc.updateMemberRole('team-1', 'editor-1', 'owner');
    svc.updateMemberRole('team-1', 'owner-1', 'producer');
    svc.removeMember('team-1', 'owner-1');
    expect(svc.listMembers('team-1').map((m) => m.userId)).toEqual(['editor-1']);
  });

  it('pages teams: members see theirs with their role, admins see all', () => {
    insertTeam(s.db, 'team-2', 'someone-else');
    production('p1');
    const mine = svc.listTeamsPaged('owner-1', false, { page: 1, pageSize: 10 });
    expect(mine.total).toBe(1);
    expect(mine.items[0]).toMatchObject({ id: 'team-1', role: 'owner', memberCount: 1, productionCount: 1 });
    const all = svc.listTeamsPaged('admin', true, { page: 1, pageSize: 10, sortBy: 'name', sortOrder: 'desc' });
    expect(all.total).toBe(2);
    expect(all.items.map((t) => t.id)).toEqual(['team-2', 'team-1']);
    expect(all.items[0]?.role).toBeNull();
  });

  it('pages members', () => {
    svc.addMember('team-1', 'a', 'viewer');
    svc.addMember('team-1', 'b', 'editor');
    const page = svc.listMembersPaged('team-1', { page: 2, pageSize: 2, sortBy: 'joinedAt', sortOrder: 'asc' });
    expect(page.total).toBe(3);
    expect(page.items.map((m) => m.userId)).toEqual(['b']);
  });
});
