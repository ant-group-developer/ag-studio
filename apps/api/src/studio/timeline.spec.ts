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

function timeline(text = 'Xin chào') {
  return {
    schema_version: 'studio.timeline/v2', production_id: PROD, canvas: { width: 1280, height: 720 }, fps: 25, language: 'vi',
    beats: [{ beat_id: 'B01', title: 'Mở' }],
    clips: [{ clip_id: 'C001', beat_id: 'B01', segment_id: 'seg-1', src_in: 0, src_out: 4 }],
    narration: [{ line_id: 'L001', beat_id: 'B01', text, audio: { key: `audio/${'a'.repeat(64)}.wav`, duration: 2 } }],
    texts: [], music: null, source_audio: { muted: true }, captions: { enabled: true },
    segments: { 'seg-1': { asset_id: 'a1', start_ms: 0, end_ms: 8000, caption: 'phở', orientation: 'landscape' } },
    alternates: { B01: [] },
  };
}

describe('Timeline revisions over HTTP semantics (autosave + 409)', () => {
  let controller: TimelineController;
  let runs: StudioRunController;
  const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as never;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-api-'));
    const dbPath = join(dir, 'studio.db');
    const core = createStudioEngineCore({ dbPath, dataRoot: join(dir, 'data'), harnessRoot: ROOT });
    const db = new StudioDb(dbPath);
    const now = new Date().toISOString();
    db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('t1', 'T', ?, ?)", [now, now]);
    db.run("INSERT INTO productions (id, team_id, title, created_at, updated_at) VALUES (?, 't1', 'P', ?, ?)", [PROD, now, now]);
    const engine = { core, db, bucket: new MemoryBucket(), editor: { db, bucket: new MemoryBucket(), farm: {} }, browserUrlTtl: 60 } as unknown as EngineService;
    const access = { coversProduction: async () => false } as unknown as FootageAccessService;
    controller = new TimelineController(engine, access);
    runs = new StudioRunController(engine, { get: () => ({ role: 'owner' }) } as unknown as StudioDbService);
  });

  it('first save needs baseRevision 0, each later save the latest revision', async () => {
    const r1 = await controller.save(PROD, { baseRevision: 0, data: timeline() }, req('u1'));
    expect(r1.revision).toBe(1);
    const r2 = await controller.save(PROD, { baseRevision: 1, data: timeline('Chào buổi sáng') }, req('u1'));
    expect(r2.revision).toBe(2);
    expect(controller.latest(PROD).data.narration[0]!.text).toBe('Chào buổi sáng');
    expect(controller.revision(PROD, 1).data.narration[0]!.text).toBe('Xin chào');
  });

  it('a save based on a stale revision answers 409 with the current revision, and writes nothing', async () => {
    await controller.save(PROD, { baseRevision: 0, data: timeline() }, req('u1'));
    await controller.save(PROD, { baseRevision: 1, data: timeline('Bản của A') }, req('u1'));
    const err = await controller.save(PROD, { baseRevision: 1, data: timeline('Bản của B') }, req('u2')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'revision_conflict', currentRevision: 2, baseRevision: 1 });
    expect(controller.latest(PROD).revision).toBe(2);
    expect(controller.latest(PROD).data.narration[0]!.text).toBe('Bản của A');
  });

  it('an invalid timeline is 422 with the schema problems; an unknown production 404', async () => {
    const bad = { ...timeline(), clips: 'nope' };
    await expect(controller.save(PROD, { baseRevision: 0, data: bad }, req('u1'))).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(() => controller.latest(PROD)).toThrow(NotFoundException);
    await expect(controller.save('33333333-3333-4333-8333-333333333333', { baseRevision: 0, data: timeline() }, req('u1'))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('run routes map engine errors: no run yet -> 404, unknown gate -> 422', async () => {
    await expect(runs.status(PROD)).rejects.toBeInstanceOf(NotFoundException);
    await expect(runs.start(PROD)).rejects.toBeInstanceOf(UnprocessableEntityException); // no source folder yet
    await expect(runs.submitGate(PROD, 'nope', {}, req('u1'))).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
