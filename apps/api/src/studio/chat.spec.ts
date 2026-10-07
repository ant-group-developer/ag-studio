/**
 * Chat routes over a real studio.db and engine: a video from one message, @folder checks, roles of apply/approve,
 * 409 while the run is busy, approving the version on show.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import type { Request } from 'express';
import { completeTurn, getProduction, readStageDocument, startPlanRun, type IntakeFolder } from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import { ChatController, type ChatFolders } from './chat.controller';
import type { EngineService } from './engine.service';

const req = (userId: string, isAdmin = false) => ({ authContext: { userId, isAdmin } }) as unknown as Request;
const folders: IntakeFolder[] = [{ id: 'f-kyoto', name: 'Kyoto 2025', usableVideos: 38 }];
const fakeFolders = { forUser: async () => folders } as unknown as ChatFolders;
const now = () => new Date().toISOString();

describe('ChatController (real studio.db)', () => {
  let s: RealStudio;
  let ctl: ChatController;
  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    s.db.run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', ['team-1', 'auth0|editor', 'editor', now()]);
    ctl = new ChatController(s.engine as EngineService, s.db, fakeFolders);
  });
  afterEach(() => s.close());

  it('one message makes a draft video with the folders the person sees on the turn', async () => {
    const r = await ctl.createDraft('team-1', { text: 'Làm series từ @[Kyoto 2025](folder:f-kyoto)' }, req('auth0|owner'));
    expect(getProduction(s.engine.db, r.productionId)).toMatchObject({ team_id: 'team-1', title: 'Video mới', owner_user_id: 'auth0|owner', run_id: null });
    expect(r.user).toMatchObject({ scope: 'intake', mentions: [{ id: 'f-kyoto' }], context: { folders } });
    expect(r.assistant).toMatchObject({ status: 'pending' });
    const thread = await ctl.thread(r.productionId, {});
    expect(thread.turns).toHaveLength(2);
    expect(thread.scope).toMatchObject({ scope: 'intake' });
  });

  it('refuses a folder the person cannot see', async () => {
    await expect(ctl.createDraft('team-1', { text: 'từ @[Bí mật](folder:f-secret)' }, req('auth0|owner'))).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('Bắt đầu needs a complete intake; applying an intake draft needs a producer', async () => {
    const r = await ctl.createDraft('team-1', { text: 'Làm series từ @[Kyoto 2025](folder:f-kyoto)' }, req('auth0|owner'));
    await expect(ctl.start(r.productionId)).rejects.toMatchObject({ response: { code: 'intake_incomplete' } });
    const draft = {
      schema_version: 'studio.intake-draft/v1', title: 'Series Kyoto', folder_ids: ['f-kyoto'], channels: [], keywords: ['kyoto vlog'],
      aspect: '16:9', language: 'vi', questions: [],
      hints: { description: '', goal: '', audience: '', tone: '', notes: '', episode_target_seconds: null, max_episodes: null },
    };
    completeTurn(s.engine.db, r.assistant!.id, { text: 'Đủ rồi', action: 'suggest_approve', proposal: draft, problems: [], llmCallId: null }, now());
    await expect(ctl.apply(r.productionId, r.assistant!.id, req('auth0|editor'))).rejects.toBeInstanceOf(ForbiddenException);
    await ctl.apply(r.productionId, r.assistant!.id, req('auth0|owner'));
    expect(getProduction(s.engine.db, r.productionId)?.title).toBe('Series Kyoto');
    const started = await ctl.start(r.productionId);
    expect(started.runId).toBeTruthy();
    // the run is working now: nothing to chat about until it stops at a step
    await expect(ctl.send(r.productionId, { text: 'nhanh lên' }, req('auth0|owner'))).rejects.toBeInstanceOf(ConflictException);
    const thread = await ctl.thread(r.productionId, {});
    expect(thread.blocked).toMatchObject({ code: 'busy' });
  });

  it('approving needs the step to be waiting at that gate', async () => {
    const now0 = now();
    s.db.run(`INSERT INTO productions (id, team_id, title, status, created_at, updated_at, owner_user_id, keywords, aspect, language)
              VALUES ('p1', 'team-1', 'P', 'draft', ?, ?, 'auth0|owner', '["phở"]', '16:9', 'vi')`, [now0, now0]);
    s.db.run("INSERT INTO production_sources (production_id, source_id, added_at) VALUES ('p1', 'f-kyoto', ?)", [now0]);
    startPlanRun(s.engine.core, s.engine.db, 'p1');
    // no worker here: the run has not reached a gate
    await expect(ctl.approve('p1', { stageKey: 'approve-trend-report' }, req('auth0|owner'))).rejects.toBeInstanceOf(ConflictException);
    expect(() => readStageDocument(s.engine.core, getProduction(s.engine.db, 'p1')!.run_id!, 'trend-report', 'trend-report.json')).toThrow();
  });
});
