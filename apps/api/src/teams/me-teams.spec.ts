/**
 * Teams against a real database: rename, delete (409 while a job or an agent turn of one of the team's projects
 * runs), last-owner protection, paged lists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createJob, createProject, createThread, finishJob, postUserMessage } from '@ag-studio/engine';
import { TeamsService } from './teams.service';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';

async function conflictCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConflictException) return (e.getResponse() as { code?: string }).code;
    throw e;
  }
  return undefined;
}

describe('TeamsService (real database)', () => {
  let s: RealStudio;
  let svc: TeamsService;
  beforeEach(async () => {
    s = await realStudio();
    svc = new TeamsService(s.db);
    await insertTeam(s.db, 'team-1', 'owner-1');
  });
  afterEach(() => s.close());

  /** A project of team-1. */
  async function project(): Promise<string> {
    return (await createProject(s.engine.db, 'team-1', { name: 'Du lịch chậm', description: '', language: 'vi', aspect: '16:9' }, 'owner-1')).id;
  }

  it('renames a team and 404s on a missing one', async () => {
    expect((await svc.updateTeam('team-1', 'Đội mới')).name).toBe('Đội mới');
    await expect(svc.updateTeam('missing', 'x')).rejects.toThrow(NotFoundException);
  });

  it('refuses to delete a team while a job of its project runs, then deletes it', async () => {
    const job = await createJob(s.engine.db, { projectId: await project(), kind: 'research', title: 'Crawl', request: {}, createdBy: 'owner-1' });
    expect(await conflictCode(svc.deleteTeam('team-1'))).toBe('team_has_active_runs');
    await finishJob(s.engine.db, job.id, { status: 'cancelled' }, new Date().toISOString());
    await svc.deleteTeam('team-1');
    expect(await s.db.get('SELECT id FROM teams WHERE id = ?', ['team-1'])).toBeUndefined();
  });

  it('counts an agent turn waiting or running as well', async () => {
    const thread = await createThread(s.engine.db, { projectId: await project(), kind: 'project', title: 'Kênh', createdBy: 'owner-1' });
    await postUserMessage(s.engine.db, { threadId: thread.id, text: 'chào', actor: { id: 'owner-1', role: 'owner' } });
    expect(await conflictCode(svc.deleteTeam('team-1'))).toBe('team_has_active_runs');
  });

  it('protects the last owner from removal and demotion', async () => {
    await svc.addMember('team-1', 'editor-1', 'editor');
    expect(await conflictCode(svc.removeMember('team-1', 'owner-1'))).toBe('last_owner');
    expect(await conflictCode(svc.updateMemberRole('team-1', 'owner-1', 'editor'))).toBe('last_owner');
    await svc.updateMemberRole('team-1', 'editor-1', 'owner');
    await svc.updateMemberRole('team-1', 'owner-1', 'producer');
    await svc.removeMember('team-1', 'owner-1');
    expect((await svc.listMembers('team-1')).map((m) => m.userId)).toEqual(['editor-1']);
  });

  it('two owners stepping down at once leave one owner', async () => {
    await svc.addMember('team-1', 'owner-2', 'owner');
    const out = await Promise.all([
      conflictCode(svc.updateMemberRole('team-1', 'owner-1', 'editor')),
      conflictCode(svc.removeMember('team-1', 'owner-2')),
    ]);
    expect(out.filter((c) => c === 'last_owner')).toHaveLength(1);
    expect((await svc.listMembers('team-1')).filter((m) => m.role === 'owner')).toHaveLength(1);
  });

  it('adding the same person twice is a 409', async () => {
    await svc.addMember('team-1', 'a', 'viewer');
    await expect(svc.addMember('team-1', 'a', 'editor')).rejects.toThrow(ConflictException);
  });

  it('pages teams: members see theirs with their role, admins see all', async () => {
    await insertTeam(s.db, 'team-2', 'someone-else');
    await project();
    const mine = await svc.listTeamsPaged('owner-1', false, { page: 1, pageSize: 10 });
    expect(mine.total).toBe(1);
    expect(mine.items[0]).toMatchObject({ id: 'team-1', role: 'owner', memberCount: 1, projectCount: 1 });
    const all = await svc.listTeamsPaged('admin', true, { page: 1, pageSize: 10, sortBy: 'name', sortOrder: 'desc' });
    expect(all.total).toBe(2);
    expect(all.items.map((t) => t.id)).toEqual(['team-2', 'team-1']);
    expect(all.items[0]?.role).toBeNull();
  });

  it('pages members', async () => {
    await svc.addMember('team-1', 'a', 'viewer');
    await svc.addMember('team-1', 'b', 'editor');
    const page = await svc.listMembersPaged('team-1', { page: 2, pageSize: 2, sortBy: 'joinedAt', sortOrder: 'asc' });
    expect(page.total).toBe(3);
    expect(page.items.map((m) => m.userId)).toEqual(['b']);
  });
});
