/**
 * Call log routes and the human-edit records, over a real studio.db.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { listHumanEdits, MemoryBucket, recordLlmCall } from '@ag-studio/engine';
import type { StudioLlmCall } from '@harness/executors';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from './engine.service';
import { EpisodesController } from './episodes.controller';
import type { FootageAccessService } from './footage-access.service';
import { LlmLogController } from './llm-log.controller';

const PROD = '22222222-2222-4222-8222-222222222222';
const req = (userId: string, isAdmin = false) => ({ authContext: { userId, isAdmin } }) as unknown as Request;

function call(over: Partial<StudioLlmCall> = {}): StudioLlmCall {
  return {
    run_id: 'run-plan', stage_key: 'plan-episodes', attempt_id: 'attempt-1', skill: 'studio-plan-episodes', round: 0,
    outcome: 'accepted', problems: [], warnings: [{ code: 'short', message: 'tập ngắn' }],
    trace: {
      model: 'claude-opus-5-5', prompt: '# Skill\nS\n\n# Brief\nB\n', json_schema: '{}', response: '{}', structured_output: { ok: true },
      exit_code: 0, timed_out: false, rate_limited: false, wall_seconds: 3, cost_usd: 0.1, input_tokens: 10, output_tokens: 5,
    },
    ...over,
  };
}

describe('call log (real studio.db)', () => {
  let s: RealStudio;
  let engine: EngineService;
  let covered: boolean;
  const access = { coversProduction: async () => covered } as unknown as FootageAccessService;

  beforeEach(async () => {
    s = await realStudio();
    engine = { ...s.engine, core: s.engine.core, db: s.engine.db, bucket: new MemoryBucket() } as unknown as EngineService;
    covered = true;
    insertTeam(s.db, 'team-1', 'auth0|owner');
    const now = new Date().toISOString();
    s.db.run(`INSERT INTO productions (id, team_id, title, status, run_id, created_at, updated_at, owner_user_id)
              VALUES (?, 'team-1', 'Phở', 'draft', 'run-plan', ?, ?, 'auth0|owner')`, [PROD, now, now]);
    s.db.run(`INSERT INTO episodes (id, production_id, idx, title, hook, created_at, updated_at)
              VALUES ('ep-1', ?, 1, 'Tập 1', 'Mở đầu', ?, ?)`, [PROD, now, now]);
  });
  afterEach(() => s.close());

  it('lists the calls of a production and shows one with its prompt and answer', async () => {
    const id = await recordLlmCall(engine.db, engine.bucket, call());
    await recordLlmCall(engine.db, engine.bucket, call({ round: 1, outcome: 'rejected', problems: [{ code: 'unknown_asset', message: 'a99' }] }));
    const ctl = new LlmLogController(engine, access);
    const list = await ctl.list(PROD, req('auth0|owner'));
    expect(list.total).toBe(2);
    expect(list.items.map((c) => c.outcome).sort()).toEqual(['accepted', 'rejected']);
    expect(list.items.find((c) => c.outcome === 'rejected')!.problems).toEqual([{ code: 'unknown_asset', message: 'a99' }]);
    const one = await ctl.detail(PROD, id, req('auth0|owner'));
    expect(one).toMatchObject({ id, prompt: '# Skill\nS\n\n# Brief\nB\n', structuredOutput: { ok: true }, warnings: [{ code: 'short', message: 'tập ngắn' }] });
  });

  it('keeps the log from someone whose footage scope does not cover the production, unless admin', async () => {
    covered = false;
    const ctl = new LlmLogController(engine, access);
    await expect(ctl.list(PROD, req('auth0|other'))).rejects.toBeInstanceOf(ForbiddenException);
    expect((await ctl.list(PROD, req('auth0|admin', true))).total).toBe(0);
  });

  it('records the title and thumbnail a person picks as a YouTube kit edit', async () => {
    const ctl = new EpisodesController(engine, access);
    await ctl.patch(PROD, 'ep-1', { selectedTitle: 2, selectedThumbnail: 1 }, req('auth0|owner'));
    const edits = listHumanEdits(engine.db, { productionId: PROD, page: 1, pageSize: 20 }).items;
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ kind: 'youtube_kit', episode_id: 'ep-1', user_id: 'auth0|owner', changed: 1 });
    expect(JSON.parse(edits[0]!.after!)).toMatchObject({ selectedTitle: 2, selectedThumbnail: 1 });
  });
});
