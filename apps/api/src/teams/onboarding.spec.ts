/**
 * Getting started progress and the person's prefs against a real database: each checklist step counts only in the
 * caller's own teams (chat turns only their own), "Go to" leads to the project and video touched last, and prefs
 * change only in the fields given.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { addSource, createJob, createProject, createThread, createVideo, finishJob, postUserMessage } from '@ag-studio/engine';
import { OnboardingService, UserPrefsPatchSchema } from './onboarding.service';
import { parseBody } from '../workspace/zod-body';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';

describe('OnboardingService (real database)', () => {
  let s: RealStudio;
  let svc: OnboardingService;
  beforeEach(async () => {
    s = await realStudio();
    svc = new OnboardingService(s.db);
  });
  afterEach(() => s.close());

  const doneKeys = async (userId: string) => (await svc.progress(userId)).steps.filter((x) => x.done).map((x) => x.key);
  const project = async (teamId: string, by: string, at: string) =>
    (await createProject(s.engine.db, teamId, { name: 'Du lịch chậm', description: '', language: 'vi', aspect: '16:9' }, by, at)).id;

  it('starts at 0/7 with nowhere to go', async () => {
    expect(await svc.progress('new-person')).toEqual({
      steps: ['team', 'project', 'footage', 'video', 'chat', 'preview', 'final'].map((key) => ({ key, done: false, count: 0 })),
      done: 0, total: 7, links: { teamId: null, projectId: null, video: null },
    });
  });

  it('ticks each step as it happens in the caller’s teams', async () => {
    await insertTeam(s.db, 'team-1', 'an');
    expect(await doneKeys('an')).toEqual(['team']);
    expect((await svc.progress('an')).links.teamId).toBe('team-1');

    const p = await project('team-1', 'an', '2026-10-13T01:00:00.000Z');
    await addSource(s.engine.db, { projectId: p, kind: 'ag_go_project', ref: 'agp-1', mediaType: 'video', label: 'Hoa Lư', addedBy: 'an' });
    const v = await createVideo(s.engine.db, p, { title: 'Tràng An', createdBy: 'an' });
    expect(await doneKeys('an')).toEqual(['team', 'project', 'footage', 'video']);

    const thread = await createThread(s.engine.db, { projectId: p, videoId: v.id, kind: 'video', title: 'Tràng An', createdBy: 'an' });
    await postUserMessage(s.engine.db, { threadId: thread.id, text: 'chào', actor: { id: 'an', role: 'owner' } });
    const preview = await createJob(s.engine.db, { projectId: p, videoId: v.id, kind: 'render_preview', title: 'Xem trước', request: {}, createdBy: 'an' });
    await finishJob(s.engine.db, preview.id, { status: 'done' }, new Date().toISOString());
    // a final that failed does not count
    const final = await createJob(s.engine.db, { projectId: p, videoId: v.id, kind: 'render_final', title: 'Bản cuối', request: {}, createdBy: 'an' });
    await finishJob(s.engine.db, final.id, { status: 'failed', error: 'x' }, new Date().toISOString());

    const out = await svc.progress('an');
    expect(out.steps.filter((x) => x.done).map((x) => x.key)).toEqual(['team', 'project', 'footage', 'video', 'chat', 'preview']);
    expect(out.done).toBe(6);
    expect(out.links).toEqual({ teamId: 'team-1', projectId: p, video: { projectId: p, videoId: v.id } });
  });

  it('counts a teammate’s work but only the caller’s own chat, and nothing of other teams', async () => {
    await insertTeam(s.db, 'team-1', 'an');
    await insertTeam(s.db, 'team-2', 'binh');
    await s.db.run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', ['team-1', 'binh', 'editor', new Date().toISOString()]);
    const p1 = await project('team-1', 'an', '2026-10-13T01:00:00.000Z');
    const t1 = await createThread(s.engine.db, { projectId: p1, kind: 'project', title: 'Kênh', createdBy: 'an' });
    await postUserMessage(s.engine.db, { threadId: t1.id, text: 'chào', actor: { id: 'an', role: 'owner' } });
    const p2 = await project('team-2', 'binh', '2026-10-13T02:00:00.000Z');
    await createVideo(s.engine.db, p2, { title: 'Huế', createdBy: 'binh' });

    expect(await doneKeys('binh')).toEqual(['team', 'project', 'video']);
    expect((await svc.progress('binh')).steps.find((x) => x.key === 'project')?.count).toBe(2);
    // an is not in team-2: its project and video are not theirs
    expect(await doneKeys('an')).toEqual(['team', 'project', 'chat']);
    expect((await svc.progress('an')).links).toEqual({ teamId: 'team-1', projectId: p1, video: null });
    // the project worked in last leads, with its team
    expect((await svc.progress('binh')).links.projectId).toBe(p2);
    expect((await svc.progress('binh')).links.teamId).toBe('team-2');
  });

  it('reads default prefs, then changes only the fields given', async () => {
    expect(await svc.prefs('an')).toEqual({ tourSeen: { projects: false, project: false }, checklistHidden: false });
    expect(await svc.updatePrefs('an', { tourSeen: { projects: true } })).toEqual({ tourSeen: { projects: true, project: false }, checklistHidden: false });
    await svc.updatePrefs('an', { checklistHidden: true });
    expect(await svc.prefs('an')).toEqual({ tourSeen: { projects: true, project: false }, checklistHidden: true });
    await svc.updatePrefs('an', { tourSeen: { projects: false, project: false } });
    expect(await svc.prefs('an')).toEqual({ tourSeen: { projects: false, project: false }, checklistHidden: true });
    expect((await svc.prefs('binh')).checklistHidden).toBe(false);
  });

  it('two changes at once both land', async () => {
    await Promise.all([svc.updatePrefs('an', { tourSeen: { projects: true } }), svc.updatePrefs('an', { checklistHidden: true })]);
    expect(await svc.prefs('an')).toEqual({ tourSeen: { projects: true, project: false }, checklistHidden: true });
  });

  it('reads a row of the wrong shape as defaults and refuses unknown fields', async () => {
    await s.db.run('INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?)', ['an', '"nope"', new Date().toISOString()]);
    expect(await svc.prefs('an')).toEqual({ tourSeen: { projects: false, project: false }, checklistHidden: false });
    expect(() => parseBody(UserPrefsPatchSchema, { theme: 'dark' })).toThrow(BadRequestException);
    expect(() => parseBody(UserPrefsPatchSchema, { tourSeen: { projects: 'yes' } })).toThrow(BadRequestException);
  });
});
