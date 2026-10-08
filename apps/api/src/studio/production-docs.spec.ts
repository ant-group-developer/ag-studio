/**
 * R&D and branding after approval, over a real studio.db: read, edit by hand (checked like the gate, kept in the
 * dataset), refused before the first approval and with Vietnamese problems when the check fails.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Request } from 'express';
import { listHumanEdits, saveProductionDocument } from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from './engine.service';
import { ProductionDocsController } from './production-docs.controller';

const PROD = '44444444-4444-4444-8444-444444444444';
const req = (userId: string) => ({ authContext: { userId, isAdmin: false } }) as unknown as Request;

const RND = {
  schema_version: 'studio.rnd/v1', summary: 'Series phở sáng.',
  market: { opportunities: [], gaps: [], risks: [], competitors: [] },
  own_channels: { assessment: 'Kênh mới', strengths: [], weaknesses: [], recommendations: [] },
  footage_fit: { summary: 'Nhiều cảnh phở', strong_themes: [], gaps: [] },
  direction: {
    description: 'Mỗi tập một quán phở.', goal: 'Người xem trẻ', audience: '18–30', tone: 'Ấm áp', positioning: 'Chân thật',
    content_pillars: [{ name: 'Quán quen', description: 'Quán lâu năm' }], episode_target_seconds: 300, max_episodes: 4,
    posting_schedule: '', keywords: [], episode_ideas: [], notes: '',
  },
};

describe('R&D and branding of a production (real studio.db)', () => {
  let s: RealStudio;
  let ctl: ProductionDocsController;
  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    const now = new Date().toISOString();
    s.db.run(`INSERT INTO productions (id, team_id, title, status, created_at, updated_at, owner_user_id, own_channels, max_episodes)
              VALUES (?, 'team-1', 'Phở', 'draft', ?, ?, 'auth0|owner', '["@phosang"]', 4)`, [PROD, now, now]);
    ctl = new ProductionDocsController(s.engine as EngineService);
  });
  afterEach(() => s.close());

  it('refuses an edit before the first approval, then saves one and keeps it in the dataset', async () => {
    expect((await ctl.rnd(PROD)).document).toBeNull();
    await expect(ctl.putRnd(PROD, { document: RND }, req('auth0|owner'))).rejects.toBeInstanceOf(ConflictException);

    saveProductionDocument(s.engine.db, PROD, 'rnd', RND as never, 'gate:run_1');
    const edited = { ...RND, direction: { ...RND.direction, description: 'Mỗi tập một quán phở lúc 6 giờ.', max_episodes: 5 } };
    const saved = await ctl.putRnd(PROD, { document: edited }, req('auth0|owner'));
    expect(saved).toMatchObject({ updatedBy: 'auth0|owner', document: { direction: { description: 'Mỗi tập một quán phở lúc 6 giờ.' } } });
    // the person typed 4 episodes before research; deciding 5 now is allowed, with a warning
    expect(saved.warnings.map((w) => w.code)).toEqual(['hint_max_episodes']);
    const edits = listHumanEdits(s.engine.db, { productionId: PROD, page: 1, pageSize: 20 }).items;
    expect(edits.map((e) => e.kind)).toEqual(['rnd_edit']);
    expect(JSON.parse(edits[0]!.before!).direction.description).toBe('Mỗi tập một quán phở.');
  });

  it('answers 422 with the problems when the check fails, and 404 for a missing production', async () => {
    saveProductionDocument(s.engine.db, PROD, 'rnd', RND as never, 'gate:run_1');
    const err = await ctl.putRnd(PROD, { document: { ...RND, own_channels: null } }, req('auth0|owner')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(((err as UnprocessableEntityException).getResponse() as { problems: { code: string }[] }).problems.map((p) => p.code)).toEqual(['own_channels_missing']);
    await expect(ctl.rnd('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

const STYLE = {
  schema_version: 'studio.style/v1', skipped: false, skipped_reason: null, name: 'Chậm', summary: 'Cảnh dài.',
  references: [{ video_id: 'U_17EqTHUIo', title: 'Kyoto', channel_title: 'Mei Time', url: 'https://www.youtube.com/watch?v=U_17EqTHUIo', duration_s: 1299 }],
  measured: { videos: 1, shots: 200, cuts_per_minute: 9, shot_seconds: { p25: 5, median: 6.5, p75: 8 }, first_shot_s: 2 },
  params: {
    cut_rhythm: 'slow', shot_seconds: { min: 5, max: 8 }, transitions: ['cut'], opening: { seconds: 16, structure: 'montage' },
    text_overlay: { density: 'low', style: 'serif' }, subtitles: 'none', voice: 'unknown', music: { mood: '', ducking: null }, visual: '', pace_notes: '',
  },
  do: [], dont: [],
  evidence: [1, 2.5, 4].map((t) => ({ param: 'opening', video_id: 'U_17EqTHUIo', t, note: '' })),
};

describe('the edit style of a production (series plan 3.2.0)', () => {
  let s: RealStudio;
  let ctl: ProductionDocsController;
  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    const now = new Date().toISOString();
    s.db.run(`INSERT INTO productions (id, team_id, title, status, created_at, updated_at, owner_user_id) VALUES (?, 'team-1', 'Phở', 'draft', ?, ?, 'auth0|owner')`, [PROD, now, now]);
    Object.assign(s.engine, { bucket: { signedGetUrl: async (key: string) => `https://signed.example/${key}` }, browserUrlTtl: 60 });
    ctl = new ProductionDocsController(s.engine as EngineService);
  });
  afterEach(() => s.close());

  it('reads and edits the style like the R&D: checked, kept in the dataset as style_edit', async () => {
    expect((await ctl.style(PROD)).document).toBeNull();
    saveProductionDocument(s.engine.db, PROD, 'style', STYLE as never, 'gate:run_1');
    const saved = await ctl.putStyle(PROD, { document: { ...STYLE, do: ['Mở bằng montage'] } }, req('auth0|owner'));
    expect(saved).toMatchObject({ updatedBy: 'auth0|owner', document: { do: ['Mở bằng montage'] } });
    expect(listHumanEdits(s.engine.db, { productionId: PROD, page: 1, pageSize: 20 }).items.map((e) => e.kind)).toEqual(['style_edit']);
    const err = await ctl.putStyle(PROD, { document: { ...STYLE, evidence: [] } }, req('auth0|owner')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
  });

  it('signs the frames the style cites (YouTube frames, kept under the production), and refuses what is not one', async () => {
    const r = await ctl.styleFrames(PROD, 'U_17EqTHUIo@2.5,U_17EqTHUIo@4');
    expect(r.frames).toEqual([
      { video_id: 'U_17EqTHUIo', t: 2.5, url: `https://signed.example/productions/${PROD}/style/U_17EqTHUIo/f-2.500.jpg` },
      { video_id: 'U_17EqTHUIo', t: 4, url: `https://signed.example/productions/${PROD}/style/U_17EqTHUIo/f-4.000.jpg` },
    ]);
    await expect(ctl.styleFrames(PROD, '../../x@1')).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(ctl.styleFrames('missing', 'U_17EqTHUIo@1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
