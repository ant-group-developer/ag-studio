/**
 * The team's music library over a real studio.db with an in-memory bucket: everyone lists the active tracks with a
 * URL to listen to, only a Studio admin adds, retags or retires one, and a bad form is refused before ffmpeg runs. The
 * upload itself (a real file made AAC) needs FFMPEG_PATH/FFPROBE_PATH.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { listLibraryMusic, MemoryBucket, saveLibraryMusic } from '@ag-studio/engine';
import type { AccountApiService } from '../auth/account-api.service';
import { realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from './engine.service';
import { MusicLibraryController } from './music-library.controller';

const FFMPEG = process.env.FFMPEG_PATH;
const FFPROBE = process.env.FFPROBE_PATH;
const hasTools = !!FFMPEG && !!FFPROBE && spawnSync(FFMPEG, ['-version']).status === 0;
const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const ADMIN = 'auth0|admin';
const accounts = { getUserProfile: async (_t: string, id: string) => ({ userType: id === ADMIN ? 'ADMIN' : 'USER' }) } as unknown as AccountApiService;

const track = (id: string, mood: string[], active = true) => ({
  schema_version: 'harness.music-track/v1' as const, track_id: id, display_name: id, file: `library:music/${id}.m4a`, mood, duration_seconds: 120,
  loop_ok: false, origin: 'own' as const, origin_note: 'nhóm', checksum: `sha256:${'a'.repeat(64)}`, active,
  created_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T00:00:00.000Z',
});

describe('MusicLibraryController (real studio.db)', () => {
  let s: RealStudio;
  let bucket: MemoryBucket;
  const controller = (env: Record<string, unknown> = {}) => {
    const engine = Object.assign(s.engine, { bucket, browserUrlTtl: 60 });
    return new MusicLibraryController(engine as unknown as EngineService, accounts, { get: (k: string) => env[k] } as unknown as ConfigService);
  };
  const failure = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return { type: (e as Error).constructor.name, code: ((e as { getResponse?: () => { code?: string } }).getResponse?.() ?? {}).code }; }
    return null;
  };

  beforeEach(async () => {
    s = await realStudio();
    bucket = new MemoryBucket();
  });
  afterEach(() => s.close());

  it('everyone lists the active tracks with a URL to listen to; an admin sees the retired ones too', async () => {
    saveLibraryMusic(s.engine.db, track('calm', ['calm']));
    saveLibraryMusic(s.engine.db, track('old', ['sad'], false));
    const mine = await controller().list(req('auth0|editor'));
    expect(mine.tracks.map((t) => [t.trackId, t.moods, t.track])).toEqual([['calm', ['calm'], 'library:music/calm.m4a']]);
    expect(mine.tracks[0]!.listenUrl).toContain('library/music/calm.m4a');
    expect((await controller().list(req(ADMIN))).tracks.map((t) => [t.trackId, t.active])).toEqual([['calm', true], ['old', false]]);
  });

  it('only an admin adds or changes a track; a bad form is refused before any file is read', async () => {
    const form = { displayName: 'Sáng', moods: 'calm, ấm áp', origin: 'own', originNote: 'nhóm' };
    expect(await failure(controller().add(form, undefined, req('auth0|editor')))).toEqual({ type: 'ForbiddenException', code: undefined });
    expect(await failure(controller().add({ ...form, origin: 'stolen' }, undefined, req(ADMIN)))).toEqual({ type: 'BadRequestException', code: 'invalid' });
    expect(await failure(controller().add({ ...form, moods: ' , ' }, undefined, req(ADMIN)))).toEqual({ type: 'BadRequestException', code: 'invalid' });
    expect(await failure(controller().add(form, undefined, req(ADMIN)))).toEqual({ type: 'BadRequestException', code: 'audio_missing' });

    saveLibraryMusic(s.engine.db, track('calm', ['calm']));
    expect(await failure(controller().update('calm', { active: false }, req('auth0|editor')))).toEqual({ type: 'ForbiddenException', code: undefined });
    expect(await failure(controller().update('nope', { active: false }, req(ADMIN)))).toEqual({ type: 'NotFoundException', code: 'not_found' });
    const retired = await controller().update('calm', { active: false, moods: ['calm', 'morning'] }, req(ADMIN));
    expect(retired).toMatchObject({ trackId: 'calm', active: false, moods: ['calm', 'morning'] });
    expect(listLibraryMusic(s.engine.db, { activeOnly: true })).toEqual([]);
  });

  it.skipIf(!hasTools)('an admin uploads a file: made AAC, kept under library/music/, listed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'music-up-'));
    const wav = join(dir, 'tone.wav');
    spawnSync(FFMPEG!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100', '-t', '12', wav]);
    const file = { path: wav, originalname: 'tone.wav', size: statSync(wav).size };
    const out = await controller({ STUDIO_FFMPEG_PATH: FFMPEG, STUDIO_FFPROBE_PATH: FFPROBE })
      .add({ displayName: 'Sáng sớm', moods: 'calm,ấm áp', origin: 'royalty_free', originNote: 'Pixabay', loopOk: 'true' }, file, req(ADMIN));
    expect(out).toMatchObject({ displayName: 'Sáng sớm', moods: ['calm', 'ấm áp'], loopOk: true, origin: 'royalty_free', active: true });
    expect(await bucket.exists(`library/${out.track.slice('library:'.length)}`)).not.toBeNull();
    expect((await controller().list(req('auth0|editor'))).tracks.map((t) => t.trackId)).toEqual([out.trackId]);
  }, 60_000);
});
