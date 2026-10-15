/**
 * A video's media over a real database: renders listed with their link (a Premiere export's only for people whose ag-go
 * rights cover the footage), starting renders by role, the timeline, and the project's audio picked from a workspace file.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { claimJob, finishJob, getJob, latestVideoRevision, saveLibraryMusic, saveVideoRevision } from '@ag-studio/engine';
import { audioTools } from '../studio/audio-tools';
import { AgGoClientError } from '../ag-go/client';

type TimelineV4 = Parameters<typeof saveVideoRevision>[2]['data'];
import { insertTeam, NO_DIRECTORY, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import type { ProjectFootageService } from './project-footage.service';
import { ProjectsController } from './projects.controller';
import { FileLinkService } from './file-links';
import { VideoMediaController } from './video-media.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const OWNER = 'auth0|owner';
const LINKS = new FileLinkService({ get: () => 's'.repeat(32) } as unknown as ConfigService);
const EDITOR = 'auth0|editor';
const DOWN = 'auth0|down';
const GONE = 'auth0|gone';
const code = (e: unknown) => (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? String(e);

function timeline(videoId: string): TimelineV4 {
  return {
    schema_version: 'studio.timeline/v4', production_id: 'p', episode_id: videoId, canvas: { width: 1920, height: 1080 }, fps: 30, language: 'vi', edit_style: 'cut',
    clips: [{ clip_id: 'C001', asset_id: 'a1', section_title: null, in: 0, out: 4, shot_id: null, line_id: null, transition_out: { kind: 'cut', seconds: 0 } }],
    texts: [], narration: { voice: 'none', lead_seconds: 0.3, lines: [] }, captions: { mode: 'none' }, music: null, source_audio: { muted: false },
    assets: { a1: { title: 'Phố', summary_vi: '…', duration_s: 10, orientation: 'landscape' } }, alternates: [],
  } as TimelineV4;
}

describe('video media (real database)', () => {
  let s: RealStudio;
  let root: string;
  let projects: ProjectsController;
  let videos: VideosController;
  let media: VideoMediaController;
  const seen: string[][] = [];

  beforeEach(async () => {
    s = await realStudio();
    const engine = s.engine as unknown as EngineService;
    root = mkdtempSync(join(tmpdir(), 'video-media-'));
    const ws = new WorkspaceService({ get: (k: string, d?: unknown) => (k === 'STUDIO_WORKSPACES_ROOT' ? root : d) } as unknown as ConfigService, engine);
    seen.length = 0;
    const footage = {
      checkLots: async (userId: string, ids: string[]) => {
        seen.push([userId, ...ids]);
        if (userId === DOWN) return [{ assetIds: ids, error: new AgGoClientError(502, 'Bad Gateway') }];
        if (userId === GONE) return [{ assetIds: ids, error: new AgGoClientError(404, { message: `Video not found or not in scope: ${ids[0]}` }) }];
        return [userId === OWNER ? { assetIds: ids, served: ids, missing: [] } : { assetIds: ids, served: [], missing: ids }];
      },
    } as unknown as ProjectFootageService;
    Object.assign(engine, { bucket: { signedGetUrl: async (key: string, _ttl: number, o: { downloadName?: string } = {}) => `https://r2.test/${key}${o.downloadName ? `?name=${o.downloadName}` : ''}` }, browserUrlTtl: 600 });
    projects = new ProjectsController(engine, ws, NO_DIRECTORY);
    videos = new VideosController(engine, ws);
    media = new VideoMediaController(engine, ws, footage, { get: () => undefined } as unknown as ConfigService, LINKS);
    await insertTeam(s.db, 'team-1', OWNER);
    await s.engine.db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', ?, 'editor', ?)", [EDITOR, new Date().toISOString()]);
  });
  afterEach(async () => { await s.close(); });

  it('starts renders by role, lists finished ones with their link and links a Premiere export only for those whose footage rights cover it', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Huế' }, req(OWNER));
    expect(await media.render(v.id, { kind: 'render_preview' }, req(EDITOR)).catch(code)).toBe('no_timeline');
    await saveVideoRevision(s.engine.db, v.id, { baseRevision: 0, data: timeline(v.id), authorId: 'u' });
    expect(await media.render(v.id, { kind: 'render_final' }, req(EDITOR)).catch(code)).toBe('role');
    const job = await media.render(v.id, { kind: 'render_preview' }, req(EDITOR));
    expect(await getJob(s.engine.db, job.id)).toMatchObject({ kind: 'render_preview', actor_role: 'editor' });
    await claimJob(s.engine.db, ['render_preview'], new Date().toISOString());
    await finishJob(s.engine.db, job.id, { status: 'done', result: { kind: 'render_preview', revision: 1, key: 'productions/x/out/a.mp4', duration_s: 4, width: 1920, height: 1080, watermarked: true, size_bytes: 10, note: '' } }, new Date().toISOString());
    // the list is the database alone (no ag-go), a preview with its link signed along
    const listed = await media.renders(v.id);
    expect(listed.renders[0]).toEqual({ jobId: job.id, kind: 'render_preview', revision: 1, durationS: 4, width: 1920, height: 1080, watermarked: true, sizeBytes: 10, note: '', finishedAt: expect.any(String), url: 'https://r2.test/productions/x/out/a.mp4' });
    // a preview or final render links for anyone of the project: no footage check
    expect(await media.link(v.id, job.id, req(OWNER))).toEqual({ jobId: job.id, url: 'https://r2.test/productions/x/out/a.mp4' });
    expect(await media.link(v.id, job.id, req(EDITOR))).toEqual({ jobId: job.id, url: 'https://r2.test/productions/x/out/a.mp4' });
    expect(seen).toEqual([]);
    expect(await media.link(v.id, 'not-a-job', req(OWNER)).catch((e: { getStatus?: () => number }) => e.getStatus?.())).toBe(404);
    // a Premiere export packs the footage itself: listed without a link, linked only for those whose rights cover it
    const zip = await media.render(v.id, { kind: 'export_premiere' }, req(OWNER));
    await claimJob(s.engine.db, ['export_premiere'], new Date().toISOString());
    await finishJob(s.engine.db, zip.id, { status: 'done', result: { kind: 'export_premiere', revision: 1, key: 'productions/x/out/a.zip', duration_s: null, width: null, height: null, watermarked: null, size_bytes: 20, note: '' } }, new Date().toISOString());
    expect((await media.renders(v.id)).renders.find((x) => x.jobId === zip.id)).not.toHaveProperty('url');
    expect(seen).toEqual([]);
    expect(await media.link(v.id, zip.id, req(OWNER))).toEqual({ jobId: zip.id, url: 'https://r2.test/productions/x/out/a.zip?name=Huế.zip' });
    expect(await media.link(v.id, zip.id, req(EDITOR))).toEqual({ jobId: zip.id, url: null, urlHidden: 'footage_scope' });
    expect(seen).toEqual([[OWNER, 'a1'], [EDITOR, 'a1']]);
    // ag-go not answering is not a lack of rights; its 404 (a video out of scope) is
    seen.length = 0;
    expect(await media.link(v.id, zip.id, req(DOWN))).toMatchObject({ url: null, urlHidden: 'footage_check_failed' });
    expect(await media.link(v.id, zip.id, req(DOWN))).toMatchObject({ urlHidden: 'footage_check_failed' }); // kept 30 s, not asked again
    expect(await media.link(v.id, zip.id, req(GONE))).toMatchObject({ url: null, urlHidden: 'footage_scope' });
    expect(await media.link(v.id, zip.id, req(GONE))).toMatchObject({ urlHidden: 'footage_scope' });
    expect(seen).toEqual([[DOWN, 'a1'], [GONE, 'a1']]);
    // links asked at once join the check under way
    seen.length = 0;
    const both = await Promise.all([media.link(v.id, zip.id, req('auth0|poll')), media.link(v.id, zip.id, req('auth0|poll'))]);
    expect(both.map((x) => x.urlHidden)).toEqual(['footage_scope', 'footage_scope']);
    expect(seen).toEqual([['auth0|poll', 'a1']]);
    // a new revision with the same footage is answered from what is known
    await saveVideoRevision(s.engine.db, v.id, { baseRevision: 1, data: { ...timeline(v.id), texts: [] }, authorId: 'u' });
    const job2 = await media.render(v.id, { kind: 'export_premiere' }, req(OWNER));
    await claimJob(s.engine.db, ['export_premiere'], new Date().toISOString());
    await finishJob(s.engine.db, job2.id, { status: 'done', result: { kind: 'export_premiere', revision: 2, key: 'productions/x/out/b.zip', duration_s: null, width: null, height: null, watermarked: null, size_bytes: 20, note: '' } }, new Date().toISOString());
    seen.length = 0;
    expect(await media.link(v.id, job2.id, req(OWNER))).toEqual({ jobId: job2.id, url: 'https://r2.test/productions/x/out/b.zip?name=Huế.zip' });
    expect(seen).toEqual([]);
    expect((await media.timeline(v.id)).latest).toMatchObject({ revision: 2, clips: [expect.objectContaining({ clip_id: 'C001' })] });
  });

  it('picks the voice from a workspace file only for a producer, saying where it comes from', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    mkdirSync(join(root, p.id, 'context', 'audio'), { recursive: true });
    writeFileSync(join(root, p.id, 'context', 'audio', 'giong.wav'), 'RIFF');
    expect(await media.fromFile(p.id, 'voice', { path: 'context/audio/giong.wav', origin: 'own' }, req(EDITOR)).catch(code)).toBe('role');
    expect(await media.fromFile(p.id, 'voice', { path: 'context/audio/giong.wav' }, req(OWNER)).catch(code)).toBe('origin');
    expect(await media.fromFile(p.id, 'music', { path: 'context/audio/giong.wav' }, req(EDITOR)).catch(code)).toBe('audio_disabled');
    expect((await media.decline(p.id, req(OWNER))).summary.voice).toBe('không lời dẫn (lời thành phụ đề)');
    // clearing the voice stays with producers; the music, with editors (as picking it)
    expect(await media.clear(p.id, 'voice', req(EDITOR)).catch(code)).toBe('role');
    expect((await media.clear(p.id, 'voice', req(OWNER))).voice).toBeNull();
  });

  it('says whether audio can be taken in and lists the audio files to pick from, also those put in context/audio through the Files tab', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const audioDir = join(root, p.id, 'context', 'audio');
    mkdirSync(join(audioDir, 'cu'), { recursive: true });
    writeFileSync(join(audioDir, 'giong.wav'), 'RIFF....');
    writeFileSync(join(audioDir, 'cu', 'nhac.mp3'), 'ID3');
    writeFileSync(join(audioDir, 'ghi-chu.txt'), 'not audio');
    const row = (id: string, ref: string, label: string) => s.engine.db.run(
      "INSERT INTO project_sources (id, project_id, video_id, kind, ref, media_type, label, meta, added_by, added_at) VALUES (?, ?, NULL, 'upload', ?, 'audio', ?, '{}', ?, ?)",
      [id, p.id, ref, label, EDITOR, '2020-01-01T00:00:00.000Z'],
    );
    await row('src-1', 'context/audio/giong.wav', 'Giọng mẫu.wav');
    await row('src-2', 'context/audio/mat.wav', 'mat.wav'); // its file is gone
    const a = await media.audio(p.id, req(OWNER));
    expect(a.enabled).toBe(false);
    expect(a.libraryTrack).toBeNull();
    expect(a.files.map((f) => [f.path, f.name, f.bytes, f.sourceId])).toEqual([
      ['context/audio/cu/nhac.mp3', 'nhac.mp3', 3, null],
      ['context/audio/giong.wav', 'Giọng mẫu.wav', 8, 'src-1'],
    ]);
    // each with a short link to listen to it, made for the person who asked
    const link = new URL(a.files[0]!.listenUrl, 'http://studio.test');
    expect(link.pathname).toBe(`/api/projects/${p.id}/files/stream`);
    expect(link.searchParams.get('path')).toBe('context/audio/cu/nhac.mp3');
    expect(LINKS.verify(link.searchParams.get('t')!)).toMatchObject({ project: p.id, path: 'context/audio/cu/nhac.mp3', sub: OWNER });
    const engine = s.engine as unknown as EngineService;
    const ws = new WorkspaceService({ get: (k: string, d?: unknown) => (k === 'STUDIO_WORKSPACES_ROOT' ? root : d) } as unknown as ConfigService, engine);
    const withFfmpeg = new VideoMediaController(engine, ws, {} as ProjectFootageService, { get: (k: string) => (k === 'STUDIO_FFMPEG_PATH' ? '/opt/ff/ffmpeg' : undefined) } as unknown as ConfigService, LINKS);
    expect((await withFfmpeg.audio(p.id, req(OWNER))).enabled).toBe(true);
  });

  it('ffprobe defaults to the one next to ffmpeg, as on the worker', () => {
    const cfg = (v: Record<string, string>) => ({ get: (k: string) => v[k] }) as unknown as ConfigService;
    expect(audioTools(cfg({}))).toBeNull();
    expect(audioTools(cfg({ STUDIO_FFMPEG_PATH: 'C:/ff/bin/ffmpeg.exe' }))).toEqual({ ffmpeg: 'C:/ff/bin/ffmpeg.exe', ffprobe: 'C:/ff/bin/ffprobe.exe' });
    expect(audioTools(cfg({ STUDIO_FFMPEG_PATH: '/usr/bin/ffmpeg', STUDIO_FFPROBE_PATH: '/opt/ffprobe' }))).toEqual({ ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/opt/ffprobe' });
  });

  it('picks a music library track for the project without ffmpeg; a retired or unknown track is refused; editors clear the music', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const now = '2026-10-01T00:00:00.000Z';
    const track = (id: string, name: string, active: boolean) => ({
      schema_version: 'harness.music-track/v1' as const, track_id: id, display_name: name, file: 'library:music/' + id + '.m4a',
      mood: ['ấm áp'], duration_seconds: 95, loop_ok: true, origin: 'royalty_free' as const, origin_note: 'kho miễn phí',
      checksum: 'sha256:' + 'a'.repeat(64), active, created_at: now, updated_at: now,
    });
    await saveLibraryMusic(s.engine.db, track('m-sang', 'Sáng sớm', true));
    await saveLibraryMusic(s.engine.db, track('m-cu', 'Bài cũ', false));
    const a = await media.fromLibrary(p.id, { trackId: 'm-sang', gainDb: -20 }, req(EDITOR));
    expect(a.music).toEqual({ track: 'library:music/m-sang.m4a', gain_db: -20, ducking: true, sha256: 'a'.repeat(64), duration_s: 95 });
    expect(a.libraryTrack).toEqual({ trackId: 'm-sang', displayName: 'Sáng sớm', moods: ['ấm áp'], durationSeconds: 95 });
    expect(a.summary.music).toBe('bài "Sáng sớm" trong kho nhạc (95 s), -20 dB, nhỏ lại khi có lời');
    expect(await media.fromLibrary(p.id, { trackId: 'm-cu' }, req(EDITOR)).catch(code)).toBe('audio_invalid');
    expect(await media.fromLibrary(p.id, { trackId: 'm-khong' }, req(EDITOR)).catch(code)).toBe('not_found');
    expect(await media.fromLibrary(p.id, { trackId: 'm-sang', extra: 1 }, req(EDITOR)).catch(code)).toBe('invalid');
    const cleared = await media.clear(p.id, 'music', req(EDITOR));
    expect(cleared.music).toBeNull();
    expect(cleared.summary.music).toContain('chưa chọn');
  });

  it("a video's own music overrides the project's and its latest timeline takes it; cleared, it takes the project's again", async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Huế' }, req(OWNER));
    const now = '2026-10-01T00:00:00.000Z';
    const track = (id: string) => ({
      schema_version: 'harness.music-track/v1' as const, track_id: id, display_name: id, file: 'library:music/' + id + '.m4a',
      mood: ['ấm áp'], duration_seconds: 95, loop_ok: true, origin: 'royalty_free' as const, origin_note: 'kho miễn phí',
      checksum: 'sha256:' + 'a'.repeat(64), active: true, created_at: now, updated_at: now,
    });
    await saveLibraryMusic(s.engine.db, track('du-an'));
    await saveLibraryMusic(s.engine.db, track('rieng'));
    expect(await media.videoAudio(v.id, req(OWNER))).toMatchObject({ music: null, uses: 'mood', revision: null });
    await media.fromLibrary(p.id, { trackId: 'du-an' }, req(EDITOR));
    expect(await media.videoAudio(v.id, req(OWNER))).toMatchObject({ music: null, uses: 'project', summary: expect.stringContaining('nhạc của dự án: bài "du-an"') });

    await saveVideoRevision(s.engine.db, v.id, { baseRevision: 0, data: timeline(v.id), authorId: OWNER, label: 'fit' });
    const own = await media.videoFromLibrary(v.id, { trackId: 'rieng', gainDb: -22 }, req(EDITOR));
    expect(own).toMatchObject({ uses: 'video', music: { track: 'library:music/rieng.m4a', gain_db: -22 }, libraryTrack: { trackId: 'rieng' }, revision: 2 });
    expect((await latestVideoRevision(s.engine.db, v.id))?.data.music).toEqual({ track: 'library:music/rieng.m4a', gain_db: -22, ducking: true });
    expect((await media.audio(p.id, req(OWNER))).music).toMatchObject({ track: 'library:music/du-an.m4a' });

    const back = await media.clearVideo(v.id, req(EDITOR));
    expect(back).toMatchObject({ music: null, uses: 'project', revision: 3 });
    expect((await latestVideoRevision(s.engine.db, v.id))?.data.music).toMatchObject({ track: 'library:music/du-an.m4a' });
  });

  it('joining files for the project or a video needs ffmpeg; each file must be in the workspace; at most 20', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Huế' }, req(OWNER));
    mkdirSync(join(root, p.id, 'context', 'audio'), { recursive: true });
    for (const n of ['a.mp3', 'b.mp3']) writeFileSync(join(root, p.id, 'context', 'audio', n), 'ID3');
    const paths = ['context/audio/a.mp3', 'context/audio/b.mp3'];
    expect(await media.fromFiles(p.id, { paths, crossfadeS: 2 }, req(EDITOR)).catch(code)).toBe('audio_disabled');
    expect(await media.videoFromFiles(v.id, { paths }, req(EDITOR)).catch(code)).toBe('audio_disabled');
    expect(await media.fromFiles(p.id, { paths: ['context/audio/a.mp3', 'context/audio/khong.mp3'] }, req(EDITOR)).catch(code)).not.toBe('audio_disabled');
    expect(await media.fromFiles(p.id, { paths: Array.from({ length: 21 }, () => paths[0]) }, req(EDITOR)).catch(code)).toBe('invalid');
    expect(await media.fromFiles(p.id, { paths, crossfadeS: 11 }, req(EDITOR)).catch(code)).toBe('invalid');
  });
});
