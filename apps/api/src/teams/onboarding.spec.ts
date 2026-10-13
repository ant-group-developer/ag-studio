/**
 * Getting started progress and the person's prefs against a real studio.db: each checklist step counts only in the
 * caller's own teams (chat turns only their own), "Go to" leads to the project and video touched last, and prefs
 * change only in the fields given.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { addSource, createJob, createProject, createThread, createVideo, finishJob, postUserMessage } from '@ag-studio/engine';
import { OnboardingService, UserPrefsPatchSchema } from './onboarding.service';
import { parseBody } from '../workspace/zod-body';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';

describe('OnboardingService (real studio.db)', () => {
  let s: RealStudio;
  let svc: OnboardingService;
  beforeEach(async () => {
    s = await realStudio();
    svc = new OnboardingService(s.db);
  });
  afterEach(() => s.close());

  const doneKeys = (userId: string) => svc.progress(userId).steps.filter((x) => x.done).map((x) => x.key);
  const project = (teamId: string, by: string, at: string) =>
    createProject(s.engine.db, teamId, { name: 'Du lịch chậm', description: '', language: 'vi', aspect: '16:9' }, by, at).id;

  it('starts at 0/7 with nowhere to go', () => {
    expect(svc.progress('new-person')).toEqual({
      steps: ['team', 'project', 'footage', 'video', 'chat', 'preview', 'final'].map((key) => ({ key, done: false, count: 0 })),
      done: 0, total: 7, links: { teamId: null, projectId: null, video: null },
    });
  });

  it('ticks each step as it happens in the caller’s teams', () => {
    insertTeam(s.db, 'team-1', 'an');
    expect(doneKeys('an')).toEqual(['team']);
    expect(svc.progress('an').links.teamId).toBe('team-1');

    const p = project('team-1', 'an', '2026-10-13T01:00:00.000Z');
    addSource(s.engine.db, { projectId: p, kind: 'ag_go_project', ref: 'agp-1', mediaType: 'video', label: 'Hoa Lư', addedBy: 'an' });
    const v = createVideo(s.engine.db, p, { title: 'Tràng An', createdBy: 'an' });
    expect(doneKeys('an')).toEqual(['team', 'project', 'footage', 'video']);

    const thread = createThread(s.engine.db, { projectId: p, videoId: v.id, kind: 'video', title: 'Tràng An', createdBy: 'an' });
    postUserMessage(s.engine.db, { threadId: thread.id, text: 'chào', actor: { id: 'an', role: 'owner' } });
    const preview = createJob(s.engine.db, { projectId: p, videoId: v.id, kind: 'render_preview', title: 'Xem trước', request: {}, createdBy: 'an' });
    finishJob(s.engine.db, preview.id, { status: 'done' }, new Date().toISOString());
    // a final that failed does not count
    const final = createJob(s.engine.db, { projectId: p, videoId: v.id, kind: 'render_final', title: 'Bản cuối', request: {}, createdBy: 'an' });
    finishJob(s.engine.db, final.id, { status: 'failed', error: 'x' }, new Date().toISOString());

    const out = svc.progress('an');
    expect(out.steps.filter((x) => x.done).map((x) => x.key)).toEqual(['team', 'project', 'footage', 'video', 'chat', 'preview']);
    expect(out.done).toBe(6);
    expect(out.links).toEqual({ teamId: 'team-1', projectId: p, video: { projectId: p, videoId: v.id } });
  });

  it('counts a teammate’s work but only the caller’s own chat, and nothing of other teams', () => {
    insertTeam(s.db, 'team-1', 'an');
    insertTeam(s.db, 'team-2', 'binh');
    s.db.run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', ['team-1', 'binh', 'editor', new Date().toISOString()]);
    const p1 = project('team-1', 'an', '2026-10-13T01:00:00.000Z');
    const t1 = createThread(s.engine.db, { projectId: p1, kind: 'project', title: 'Kênh', createdBy: 'an' });
    postUserMessage(s.engine.db, { threadId: t1.id, text: 'chào', actor: { id: 'an', role: 'owner' } });
    const p2 = project('team-2', 'binh', '2026-10-13T02:00:00.000Z');
    createVideo(s.engine.db, p2, { title: 'Huế', createdBy: 'binh' });

    expect(doneKeys('binh')).toEqual(['team', 'project', 'video']);
    expect(svc.progress('binh').steps.find((x) => x.key === 'project')?.count).toBe(2);
    // an is not in team-2: its project and video are not theirs
    expect(doneKeys('an')).toEqual(['team', 'project', 'chat']);
    expect(svc.progress('an').links).toEqual({ teamId: 'team-1', projectId: p1, video: null });
    // the project worked in last leads, with its team
    expect(svc.progress('binh').links.projectId).toBe(p2);
    expect(svc.progress('binh').links.teamId).toBe('team-2');
  });

  it('reads default prefs, then changes only the fields given', () => {
    expect(svc.prefs('an')).toEqual({ tourSeen: { projects: false, project: false }, checklistHidden: false });
    expect(svc.updatePrefs('an', { tourSeen: { projects: true } })).toEqual({ tourSeen: { projects: true, project: false }, checklistHidden: false });
    svc.updatePrefs('an', { checklistHidden: true });
    expect(svc.prefs('an')).toEqual({ tourSeen: { projects: true, project: false }, checklistHidden: true });
    svc.updatePrefs('an', { tourSeen: { projects: false, project: false } });
    expect(svc.prefs('an')).toEqual({ tourSeen: { projects: false, project: false }, checklistHidden: true });
    expect(svc.prefs('binh').checklistHidden).toBe(false);
  });

  it('reads a broken row as defaults and refuses unknown fields', () => {
    s.db.run('INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?)', ['an', '{nope', new Date().toISOString()]);
    expect(svc.prefs('an')).toEqual({ tourSeen: { projects: false, project: false }, checklistHidden: false });
    expect(() => parseBody(UserPrefsPatchSchema, { theme: 'dark' })).toThrow(BadRequestException);
    expect(() => parseBody(UserPrefsPatchSchema, { tourSeen: { projects: 'yes' } })).toThrow(BadRequestException);
  });
});
