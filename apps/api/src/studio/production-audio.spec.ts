/**
 * Audio a person gives a production over a real studio.db with an in-memory bucket: a voice needs its origin and the
 * person's word, a link inside the network is refused, declining narration is kept, every change is in the dataset,
 * and 503 when the box has no ffmpeg. The ffmpeg path (a real file checked and kept) needs FFMPEG_PATH/FFPROBE_PATH.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { getProduction, listHumanEdits, MemoryBucket } from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from './engine.service';
import { ProductionAudioController } from './production-audio.controller';

const PROD = '66666666-6666-4666-8666-666666666666';
const req = (userId = 'auth0|editor') => ({ authContext: { userId, isAdmin: false } }) as unknown as Request;
const FFMPEG = process.env.FFMPEG_PATH;
const FFPROBE = process.env.FFPROBE_PATH;
const hasTools = !!FFMPEG && !!FFPROBE && spawnSync(FFMPEG, ['-version']).status === 0;

describe('ProductionAudioController (real studio.db)', () => {
  let s: RealStudio;
  let bucket: MemoryBucket;

  const farm = { submitted: [] as unknown[], async submitJob(j: unknown) { this.submitted.push(j); return { job: { id: 'job-1' }, created: true }; },
    async getJob() { return { status: 'queued', error: null }; }, async ackJob() { return {}; } };
  function controller(env: Record<string, unknown>) {
    const engine = Object.assign(s.engine, { bucket, browserUrlTtl: 60, editor: { db: s.engine.db, bucket, farm } });
    const config = { get: (k: string) => env[k] } as unknown as ConfigService;
    return new ProductionAudioController(engine as unknown as EngineService, config);
  }
  // the refusals come before ffmpeg runs: any path will do when the box has none
  const tools = () => ({ STUDIO_FFMPEG_PATH: FFMPEG ?? 'ffmpeg', STUDIO_FFPROBE_PATH: FFPROBE ?? 'ffprobe' });
  const code = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return { type: (e as Error).constructor.name, code: ((e as { getResponse?: () => { code?: string } }).getResponse?.() ?? {}).code }; }
    return null;
  };

  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    const now = new Date().toISOString();
    s.db.run(`INSERT INTO productions (id, team_id, title, status, created_at, updated_at, owner_user_id, aspect)
              VALUES (?, 'team-1', 'Ninh Bình', 'draft', ?, ?, 'auth0|owner', '16:9')`, [PROD, now, now]);
    bucket = new MemoryBucket();
  });
  afterEach(() => s.close());

  it('a production starts with no voice and no music', async () => {
    expect(await controller({}).get(PROD)).toEqual({ voice: null, music: null });
    await expect(controller({}).get('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a voice needs its origin and the person vouching for it', async () => {
    const ctl = controller(tools());
    expect(await code(ctl.give(PROD, 'voice', { url: 'https://a.b/v.wav' }, undefined, req()))).toEqual({ type: 'BadRequestException', code: 'voice_consent' });
    expect(await code(ctl.give(PROD, 'voice', { url: 'https://a.b/v.wav', origin: 'own', confirm: 'false' }, undefined, req()))).toEqual({ type: 'BadRequestException', code: 'voice_consent' });
    expect(await code(ctl.give(PROD, 'voice', { origin: 'own', confirm: true }, undefined, req()))).toEqual({ type: 'BadRequestException', code: 'audio_missing' });
    expect(await code(ctl.give(PROD, 'speech', {}, undefined, req()))).toEqual({ type: 'NotFoundException', code: 'not_found' });
    expect(getProduction(s.engine.db, PROD)!.voice).toBeNull();
  });

  it('a link inside the network is refused, and nothing changes', async () => {
    const ctl = controller(tools());
    expect(await code(ctl.give(PROD, 'music', { url: 'http://127.0.0.1:9/x.mp3' }, undefined, req()))).toEqual({ type: 'BadRequestException', code: 'url_not_allowed' });
    expect(await code(ctl.give(PROD, 'music', { url: 'file:///c:/x.mp3' }, undefined, req()))).toEqual({ type: 'BadRequestException', code: 'url_not_allowed' });
    expect(getProduction(s.engine.db, PROD)!.music).toBeNull();
  });

  it('no ffmpeg on the box: 503', async () => {
    await expect(controller({}).give(PROD, 'music', { url: 'https://a.b/x.mp3' }, undefined, req())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('a machine voice: the farm is asked to read a sample in it, and the voice says it is being made', async () => {
    const ctl = controller(tools());
    expect(await code(ctl.design(PROD, { gender: 'female', age: 'teen', pitch: 'low pitch' }, req()))).toEqual({ type: 'UnprocessableEntityException', code: 'voice_design_invalid' });
    const out = await ctl.design(PROD, { gender: 'female', age: 'young adult', pitch: 'low pitch' }, req());
    expect(out.voice).toMatchObject({ mode: 'designing', instruct: 'female, young adult, low pitch', error: null });
    expect(farm.submitted).toHaveLength(1);
    expect(listHumanEdits(s.engine.db, { productionId: PROD, page: 1, pageSize: 10 }).items.map((x) => x.kind)).toEqual(['voice']);
    // still being read: reading the audio again says so
    expect((await ctl.get(PROD)).voice).toMatchObject({ mode: 'designing' });
    await expect(controller({}).design(PROD, { gender: 'male', age: 'elderly', pitch: 'high pitch' }, req())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('declining narration is kept and in the dataset; removing the voice asks again', async () => {
    const ctl = controller({});
    const out = await ctl.decline(PROD, req());
    expect(out).toMatchObject({ voice: { mode: 'none' }, resumedEpisodes: [] });
    expect(listHumanEdits(s.engine.db, { productionId: PROD, page: 1, pageSize: 10 }).items.map((x) => x.kind)).toEqual(['voice']);
    expect(await ctl.remove(PROD, 'voice', req())).toEqual({ voice: null, music: null });
  });

  it.skipIf(!hasTools)('an uploaded voice is checked, kept by content and played back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audio-spec-'));
    const wav = join(dir, 'giong.wav');
    spawnSync(FFMPEG!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', wav]);
    const ctl = controller(tools());
    const out = await ctl.give(PROD, 'voice', { origin: 'synthetic', confirm: 'true', referenceText: 'Xin chào.' },
      { path: wav, originalname: 'giong.wav', size: 1000 }, req());
    expect(out.voice).toMatchObject({ mode: 'clone', origin: 'synthetic', source: { kind: 'upload', filename: 'giong.wav' }, reference_text: 'Xin chào.' });
    expect((out.voice as { listenUrl: string }).listenUrl).toMatch(/library\/studio\//);
    expect([...bucket.objects.keys()].some((k) => k.startsWith(`library/studio/${PROD}/voice/`))).toBe(true);
  });

  it.skipIf(!hasTools)('a file that is not audio is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audio-spec-'));
    writeFileSync(join(dir, 'x.mp3'), 'not audio');
    const ctl = controller(tools());
    expect(await code(ctl.give(PROD, 'music', {}, { path: join(dir, 'x.mp3'), originalname: 'x.mp3', size: 9 }, req())))
      .toEqual({ type: 'UnprocessableEntityException', code: 'audio_invalid' });
  });
});

