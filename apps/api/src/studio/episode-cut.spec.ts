/**
 * The shot-cut routes of an episode (phase 5) over a real studio.db: the edit style and the run's workflow in the
 * detail, the shot frames only for someone whose footage scope covers the production, and rerun-from only for a
 * shot-cut episode, from one of its two gates. The shot-cut flow itself is tested in the engine (it needs ffmpeg).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request } from 'express';
import { MemoryBucket, STUDIO_WORKFLOWS } from '@ag-studio/engine';
import { ROLES_KEY } from '../auth/roles.decorator';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from './engine.service';
import { EpisodesController, RerunFromDto } from './episodes.controller';
import type { FootageAccessService } from './footage-access.service';

const PROD = '22222222-2222-4222-8222-222222222222';
const req = (userId: string) => ({ authContext: { userId, isAdmin: false } }) as unknown as Request;
const covering = (yes: boolean) => ({ coversProduction: async () => yes }) as unknown as FootageAccessService;

describe('shot-cut episode routes (real studio.db)', () => {
  let s: RealStudio;
  let engine: EngineService;

  beforeEach(async () => {
    s = await realStudio();
    const bucket = new MemoryBucket();
    const farm = { getJob: async () => ({ status: 'queued', progress_percent: null }) };
    engine = { ...s.engine, core: s.engine.core, db: s.engine.db, bucket, editor: { db: s.engine.db, bucket, farm }, browserUrlTtl: 60 } as unknown as EngineService;
    insertTeam(s.db, 'team-1', 'auth0|owner');
    const now = new Date().toISOString();
    s.db.run(`INSERT INTO productions (id, team_id, title, status, created_at, updated_at, owner_user_id, keywords, aspect, language)
              VALUES (?, 'team-1', 'Phố cổ', 'draft', ?, ?, 'auth0|owner', '["phố cổ"]', '16:9', 'vi')`, [PROD, now, now]);
    s.db.run(`INSERT INTO episodes (id, production_id, idx, title, hook, created_at, updated_at)
              VALUES ('ep-1', ?, 1, 'Tập 1', 'Mở đầu', ?, ?)`, [PROD, now, now]);
  });
  afterEach(() => s.close());

  it("the detail says the episode's edit style, and its run's workflow once it has one", async () => {
    const ctl = new EpisodesController(engine, covering(true));
    expect(await ctl.detail(PROD, 'ep-1', req('auth0|owner'))).toMatchObject({ editStyle: 'whole', workflow: null });
    await ctl.rerender(PROD, 'ep-1', {}, req('auth0|owner'));
    expect(await ctl.detail(PROD, 'ep-1', req('auth0|owner'))).toMatchObject({ editStyle: 'whole', workflow: STUDIO_WORKFLOWS.episode.workflow });
    s.db.run("UPDATE episodes SET edit_style = 'cut' WHERE id = 'ep-1'");
    expect((await ctl.list(PROD, '1', '20', 'idx', 'asc', req('auth0|owner'))).items[0]).toMatchObject({ editStyle: 'cut' });
  });

  it('shot frames: 403 without the footage scope; a whole-video episode has no shots (422)', async () => {
    const hidden = await new EpisodesController(engine, covering(false)).shots(PROD, 'ep-1', req('auth0|viewer')).catch((e: unknown) => e);
    expect(hidden).toBeInstanceOf(ForbiddenException);
    expect((hidden as ForbiddenException).getResponse()).toMatchObject({ code: 'footage_hidden' });
    const ctl = new EpisodesController(engine, covering(true));
    await ctl.rerender(PROD, 'ep-1', {}, req('auth0|owner'));
    const whole = await ctl.shots(PROD, 'ep-1', req('auth0|owner')).catch((e: unknown) => e);
    expect(whole).toBeInstanceOf(UnprocessableEntityException);
    expect((whole as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'not_cut' });
    expect(Reflect.getMetadata(ROLES_KEY, EpisodesController.prototype.shots)).toEqual(['viewer']);
  });

  it('rerun-from takes only the two shot-cut gates (400 otherwise), refuses a whole-video episode (422); a producer route', async () => {
    const invalid = async (body: object) =>
      (await validate(plainToInstance(RerunFromDto, body) as object, { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);
    expect(await invalid({ stage: 'approve-survey' })).toEqual([]);
    expect(await invalid({ stage: 'approve-edit-plan' })).toEqual([]);
    expect(await invalid({ stage: 'plan-edit' })).toEqual(['stage']);
    expect(await invalid({})).toEqual(['stage']);

    const ctl = new EpisodesController(engine, covering(true));
    await ctl.rerender(PROD, 'ep-1', {}, req('auth0|owner'));
    const whole = await ctl.rerunFrom(PROD, 'ep-1', { stage: 'approve-survey' }).catch((e: unknown) => e);
    expect(whole).toBeInstanceOf(UnprocessableEntityException);
    expect((whole as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'not_cut' });
    expect(Reflect.getMetadata(ROLES_KEY, EpisodesController.prototype.rerunFrom)).toEqual(['producer']);
  });
});
