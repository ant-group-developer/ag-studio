import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createStudioEngineCore, MemoryBucket, StudioDb } from '@ag-studio/engine';
import { TimelineController } from './timeline.controller';
import { StudioRunController } from './studio-run.controller';
import type { EngineService } from './engine.service';
import type { FootageAccessService } from './footage-access.service';
import type { StudioDbService } from '../db/studio-db.service';
import type { AccountApiService, UserProfile } from '../auth/account-api.service';

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
  let bucket: MemoryBucket;
  let submitted: { type: string; payload: Record<string, unknown> }[];
  let profile: UserProfile;
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
    db.run("INSERT INTO productions (id, team_id, title, created_at, updated_at) VALUES ('other-prod', 't1', 'Q', ?, ?)", [now, now]);
    db.run("INSERT INTO episodes (id, production_id, idx, title, hook, created_at, updated_at) VALUES ('other-ep', 'other-prod', 1, 'X', 'h', ?, ?)", [now, now]);
    bucket = new MemoryBucket();
    submitted = [];
    let n = 0;
    const farm = {
      submitJob: async (r: { type: string; payload: Record<string, unknown> }) => { submitted.push(r); return { job: { id: `job-${++n}` }, created: true }; },
      getJob: async () => ({ status: 'running', progress_percent: 42 }),
      ackJob: async () => ({}),
    };
    const engine = { core, db, bucket, editor: { db, bucket, farm, voiceDir: join(dir, 'voice') }, browserUrlTtl: 60 } as unknown as EngineService;
    const access = { coversProduction: async () => false } as unknown as FootageAccessService;
    profile = { userId: 'u1', userType: 'USER', permissions: [] };
    const account = { getUserProfile: async () => profile } as unknown as AccountApiService;
    controller = new TimelineController(engine, access, account);
    runs = new StudioRunController(engine, { get: () => ({ role: 'owner' }) } as unknown as StudioDbService);
  });

  it('first save needs baseRevision 0, each later save the latest revision', async () => {
    const r1 = await controller.save(PROD, EP, { baseRevision: 0, data: timeline() }, req('u1'));
    expect(r1.revision).toBe(1);
    const r2 = await controller.save(PROD, EP, { baseRevision: 1, data: timeline('Bún bò Huế') }, req('u1'));
    expect(r2.revision).toBe(2);
    const latest = await controller.latest(PROD, EP);
    expect(latest.data.clips[0]?.section_title).toBe('Bún bò Huế');
    expect(latest.authorId).toBe('u1');
    const rev1 = await controller.revision(PROD, EP, 1);
    expect(rev1.data.clips[0]?.section_title).toBe('Phở bò');
    expect((await controller.revisions(PROD, EP)).map((r) => [r.revision, r.baseRevision])).toEqual([[2, 1], [1, 0]]);
  });

  it('a save based on a stale revision answers 409 with the current revision, and writes nothing', async () => {
    await controller.save(PROD, EP, { baseRevision: 0, data: timeline() }, req('u1'));
    await controller.save(PROD, EP, { baseRevision: 1, data: timeline('Bản của A') }, req('u1'));
    const err = await controller.save(PROD, EP, { baseRevision: 1, data: timeline('Bản của B') }, req('u2')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'revision_conflict', currentRevision: 2, baseRevision: 1 });
    const latest = await controller.latest(PROD, EP);
    expect(latest.revision).toBe(2);
    expect(latest.data.clips[0]?.section_title).toBe('Bản của A');
  });

  it('an invalid timeline is 422 with the schema problems; an unknown episode 404', async () => {
    const bad = { ...timeline(), clips: 'nope' };
    await expect(controller.save(PROD, EP, { baseRevision: 0, data: bad }, req('u1'))).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(controller.latest(PROD, 'ffffffff-ffff-4fff-8fff-ffffffffffff')).rejects.toBeInstanceOf(NotFoundException);
    const unknownEp = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await expect(controller.save(PROD, unknownEp, { baseRevision: 0, data: { ...timeline(), episode_id: unknownEp } }, req('u1'))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a whole-video (v3) episode keeps v3; a trim it cannot hold is 422 not_v3', async () => {
    await controller.save(PROD, EP, { baseRevision: 0, data: timeline() }, req('u1'));
    const v4 = {
      ...timeline(), schema_version: 'studio.timeline/v4', edit_style: 'whole',
      clips: [{ clip_id: 'C001', asset_id: 'asset-1', section_title: 'Phở bò', in: 0, out: null, shot_id: null, line_id: null, transition_out: { kind: 'cut', seconds: 0 } }],
      narration: { voice: 'none', lead_seconds: 0.3, lines: [] }, captions: { mode: 'none' },
    };
    const same = await controller.save(PROD, EP, { baseRevision: 1, data: v4 }, req('u1'));
    expect((await controller.revision(PROD, EP, same.revision)).data.schema_version).toBe('studio.timeline/v3');

    const trimmed = { ...v4, clips: [{ ...v4.clips[0]!, in: 1, out: 4 }] };
    const err = await controller.save(PROD, EP, { baseRevision: same.revision, data: trimmed }, req('u1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'not_v3' });
  });

  it('a shot-cut timeline with trims and a dissolve exports to Premiere (phase 4)', async () => {
    const now = new Date().toISOString();
    db.run("INSERT INTO episodes (id, production_id, idx, title, hook, edit_style, created_at, updated_at) VALUES ('cut-ep', ?, 2, 'Ep 2', 'h', 'cut', ?, ?)", [PROD, now, now]);
    const cut = {
      ...timeline(), episode_id: 'cut-ep', schema_version: 'studio.timeline/v4', edit_style: 'cut',
      clips: [
        { clip_id: 'C001', asset_id: 'asset-1', section_title: null, in: 1, out: 3.5, shot_id: 's000-000', line_id: null, transition_out: { kind: 'dissolve', seconds: 0.5 } },
        { clip_id: 'C002', asset_id: 'asset-1', section_title: null, in: 4, out: 7, shot_id: 's000-001', line_id: null, transition_out: { kind: 'cut', seconds: 0 } },
      ],
      narration: { voice: 'none', lead_seconds: 0.3, lines: [] }, captions: { mode: 'none' },
    };
    await controller.save(PROD, 'cut-ep', { baseRevision: 0, data: cut }, req('u1'));
    expect((await controller.revision(PROD, 'cut-ep', 1)).data.schema_version).toBe('studio.timeline/v4');
    const job = await controller.premiere(PROD, 'cut-ep', { media: 'proxy' }, req('u1'));
    expect(job.status).toBe('running');
    expect(submitted.map((s) => s.type)).toEqual(['studio.export_premiere']);
    expect(submitted[0]!.payload).toMatchObject({ episode_id: 'cut-ep', composition: 'stage:composition.json', media: 'proxy', name: 'Ep 2' });
  });

  it('a narrated shot-cut timeline whose WAV is not in the voice store is 422 narration_missing, nothing sent', async () => {
    const now = new Date().toISOString();
    db.run("INSERT INTO episodes (id, production_id, idx, title, hook, edit_style, created_at, updated_at) VALUES ('cut-ep', ?, 2, 'Ep 2', 'h', 'cut', ?, ?)", [PROD, now, now]);
    const cut = {
      ...timeline(), episode_id: 'cut-ep', schema_version: 'studio.timeline/v4', edit_style: 'cut',
      clips: [{ clip_id: 'C001', asset_id: 'asset-1', section_title: null, in: 1, out: 5, shot_id: null, line_id: 'L001', transition_out: { kind: 'cut', seconds: 0 } }],
      narration: { voice: 'tts', lead_seconds: 0.3, lines: [{ line_id: 'L001', text: 'Phố cổ.', audio: { key: 'c'.repeat(64), duration_s: 1.2, words: [] } }] },
      captions: { mode: 'none' },
    };
    await controller.save(PROD, 'cut-ep', { baseRevision: 0, data: cut }, req('u1'));
    const err = await controller.premiere(PROD, 'cut-ep', { media: 'proxy' }, req('u1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'narration_missing', line_id: 'L001' });
    expect(submitted).toHaveLength(0);
  });

  it('an episode of another production is 404 through this production (the role guard checked this one)', async () => {
    await expect(controller.latest(PROD, 'other-ep')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.save(PROD, 'other-ep', { baseRevision: 0, data: timeline() }, req('u1'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.premiere(PROD, 'other-ep', { media: 'proxy' }, req('u1'))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('exports a Premiere project of the latest revision; originals need the download right', async () => {
    await controller.save(PROD, EP, { baseRevision: 0, data: timeline() }, req('u1'));
    await expect(controller.premiere(PROD, EP, { media: 'original' }, req('u1'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(submitted).toHaveLength(0);

    const job = await controller.premiere(PROD, EP, { media: 'proxy' }, req('u1'));
    expect(job).toMatchObject({ kind: 'export_premiere', status: 'running', request: { revision: 1, media: 'proxy' } });
    expect(submitted[0]).toMatchObject({ type: 'studio.export_premiere', payload: { production_id: PROD, episode_id: EP, media: 'proxy', composition: 'stage:composition.json', media_names: { 'asset:asset-1': 'Phở bò Hà Nội' } } });
    // a whole-video episode is read by any worker: no edit_style
    expect(submitted[0]!.payload).not.toHaveProperty('edit_style');
    expect([...bucket.objects.keys()].some((k) => k.endsWith(`/editor-premiere/${job.id}/in/composition.json`) || k.includes(job.id))).toBe(true);
    const sign = db.get<{ is_final_render: number; stage_key: string }>('SELECT is_final_render, stage_key FROM studio_farm_jobs WHERE attempt_id = ?', [job.id]);
    expect(sign).toEqual({ is_final_render: 0, stage_key: 'editor-premiere' });

    profile = { userId: 'u1', userType: 'USER', permissions: ['go.project.download_original'] };
    const original = await controller.premiere(PROD, EP, { media: 'original' }, req('u1'));
    expect(db.get<{ is_final_render: number }>('SELECT is_final_render FROM studio_farm_jobs WHERE attempt_id = ?', [original.id])?.is_final_render).toBe(1);
    const listed = await controller.jobs(PROD, EP, 'export_premiere', req('u1'));
    expect(listed.map((j) => [j.id, j.progress])).toEqual([[original.id, 42], [job.id, 42]]);
  });

  it('run routes map engine errors: no run yet -> 404, unknown gate -> 422', async () => {
    await expect(runs.status(PROD)).rejects.toBeInstanceOf(NotFoundException);
    await expect(runs.start(PROD)).rejects.toBeInstanceOf(UnprocessableEntityException); // no source folder yet
    // submitGate hits requireRunId() before gate validation → NotFoundException when no run
    await expect(runs.submitGate(PROD, 'nope', {}, req('u1'))).rejects.toBeInstanceOf(NotFoundException);
  });
});
