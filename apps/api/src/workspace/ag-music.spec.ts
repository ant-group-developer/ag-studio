/**
 * Music from ag-music-v2 into someone's media library (2026-11-01) over a real database: every call to ag-music goes
 * with the person's own token, the list asks only approved tracks and marks the ones already fetched, the main audio is
 * copied to the bucket under the person once (picked again or twice at once: the same item, one download counted, and
 * only once the copy is in the library), and ag-music's refusals read as Studio's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { addMediaToProject, createProject, MemoryBucket } from '@ag-studio/engine';
import { realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import { AgMusicController } from './ag-music.controller';
import { AgMusicService } from './ag-music.service';
import { MediaController } from './media.controller';
import { MediaLibraryService } from './media-library.service';
import { WorkspaceModule } from './workspace.module';

const API = 'https://music.test/api/v1';
const FILE_URL = 'https://storage.test/ag-music/track-7.mp3?sig=1';
const EDITOR = 'auth0|editor';
const req = (userId: string, accessToken = 'tok-editor') => ({ authContext: { userId, accessToken } }) as unknown as Request;
const code = (e: unknown) => (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? String(e);
const status = (e: unknown) => (e as { getStatus?: () => number }).getStatus?.();
const json = (body: unknown, httpStatus = 200) => new Response(JSON.stringify(body), { status: httpStatus, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown) => json({ success: true, data, error: null, timestamp: 't' });
const fail = (httpStatus: number, errorCode: string) => json({ success: false, data: null, error: { code: errorCode, detail: 'từ ag-music' }, timestamp: 't' }, httpStatus);

const TRACK = {
  id: 7, type: 'SONG', name: 'Mưa chiều', code: 'S-7', bpm: 92, durationMs: 185_000, thumbnailUrl: null,
  categories: [{ id: 1, kind: 'GENRE', name: 'Lofi' }], artists: [{ id: 3, name: 'Hà An' }],
  instrumental: true, peaks: [0.1, 0.8, 0.4], downloadCount: 12,
};
const DETAIL = {
  id: 7, bpm: 92, artists: [{ id: 3, name: 'Hà An' }],
  categories: [{ id: 1, kind: 'GENRE', name: 'Lofi' }, { id: 5, kind: 'THEME', name: 'Mưa' }, { id: 9, kind: 'MOOD', name: 'Chill' }],
};
const DESCRIBED = { artists: ['Hà An'], categories: [{ kind: 'GENRE', name: 'Lofi' }, { kind: 'THEME', name: 'Mưa' }, { kind: 'MOOD', name: 'Chill' }], bpm: 92 };
const EXPORT = {
  trackId: 7, code: 'S-7', type: 'SONG', name: 'Mưa chiều', artists: [{ id: 3, name: 'Hà An' }], origin: 'ORIGINAL', copyrightStatus: 'CLEAN',
  fileId: 70, fileName: 'Mưa chiều.mp3', contentType: 'audio/mpeg', sizeBytes: 5, durationMs: 185_000, url: FILE_URL, expiresAt: '2026-11-01T10:00:00Z',
};

describe('ag-music into the media library (real database)', () => {
  let s: RealStudio;
  let bucket: MemoryBucket;
  let picker: AgMusicController;
  let library: MediaController;
  let calls: { method: string; url: string; auth: string | undefined }[];
  let answer: (method: string, url: URL) => Response;

  function build(agMusicUrl: string | undefined) {
    const engine = s.engine as unknown as EngineService;
    const media = new MediaLibraryService(engine);
    const config = { get: (k: string) => (k === 'AG_MUSIC_API_URL' ? agMusicUrl : undefined) } as unknown as ConfigService;
    const agMusic = new AgMusicService(config, engine, media);
    picker = new AgMusicController(agMusic, media);
    library = new MediaController(engine, media, agMusic);
  }

  beforeEach(async () => {
    s = await realStudio();
    bucket = new MemoryBucket();
    Object.assign(s.engine, { bucket });
    calls = [];
    answer = (method, url) => {
      if (url.href === FILE_URL) return new Response(Buffer.from('audio'), { status: 200, headers: { 'content-length': '5' } });
      if (method === 'GET' && url.pathname === '/api/v1/tracks') return ok({ items: [TRACK], page: 0, size: 20, totalElements: 1, totalPages: 1 });
      if (method === 'GET' && url.pathname === '/api/v1/tracks/7') return ok(DETAIL);
      if (method === 'GET' && url.pathname === '/api/v1/tracks/7/playback') return ok({ trackId: 7, audioUrl: 'https://storage.test/listen', expiresAt: 'x', durationMs: 1 });
      if (method === 'POST' && url.pathname === '/api/v1/tracks/7/export') return ok(EXPORT);
      if (method === 'POST' && url.pathname === '/api/v1/tracks/7/export/confirm') return ok({ counted: true });
      return fail(404, 'NotFound');
    };
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method: init?.method ?? 'GET', url: input, auth: headers.Authorization });
      return answer(init?.method ?? 'GET', new URL(input));
    });
    build(`${API}/`);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await s.close();
  });

  it('is wired into the API (the route exists, so the web shows the picker)', () => {
    expect(Reflect.getMetadata('controllers', WorkspaceModule)).toContain(AgMusicController);
    expect(Reflect.getMetadata('providers', WorkspaceModule)).toContain(AgMusicService);
  });

  it('is off without AG_MUSIC_API_URL', async () => {
    build(undefined);
    expect(picker.status()).toEqual({ enabled: false });
    expect(await picker.tracks({}, req(EDITOR)).catch(code)).toBe('ag_music_disabled');
    expect(calls).toEqual([]);
  });

  it('lists approved tracks as the person, by name and type, and marks the ones already in their library', async () => {
    expect(picker.status()).toEqual({ enabled: true });
    const first = await picker.tracks({ q: 'mưa', type: 'SONG', page: '1', size: '10' }, req(EDITOR));
    expect(first).toEqual({
      items: [{ trackId: 7, code: 'S-7', type: 'SONG', name: 'Mưa chiều', artists: ['Hà An'], categories: ['Lofi'], durationMs: 185_000, bpm: 92, thumbnailUrl: null, mediaId: null,
        instrumental: true, peaks: [0.1, 0.8, 0.4], downloadCount: 12 }],
      total: 1, page: 0, size: 20,
    });
    const u = new URL(calls[0]!.url);
    expect(calls[0]!.auth).toBe('Bearer tok-editor');
    expect(Object.fromEntries(u.searchParams)).toEqual({ approved: 'true', sort: 'NEWEST', page: '1', size: '10', keyword: 'mưa', types: 'SONG' });
    expect(await Promise.resolve().then(() => picker.tracks({ type: 'BAD' }, req(EDITOR))).catch(code)).toBe('invalid');

    // the filters of ag-music's sidebar and the order go along
    await picker.tracks({ type: 'ASSET', categoryIds: '1,4', instrumental: 'false', purposes: 'SHORT,ASMR', bpmFrom: '80', sort: 'MOST_DOWNLOADED' }, req(EDITOR));
    expect(Object.fromEntries(new URL(calls.at(-1)!.url).searchParams)).toEqual({
      approved: 'true', types: 'ASSET', categoryIds: '1,4', instrumental: 'false', purposes: 'SHORT,ASMR', bpmFrom: '80',
      sort: 'MOST_DOWNLOADED', page: '0', size: '20',
    });
    expect(await Promise.resolve().then(() => picker.tracks({ categoryIds: '1,x' }, req(EDITOR))).catch(code)).toBe('invalid');
    expect(await Promise.resolve().then(() => picker.tracks({ origins: 'drop table' }, req(EDITOR))).catch(code)).toBe('invalid');

    const item = await picker.fetch({ trackId: 7 }, req(EDITOR));
    expect((await picker.tracks({}, req(EDITOR))).items[0]!.mediaId).toBe(item.id);
    // someone else has not fetched it
    expect((await picker.tracks({}, req('auth0|other', 'tok-other'))).items[0]!.mediaId).toBeNull();
  });

  it('asks ag-music the counts of the filter sidebar on the same filters, approved tracks only', async () => {
    const facets = { categories: { GENRE: [{ id: 1, name: 'Lofi', count: 3 }] }, artists: [], instrumental: { true: 3 }, voiceGenders: {}, releaseStatuses: {}, origins: {}, purposes: {} };
    answer = (method, url) => (url.pathname === '/api/v1/tracks/facets' ? ok(facets) : fail(404, 'NotFound'));
    expect(await picker.facets({ q: 'mưa', type: 'SONG', artistIds: '3' }, req(EDITOR))).toEqual(facets);
    expect(calls.at(-1)!.auth).toBe('Bearer tok-editor');
    expect(Object.fromEntries(new URL(calls.at(-1)!.url).searchParams)).toEqual({ approved: 'true', keyword: 'mưa', types: 'SONG', artistIds: '3' });
  });

  it('describes in the library a track copied before its genre, theme... were kept, once', async () => {
    const plain = answer;
    // ag-music did not describe it at copy time
    answer = (method, url) => (url.pathname === '/api/v1/tracks/7' ? fail(503, 'Down') : plain(method, url));
    const item = await picker.fetch({ trackId: 7 }, req(EDITOR));
    expect(item.origin).not.toHaveProperty('categories');
    answer = plain;
    calls.length = 0;
    const listed = await library.list({ kind: 'audio' }, req(EDITOR));
    expect(listed.items[0]!.origin).toMatchObject(DESCRIBED);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}/tracks/7`]);
    calls.length = 0;
    expect((await library.list({ kind: 'audio' }, req(EDITOR))).items[0]!.origin).toMatchObject(DESCRIBED);
    expect(calls).toEqual([]);
  });

  it('copies the main audio under the person once, remembering the track; picked again it is the same item', async () => {
    const item = await picker.fetch({ trackId: 7 }, req(EDITOR));
    expect(item).toMatchObject({
      kind: 'audio', name: 'Mưa chiều.mp3', bytes: 5, usedIn: [],
      origin: { system: 'ag-music', trackId: 7, fileId: 70, code: 'S-7', type: 'SONG', origin: 'ORIGINAL', copyrightStatus: 'CLEAN', ...DESCRIBED },
      previewUrl: expect.stringContaining('memory://library/studio/users/auth0_editor-'),
    });
    // the download is counted after the copy is in the library
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${API}/tracks/7/export`, `GET ${API}/tracks/7`, `GET ${FILE_URL}`, `POST ${API}/tracks/7/export/confirm`]);
    expect(calls[0]!.auth).toBe('Bearer tok-editor');
    expect(calls[3]!.auth).toBe('Bearer tok-editor');

    calls.length = 0;
    expect((await picker.fetch({ trackId: 7 }, req(EDITOR))).id).toBe(item.id);
    expect(calls).toEqual([]);
    const listed = await library.list({ kind: 'audio' }, req(EDITOR));
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.origin).toMatchObject({ system: 'ag-music', trackId: 7 });
  });

  it('copies once when the same track is picked twice at once', async () => {
    const [a, b] = await Promise.all([picker.fetch({ trackId: 7 }, req(EDITOR)), picker.fetch({ trackId: 7 }, req(EDITOR))]);
    expect(a.id).toBe(b.id);
    expect(calls.filter((c) => c.url.endsWith('/tracks/7/export'))).toHaveLength(1);
    expect((await library.list({ kind: 'audio' }, req(EDITOR))).total).toBe(1);
  });

  it('keeps the copy when ag-music fails to count the download', async () => {
    const base = answer;
    answer = (method, url) => (url.pathname.endsWith('/export/confirm') ? fail(503, 'Unavailable') : base(method, url));
    const item = await picker.fetch({ trackId: 7 }, req(EDITOR));
    expect(item).toMatchObject({ kind: 'audio', origin: { trackId: 7 } });
    expect((await library.list({ kind: 'audio' }, req(EDITOR))).total).toBe(1);
  });

  it('before a final render, refuses ag-music tracks of the project that were removed, unapproved or a violation', async () => {
    const db = s.engine.db as unknown as Parameters<typeof createProject>[0];
    const now = new Date().toISOString();
    await db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [now, now]);
    const project = await createProject(db, 'team-1', { name: 'Hoa Lư', description: '', language: 'vi', aspect: '16:9' }, EDITOR, now);
    const service = new AgMusicService({ get: () => `${API}/` } as unknown as ConfigService, s.engine as unknown as EngineService, new MediaLibraryService(s.engine as unknown as EngineService));
    // nothing from ag-music in the project: ag-music is not asked
    await service.requireUsableInProject(project.id, 'tok-editor');
    expect(calls).toEqual([]);

    const item = await picker.fetch({ trackId: 7 }, req(EDITOR));
    await addMediaToProject(db, { projectId: project.id, ownerId: EDITOR, mediaIds: [item.id], use: 'audio' });
    let reason: string | null = null;
    const base = answer;
    answer = (method, url) => (url.pathname.endsWith('/tracks/export-status')
      ? ok([{ trackId: 7, usable: reason === null, reason, copyrightStatus: 'CLEAN' }]) : base(method, url));

    await service.requireUsableInProject(project.id, 'tok-editor');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `${API}/tracks/export-status`, auth: 'Bearer tok-editor' });
    // the person cannot see it on ag-music (someone else picked it): not refused
    reason = 'NOT_FOUND';
    await service.requireUsableInProject(project.id, 'tok-other');
    for (const r of ['DELETED', 'NOT_APPROVED', 'COPYRIGHT_VIOLATION']) {
      reason = r;
      const refused = await service.requireUsableInProject(project.id, 'tok-editor').catch((e: unknown) => e);
      expect([code(refused), status(refused)]).toEqual(['ag_music_track_unusable', 422]);
    }
    // ag-music down does not stop renders
    answer = () => { throw new TypeError('fetch failed'); };
    await service.requireUsableInProject(project.id, 'tok-editor');
  });

  it('gives a link to listen before picking', async () => {
    expect(await picker.listen(7, req(EDITOR))).toEqual({ url: 'https://storage.test/listen', expiresAt: 'x' });
  });

  it("reads ag-music's refusals as Studio's and keeps nothing of a failed copy", async () => {
    answer = () => fail(403, 'Forbidden');
    const forbidden = await picker.tracks({}, req(EDITOR)).catch((e: unknown) => e);
    expect([code(forbidden), status(forbidden)]).toEqual(['ag_music_forbidden', 403]);

    answer = () => fail(400, 'TrackNotApproved');
    const refused = await picker.fetch({ trackId: 7 }, req(EDITOR)).catch((e: unknown) => e);
    expect([code(refused), status(refused)]).toEqual(['track_not_approved', 422]);

    answer = () => fail(400, 'TrackCopyrightViolation');
    const violation = await picker.fetch({ trackId: 7 }, req(EDITOR)).catch((e: unknown) => e);
    expect([code(violation), status(violation)]).toEqual(['track_copyright_violation', 422]);

    // ag-music not taking Studio's tokens is a setup fault, not the person's access
    answer = () => fail(401, 'Unauthorized');
    const unauthorized = await picker.tracks({}, req(EDITOR)).catch((e: unknown) => e);
    expect([code(unauthorized), status(unauthorized)]).toEqual(['ag_music_unauthorized', 502]);

    answer = () => fail(404, 'NotFound');
    expect(await picker.listen(9, req(EDITOR)).catch(code)).toBe('ag_music_not_found');

    answer = () => { throw new TypeError('fetch failed'); };
    const down = await picker.tracks({}, req(EDITOR)).catch((e: unknown) => e);
    expect([code(down), status(down)]).toEqual(['ag_music_unavailable', 502]);

    // a track larger than the library takes is refused before the download
    answer = (_m, url) => (url.href === FILE_URL ? new Response('x') : ok({ ...EXPORT, sizeBytes: 400 * 1024 ** 2 }));
    calls.length = 0;
    expect(await picker.fetch({ trackId: 7 }, req(EDITOR)).catch(code)).toBe('file_too_large');
    expect(calls.map((c) => c.url)).toEqual([`${API}/tracks/7/export`]);

    // the file link failing: no item, nothing on the bucket
    answer = (_m, url) => (url.href === FILE_URL ? new Response('gone', { status: 403 }) : ok(EXPORT));
    expect(await picker.fetch({ trackId: 7 }, req(EDITOR)).catch(code)).toBe('ag_music_unavailable');
    expect((await library.list({}, req(EDITOR))).total).toBe(0);
    expect(await bucket.list('library/')).toEqual([]);
  });
});
