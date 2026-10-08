/**
 * A step's document over HTTP (real studio.db): read before it ran, edits refused until the step is approved, and an
 * editor may not reopen a step (only save the YouTube kit in place). The engine's flow is tested in step-docs.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import type { Request } from 'express';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from './engine.service';
import { StepDocsController } from './step-docs.controller';

const PROD = '55555555-5555-4555-8555-555555555555';
const EP = '66666666-6666-4666-8666-666666666666';
const req = (userId: string) => ({ authContext: { userId, isAdmin: false } }) as unknown as Request;

describe('step documents (real studio.db)', () => {
  let s: RealStudio;
  let ctl: StepDocsController;
  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    const now = new Date().toISOString();
    s.db.run('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', ['team-1', 'auth0|editor', 'editor', now]);
    s.db.run(`INSERT INTO productions (id, team_id, title, status, created_at, updated_at, owner_user_id)
              VALUES (?, 'team-1', 'Phở', 'draft', ?, ?, 'auth0|owner')`, [PROD, now, now]);
    s.db.run(`INSERT INTO episodes (id, production_id, idx, title, hook, created_at, updated_at)
              VALUES (?, ?, 1, 'Tập một', '', ?, ?)`, [EP, PROD, now, now]);
    ctl = new StepDocsController(s.engine as EngineService);
  });
  afterEach(() => s.close());

  it('reads a step that has not run as not_yet, and refuses edits until it is approved', async () => {
    expect(await ctl.seriesStep(PROD, 'rnd')).toMatchObject({ kind: 'rnd', gate: 'approve-rnd', state: 'not_yet', document: null });
    expect(await ctl.episodeStep(PROD, EP, 'youtube_kit')).toMatchObject({ state: 'not_yet' });
    await expect(ctl.editSeriesStep(PROD, 'rnd', { document: {} }, req('auth0|owner'))).rejects.toBeInstanceOf(ConflictException);
    await expect(ctl.seriesStep(PROD, 'nope')).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(ctl.episodeStep(PROD, EP, 'rnd')).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('an editor saves the YouTube kit, but reopening a step or editing the scenes needs a producer', async () => {
    expect(() => ctl.editEpisodeStep(PROD, EP, 'survey', { document: {} }, req('auth0|editor'))).toThrow(ForbiddenException);
    expect(() => ctl.editEpisodeStep(PROD, EP, 'youtube_kit', { document: {}, reopen: true }, req('auth0|editor'))).toThrow(ForbiddenException);
    // let through, refused by the engine (the kit is not approved yet)
    await expect(ctl.editEpisodeStep(PROD, EP, 'youtube_kit', { document: {} }, req('auth0|editor'))).rejects.toBeInstanceOf(ConflictException);
    await expect(ctl.editEpisodeStep(PROD, EP, 'survey', { document: {} }, req('auth0|owner'))).rejects.toBeInstanceOf(ConflictException);
  });
});
