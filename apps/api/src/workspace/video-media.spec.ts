/**
 * A video's media over a real studio.db: renders listed with a link only for people whose ag-go rights cover the
 * footage, starting renders by role, the timeline, and the project's audio picked from a workspace file.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { claimJob, finishJob, getJob, saveVideoRevision } from '@ag-studio/engine';
import { AgGoClientError } from '../ag-go/client';

type TimelineV4 = Parameters<typeof saveVideoRevision>[2]['data'];
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import type { ProjectFootageService } from './project-footage.service';
import { ProjectsController } from './projects.controller';
import { VideoMediaController } from './video-media.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const OWNER = 'auth0|owner';
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

describe('video media (real studio.db)', () => {
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
      check: async (userId: string, ids: string[]) => {
        seen.push([userId, ...ids]);
        if (userId === DOWN) throw new AgGoClientError(502, 'Bad Gateway');
        if (userId === GONE) throw new AgGoClientError(404, { message: `Video not found or not in scope: ${ids[0]}` });
        return userId === OWNER ? { ok: ids, missing: [] } : { ok: [], missing: ids };
      },
    } as unknown as ProjectFootageService;
    Object.assign(engine, { bucket: { signedGetUrl: async (key: string) => `https://r2.test/${key}` }, browserUrlTtl: 600 });
    projects = new ProjectsController(engine, ws);
    videos = new VideosController(engine, ws);
    media = new VideoMediaController(engine, ws, footage, { get: () => undefined } as unknown as ConfigService);
    insertTeam(s.db, 'team-1', OWNER);
    s.engine.db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', ?, 'editor', ?)", [EDITOR, new Date().toISOString()]);
  });
  afterEach(() => s.close());

  it('starts renders by role, lists finished ones from the database and links one only for those whose footage rights cover it', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Huế' }, req(OWNER));
    expect(await media.render(v.id, { kind: 'render_preview' }, req(EDITOR)).catch(code)).toBe('no_timeline');
    saveVideoRevision(s.engine.db, v.id, { baseRevision: 0, data: timeline(v.id), authorId: 'u' });
    expect(await media.render(v.id, { kind: 'render_final' }, req(EDITOR)).catch(code)).toBe('role');
    const job = await media.render(v.id, { kind: 'render_preview' }, req(EDITOR));
    expect(getJob(s.engine.db, job.id)).toMatchObject({ kind: 'render_preview', actor_role: 'editor' });
    claimJob(s.engine.db, ['render_preview'], new Date().toISOString());
    finishJob(s.engine.db, job.id, { status: 'done', result: { kind: 'render_preview', revision: 1, key: 'productions/x/out/a.mp4', duration_s: 4, width: 1920, height: 1080, watermarked: true, size_bytes: 10, note: '' } }, new Date().toISOString());
    // the list is the database alone: no ag-go, no signing
    const listed = await media.renders(v.id);
    expect(listed.renders[0]).toEqual({ jobId: job.id, kind: 'render_preview', revision: 1, durationS: 4, width: 1920, height: 1080, watermarked: true, sizeBytes: 10, note: '', finishedAt: expect.any(String) });
    expect(seen).toEqual([]);
    // a link is asked for one render
    expect(await media.link(v.id, job.id, req(OWNER))).toEqual({ jobId: job.id, url: 'https://r2.test/productions/x/out/a.mp4' });
    expect(await media.link(v.id, job.id, req(EDITOR))).toEqual({ jobId: job.id, url: null, urlHidden: 'footage_scope' });
    expect(seen).toEqual([[OWNER, 'a1'], [EDITOR, 'a1']]);
    expect(await media.link(v.id, 'not-a-job', req(OWNER)).catch((e: { getStatus?: () => number }) => e.getStatus?.())).toBe(404);
    // ag-go not answering is not a lack of rights; its 404 (a video out of scope) is
    seen.length = 0;
    expect(await media.link(v.id, job.id, req(DOWN))).toMatchObject({ url: null, urlHidden: 'footage_check_failed' });
    expect(await media.link(v.id, job.id, req(GONE))).toMatchObject({ url: null, urlHidden: 'footage_scope' });
    expect(await media.link(v.id, job.id, req(GONE))).toMatchObject({ urlHidden: 'footage_scope' });
    expect(seen).toEqual([[DOWN, 'a1'], [GONE, 'a1']]);
    // links asked at once join the check under way
    seen.length = 0;
    const both = await Promise.all([media.link(v.id, job.id, req('auth0|poll')), media.link(v.id, job.id, req('auth0|poll'))]);
    expect(both.map((x) => x.urlHidden)).toEqual(['footage_scope', 'footage_scope']);
    expect(seen).toEqual([['auth0|poll', 'a1']]);
    expect((await media.timeline(v.id)).latest).toMatchObject({ revision: 1, clips: [expect.objectContaining({ clip_id: 'C001' })] });
  });

  it('picks the voice from a workspace file only for a producer, saying where it comes from', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    mkdirSync(join(root, p.id, 'context', 'audio'), { recursive: true });
    writeFileSync(join(root, p.id, 'context', 'audio', 'giong.wav'), 'RIFF');
    expect(await media.fromFile(p.id, 'voice', { path: 'context/audio/giong.wav', origin: 'own' }, req(EDITOR)).catch(code)).toBe('role');
    expect(await media.fromFile(p.id, 'voice', { path: 'context/audio/giong.wav' }, req(OWNER)).catch(code)).toBe('origin');
    expect(await media.fromFile(p.id, 'music', { path: 'context/audio/giong.wav' }, req(EDITOR)).catch(code)).toBe('audio_disabled');
    expect((await media.decline(p.id, req(OWNER))).summary.voice).toBe('không lời dẫn (lời thành phụ đề)');
  });
});
