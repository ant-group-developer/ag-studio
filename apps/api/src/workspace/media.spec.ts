/**
 * Someone's media library over a real database (plan 2026-10-29 P2): their uploads on the bucket, listed with where
 * each is used, taken into any project (footage into several videos at once) without uploading again, played from the
 * bucket, never deleted while used; and the project's look over every video.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { listJobs, MemoryBucket, saveVideoRevision } from '@ag-studio/engine';
import { insertTeam, NO_DIRECTORY, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import type { SiteNameService } from '../ag-go/site-name.service';
import { FileLinkService, FileStreamController } from './file-links';
import { FilesController } from './files.controller';
import { InputsController } from './inputs.controller';
import { MediaController } from './media.controller';
import { MediaLibraryService } from './media-library.service';
import type { ProjectFootageService } from './project-footage.service';
import { ProjectsController } from './projects.controller';
import { VideoLookController } from './video-look.controller';
import { VideoMediaController } from './video-media.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';

type TimelineV4 = Parameters<typeof saveVideoRevision>[2]['data'];

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const OWNER = 'auth0|owner';
const EDITOR = 'auth0|editor';
const code = (e: unknown) => (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? String(e);
const LINKS = new FileLinkService({ get: () => 's'.repeat(32) } as unknown as ConfigService);

function timeline(videoId: string): TimelineV4 {
  return {
    schema_version: 'studio.timeline/v4', production_id: 'p', episode_id: videoId, canvas: { width: 1920, height: 1080 }, fps: 30, language: 'vi', edit_style: 'cut',
    clips: [{ clip_id: 'C001', asset_id: 'a1', section_title: null, in: 0, out: 4, shot_id: null, line_id: null, transition_out: { kind: 'cut', seconds: 0 } }],
    texts: [], narration: { voice: 'none', lead_seconds: 0.3, lines: [] }, captions: { mode: 'none' }, music: null, source_audio: { muted: false },
    assets: { a1: { title: 'Phố', summary_vi: '…', duration_s: 10, orientation: 'landscape' } }, alternates: [],
  } as TimelineV4;
}

describe('media library (real database)', () => {
  let s: RealStudio;
  let root: string;
  let bucket: MemoryBucket;
  let projects: ProjectsController;
  let videos: VideosController;
  let library: MediaController;
  let inputs: InputsController;
  let files: FilesController;
  let stream: FileStreamController;
  let audio: VideoMediaController;
  let look: VideoLookController;

  beforeEach(async () => {
    s = await realStudio();
    const engine = s.engine as unknown as EngineService;
    root = mkdtempSync(join(tmpdir(), 'media-api-'));
    bucket = new MemoryBucket();
    Object.assign(engine, { bucket });
    const ws = new WorkspaceService({ get: (k: string, d?: unknown) => (k === 'STUDIO_WORKSPACES_ROOT' ? root : d) } as unknown as ConfigService, engine);
    const service = new MediaLibraryService(engine);
    projects = new ProjectsController(engine, ws, NO_DIRECTORY);
    videos = new VideosController(engine, ws);
    library = new MediaController(engine, service);
    inputs = new InputsController(engine, ws, {} as ProjectFootageService, ({ current: () => 'Kho Footage' }) as unknown as SiteNameService, service);
    files = new FilesController(engine, ws, LINKS, service);
    stream = new FileStreamController(engine, ws, LINKS);
    audio = new VideoMediaController(engine, ws, { get: () => undefined } as unknown as ConfigService, LINKS);
    look = new VideoLookController(engine, ws);
    await insertTeam(s.db, 'team-1', OWNER);
    await s.engine.db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', ?, 'editor', ?)", [EDITOR, new Date().toISOString()]);
  });
  afterEach(async () => { await s.close(); });

  /** A file into the person's library the way the browser does it: a signed link, the PUT, then the key. */
  async function put(userId: string, name: string, body = Buffer.from('data')) {
    const link = await library.sign({ name, size: body.length }, req(userId));
    await bucket.put(link.key, body);
    return library.add({ uploadKey: link.key, name }, req(userId));
  }

  it("keeps each person's own library: signed into their folder, listed with previews, renamed, only theirs", async () => {
    expect(await Promise.resolve().then(() => library.sign({ name: 'a.pdf', size: 1 }, req(EDITOR))).catch(code)).toBe('file_type');
    expect(await Promise.resolve().then(() => library.sign({ name: 'a.mp4', size: 400 * 1024 ** 2, use: 'reference' }, req(EDITOR))).catch(code)).toBe('file_too_large');
    const song = await put(EDITOR, 'Sao băng.mp3');
    const clip = await put(EDITOR, 'DJI_0112.mp4', Buffer.from('movie'));
    await put(OWNER, 'của chủ.mp4');
    expect(song).toMatchObject({ kind: 'audio', name: 'Sao băng.mp3', bytes: 4, usedIn: [], previewUrl: expect.stringContaining('memory://library/studio/users/') });
    const all = await library.list({}, req(EDITOR));
    expect(all).toMatchObject({ total: 2, bytes: 9 });
    expect(all.items.map((i) => i.id).sort()).toEqual([song.id, clip.id].sort());
    expect((await library.list({ kind: 'video' }, req(EDITOR))).items.map((i) => i.id)).toEqual([clip.id]);
    expect((await library.list({ q: 'sao' }, req(EDITOR))).items.map((i) => i.id)).toEqual([song.id]);
    expect((await library.rename(song.id, { name: 'Sao băng lofi.mp3' }, req(EDITOR))).name).toBe('Sao băng lofi.mp3');
    expect(await library.rename(song.id, { name: 'x' }, req(OWNER)).catch(code)).toBe('media_not_found');
  });

  it('takes footage from the library into several videos, prepares it once, and sets the videos it is in', async () => {
    const p = await projects.create('team-1', { name: 'Hoa Lư' }, req(OWNER));
    const v1 = await videos.create(p.id, { title: 'Tràng An' }, req(OWNER));
    const v2 = await videos.create(p.id, { title: 'Hang Múa' }, req(OWNER));
    const v3 = await videos.create(p.id, { title: 'Bích Động' }, req(OWNER));
    const clip = await put(EDITOR, 'IMG_4021.mov', Buffer.from('movie'));
    const r = await inputs.fromMedia(p.id, { mediaIds: [clip.id], use: 'footage', videoIds: [v1.id, v2.id] }, req(EDITOR));
    expect(r.sources.map((x) => x.videoId).sort()).toEqual([v1.id, v2.id].sort());
    expect(r.sources.every((x) => x.ref === clip.id && x.mediaId === clip.id && x.kind === 'upload_asset')).toBe(true);
    expect(r.prepare).toMatchObject({ state: 'queued' });
    expect((await listJobs(s.engine.db, p.id)).filter((j) => j.kind === 'prepare_asset')).toHaveLength(1);
    expect((await library.list({}, req(EDITOR))).items[0]!.usedIn).toEqual([{ projectId: p.id, name: 'Hoa Lư' }]);

    expect(await inputs.footageVideos(p.id, clip.id, { videoIds: [v2.id, v3.id] }, req(EDITOR))).toEqual({ videoIds: [v2.id, v3.id] });
    const rows = (await inputs.sources(p.id)).sources.filter((x) => x.ref === clip.id);
    expect(rows.map((x) => x.videoId).sort()).toEqual([v2.id, v3.id].sort());
    expect(existsSync(join(root, p.id, 'videos', v3.id, 'sources', 'index.json'))).toBe(true);

    // a footage uploaded straight from the computer goes into several videos too, and into the library
    const link = await inputs.signUpload(p.id, { purpose: 'footage', name: 'DJI_0087.mp4', size: 5 }, req(EDITOR));
    await bucket.put(link.key, Buffer.from('drone'));
    const up = await inputs.addFootage(p.id, { uploadKey: link.key, name: 'DJI_0087.mp4', videoIds: [v1.id, v3.id], prepare: false }, req(EDITOR));
    expect(up.sources.map((x) => x.videoId).sort()).toEqual([v1.id, v3.id].sort());
    expect(up.prepare).toBeUndefined();
    expect((await library.list({ kind: 'video' }, req(EDITOR))).total).toBe(2);

    // someone else's item, audio as footage
    const theirs = await put(OWNER, 'x.mp4');
    expect(await inputs.fromMedia(p.id, { mediaIds: [theirs.id], use: 'footage' }, req(EDITOR)).catch(code)).toBe('media_not_found');
    const song = await put(EDITOR, 'a.mp3');
    expect(await inputs.fromMedia(p.id, { mediaIds: [song.id], use: 'footage' }, req(EDITOR)).catch(code)).toBe('wrong_use');
  });

  it('never deletes an item a project uses, saying which', async () => {
    const p = await projects.create('team-1', { name: 'Hoa Lư' }, req(OWNER));
    const song = await put(EDITOR, 'a.mp3');
    const [src] = (await inputs.fromMedia(p.id, { mediaIds: [song.id], use: 'audio' }, req(EDITOR))).sources;
    const err = await library.remove(song.id, req(EDITOR)).catch((e: { getResponse: () => unknown }) => e.getResponse());
    expect(err).toMatchObject({ code: 'media_in_use', projects: [{ projectId: p.id, name: 'Hoa Lư' }] });
    await inputs.remove(p.id, src!.id, undefined, req(EDITOR));
    await library.remove(song.id, req(EDITOR));
    expect((await library.list({}, req(EDITOR))).total).toBe(0);
    expect(await library.remove(song.id, req(EDITOR)).catch(code)).toBe('media_not_found');
  });

  it('audio and videos dropped in the Files tab go to the library; they play and open from the bucket, never the disk', async () => {
    const p = await projects.create('team-1', { name: 'Hoa Lư' }, req(OWNER));
    const tmp = (name: string, body: string) => { const path = join(mkdtempSync(join(tmpdir(), 'up-')), name); writeFileSync(path, body); return { path, originalname: name, size: body.length }; };
    const song = await files.upload(p.id, { dir: 'context/uploads' }, tmp('Nhạc nền.mp3', 'song'), req(EDITOR));
    expect(song).toMatchObject({ path: 'context/audio/Nhạc nền.mp3', size: 4, sha256: null, mediaId: expect.any(String) });
    const ref = await files.upload(p.id, {}, tmp('Mẫu.mp4', 'video'), req(EDITOR));
    expect(ref).toMatchObject({ path: 'context/references/Mẫu.mp4' });
    expect(existsSync(join(root, p.id, 'context', 'audio', 'Nhạc nền.mp3'))).toBe(false);
    // a signed link of the Files tab for audio is a library link
    const link = await inputs.signUpload(p.id, { purpose: 'file', name: 'b.wav', size: 3 }, req(EDITOR));
    expect(link.key).toContain('/media/');
    await bucket.put(link.key, Buffer.from('wav'));
    expect(await files.upload(p.id, { uploadKey: link.key, name: 'b.wav' }, undefined, req(EDITOR))).toMatchObject({ path: 'context/audio/b.wav' });

    const view = await files.content(p.id, 'context/audio/Nhạc nền.mp3', req(EDITOR));
    expect(view).toMatchObject({ path: 'context/audio/Nhạc nền.mp3', size: 4, mime: 'audio/mpeg', binary: true, text: null });
    const t = new URL(`http://x${view.streamUrl!}`).searchParams.get('t')!;
    let to = '';
    const res = { redirect: (_status: number, url: string) => { to = url; }, attachment: () => undefined } as unknown as Response;
    await stream.stream(p.id, 'context/audio/Nhạc nền.mp3', t, res);
    expect(to).toMatch(/^memory:\/\/library\/studio\/users\/.+\.mp3/);
    let raw = '';
    await files.raw(p.id, 'context/references/Mẫu.mp4', { redirect: (_s: number, url: string) => { raw = url; } } as unknown as Response);
    expect(raw).toMatch(/\.mp4/);
    // the audio list of the project has them, with links that play
    const list = await audio.audio(p.id, req(EDITOR));
    expect(list.files.map((f) => f.path).sort()).toEqual(['context/audio/Nhạc nền.mp3', 'context/audio/b.wav']);
    expect(list.files.every((f) => f.key && f.listenUrl.includes('/files/stream?'))).toBe(true);
  });

  it('picks a library file as the voice by its path, checked by its size on the bucket', async () => {
    const p = await projects.create('team-1', { name: 'Hoa Lư' }, req(OWNER));
    const big = await put(OWNER, 'giọng dài.wav', Buffer.alloc(21 * 1024 * 1024));
    const [src] = (await inputs.fromMedia(p.id, { mediaIds: [big.id], use: 'audio' }, req(OWNER))).sources;
    expect(await audio.fromFile(p.id, 'voice', { path: src!.ref, origin: 'own' }, req(OWNER)).catch(code)).toBe('audio_too_large');
    // within the limit it goes on to the audio tools (none on this server)
    expect(await audio.fromFile(p.id, 'music', { path: src!.ref }, req(OWNER)).catch(code)).toBe('audio_disabled');
  });

  it("sets the project's look; applied to all videos, their own picks go and every timeline draws it", async () => {
    const p = await projects.create('team-1', { name: 'Hoa Lư' }, req(OWNER));
    const v1 = await videos.create(p.id, { title: 'Tràng An' }, req(OWNER));
    const v2 = await videos.create(p.id, { title: 'Hang Múa' }, req(OWNER));
    for (const v of [v1, v2]) await saveVideoRevision(s.engine.db, v.id, { baseRevision: 0, data: timeline(v.id), authorId: OWNER, label: 'fit' });
    await look.set(v2.id, { text_look: null, look: 'vivid', color_match: null }, req(EDITOR));
    const before = await look.getProject(p.id);
    expect(before.own).toEqual({ text_look: null, look: null, color_match: null });
    expect(before.videos.find((v) => v.id === v2.id)?.ownLook).toBe(true);

    const kept = await look.setProject(p.id, { text_look: null, look: 'warm', color_match: true }, req(EDITOR));
    expect(kept).toMatchObject({ own: { look: 'warm', color_match: true }, cleared: [] });
    expect((await look.get(v1.id)).effective).toMatchObject({ look: 'warm', from: { look: 'project' } });
    expect((await look.get(v2.id)).effective).toMatchObject({ look: 'vivid', from: { look: 'video' } });

    const all = await look.setProject(p.id, { text_look: null, look: 'cinematic', color_match: false, everyVideo: true }, req(EDITOR));
    expect(all.cleared).toEqual([v2.id]);
    expect(all.timelines).toBe(2);
    expect((await look.get(v2.id)).effective).toMatchObject({ look: 'cinematic', from: { look: 'project' } });
    expect(await look.setProject(p.id, { look: 'neon' }, req(EDITOR)).catch(code)).toBe('bad_look');
  });
});
