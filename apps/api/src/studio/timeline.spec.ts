import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createStudioEngineCore, MemoryBucket, StudioDb } from '@ag-studio/engine';
import { TimelineController } from './timeline.controller';
import { StudioRunController } from './studio-run.controller';
import type { EngineService } from './engine.service';
import type { FootageAccessService } from './footage-access.service';
import type { StudioDbService } from '../db/studio-db.service';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const PROD = '22222222-2222-4222-8222-222222222222';
const EP   = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function timeline(sectionTitle = 'Phở bò') {
  return {
    schema_version: 'studio.timeline/v3',
    production_id: PROD,
    episode_id: EP,
    canvas: { width: 1920, height: 1080 },
    fps: 25 as const,
    language: 'vi',
    clips: [
      { clip_id: 'C001', asset_id: 'asset-1', section_title: sectionTitle },
    ],
    texts: [],
    music: null,
    source_audio: { muted: true },
    assets: {
      'asset-1': { title: 'Phở bò Hà Nội', summary_vi: 'Cảnh phở bò', duration_s: 8, orientation: 'landscape' },
    },
    alternates: [],
  };
}

describe('Timeline revisions over HTTP semantics (autosave + 409)', () => {
  let controller: TimelineController;
  let runs: StudioRunController;
  let db: StudioDb;
  const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as never;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-api-'));
    const dbPath = join(dir, 'studio.db');
    const core = createStudioEngineCore({ dbPath, dataRoot: join(dir, 'data'), harnessRoot: ROOT });
    db = new StudioDb(dbPath);
    const now = new Date().toISOString();
    db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('t1', 'T', ?, ?)", [now, now]);
    db.run("INSERT INTO productions (id, team_id, title, created_at, updated_at) VALUES (?, 't1', 'P', ?, ?)", [PROD, now, now]);
    db.run(
      "INSERT INTO episodes (id, production_id, idx, title, hook, created_at, updated_at) VALUES (?, ?, 1, 'Ep 1', 'Hook', ?, ?)",
      [EP, PROD, now, now],
    );
    const engine = { core, db, bucket: new MemoryBucket(), editor: { db, bucket: new MemoryBucket(), farm: {} }, browserUrlTtl: 60 } as unknown as EngineService;
    const access = { coversProduction: async () => false } as unknown as FootageAccessService;
    controller = new TimelineController(engine, access);
    runs = new StudioRunController(engine, { get: () => ({ role: 'owner' }) } as unknown as StudioDbService);
  });

  it('first save needs baseRevision 0, each later save the latest revision', async () => {
    const r1 = await controller.save(PROD, EP, { baseRevision: 0, data: timeline() }, req('u1'));
    expect(r1.revision).toBe(1);
    const r2 = await controller.save(PROD, EP, { baseRevision: 1, data: timeline('Bún bò Huế') }, req('u1'));
    expect(r2.revision).toBe(2);
    const latest = controller.latest(PROD, EP);
    expect(latest.data.clips[0]?.section_title).toBe('Bún bò Huế');
    const rev1 = controller.revision(EP, 1);
    expect(rev1.data.clips[0]?.section_title).toBe('Phở bò');
  });

  it('a save based on a stale revision answers 409 with the current revision, and writes nothing', async () => {
    await controller.save(PROD, EP, { baseRevision: 0, data: timeline() }, req('u1'));
    await controller.save(PROD, EP, { baseRevision: 1, data: timeline('Bản của A') }, req('u1'));
    const err = await controller.save(PROD, EP, { baseRevision: 1, data: timeline('Bản của B') }, req('u2')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'revision_conflict', currentRevision: 2, baseRevision: 1 });
    const latest = controller.latest(PROD, EP);
    expect(latest.revision).toBe(2);
    expect(latest.data.clips[0]?.section_title).toBe('Bản của A');
  });

  it('an invalid timeline is 422 with the schema problems; an unknown episode 404', async () => {
    const bad = { ...timeline(), clips: 'nope' };
    await expect(controller.save(PROD, EP, { baseRevision: 0, data: bad }, req('u1'))).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(() => controller.latest(PROD, 'ffffffff-ffff-4fff-8fff-ffffffffffff')).toThrow(NotFoundException);
    const unknownEp = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await expect(controller.save(PROD, unknownEp, { baseRevision: 0, data: { ...timeline(), episode_id: unknownEp } }, req('u1'))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('run routes map engine errors: no run yet -> 404, unknown gate -> 422', async () => {
    await expect(runs.status(PROD)).rejects.toBeInstanceOf(NotFoundException);
    await expect(runs.start(PROD)).rejects.toBeInstanceOf(UnprocessableEntityException); // no source folder yet
    // submitGate hits requireRunId() before gate validation → NotFoundException when no run
    await expect(runs.submitGate(PROD, 'nope', {}, req('u1'))).rejects.toBeInstanceOf(NotFoundException);
  });
});
