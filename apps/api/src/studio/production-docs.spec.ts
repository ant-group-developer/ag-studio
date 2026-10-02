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
