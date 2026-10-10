/**
 * Teams against a real studio.db: rename, delete (409 while a job or an agent turn of one of the team's projects
 * runs), last-owner protection, paged lists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createJob, createProject, createThread, finishJob, postUserMessage } from '@ag-studio/engine';
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
    svc = new TeamsService(s.db);
    insertTeam(s.db, 'team-1', 'owner-1');
  });
  afterEach(() => s.close());

  /** A project of team-1. */
  function project(): string {
    return createProject(s.engine.db, 'team-1', { name: 'Du lịch chậm', description: '', language: 'vi', aspect: '16:9' }, 'owner-1').id;
  }

  it('renames a team and 404s on a missing one', () => {
    expect(svc.updateTeam('team-1', 'Đội mới').name).toBe('Đội mới');
    expect(() => svc.updateTeam('missing', 'x')).toThrow(NotFoundException);
  });

  it('refuses to delete a team while a job of its project runs, then deletes it', () => {
    const job = createJob(s.engine.db, { projectId: project(), kind: 'research', title: 'Crawl', request: {}, createdBy: 'owner-1' });
    expect(conflictCode(() => svc.deleteTeam('team-1'))).toBe('team_has_active_runs');
    finishJob(s.engine.db, job.id, { status: 'cancelled' }, new Date().toISOString());
    svc.deleteTeam('team-1');
    expect(s.db.get('SELECT id FROM teams WHERE id = ?', ['team-1'])).toBeUndefined();
  });

  it('counts an agent turn waiting or running as well', () => {
    const thread = createThread(s.engine.db, { projectId: project(), kind: 'project', title: 'Kênh', createdBy: 'owner-1' });
    postUserMessage(s.engine.db, { threadId: thread.id, text: 'chào', actor: { id: 'owner-1', role: 'owner' } });
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
    project();
    const mine = svc.listTeamsPaged('owner-1', false, { page: 1, pageSize: 10 });
    expect(mine.total).toBe(1);
    expect(mine.items[0]).toMatchObject({ id: 'team-1', role: 'owner', memberCount: 1, projectCount: 1 });
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
