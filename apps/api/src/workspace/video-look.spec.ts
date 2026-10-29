/**
 * A video's words and picture over a real database: the channel's branding until the video picks its own, the pick
 * over the edit plan's, put on the latest timeline at once, and taken back.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { latestVideoRevision, saveVideoRevision } from '@ag-studio/engine';
import { insertTeam, NO_DIRECTORY, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import { ProjectsController } from './projects.controller';
import { VideoLookController } from './video-look.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';

type TimelineV4 = Parameters<typeof saveVideoRevision>[2]['data'];
const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const OWNER = 'auth0|owner';
const status = (e: unknown) => (e as { getStatus?: () => number }).getStatus?.() ?? String(e);
const LOOK = { text_color: '#FFD400', outline_color: '#1A1A1A', box_color: null, size: 'l', shadow: true, font: 'Montserrat' } as const;

function timeline(videoId: string): TimelineV4 {
  return {
    schema_version: 'studio.timeline/v4', production_id: 'p', episode_id: videoId, canvas: { width: 1920, height: 1080 }, fps: 30, language: 'vi', edit_style: 'cut',
    clips: [{ clip_id: 'C001', asset_id: 'a1', section_title: null, in: 0, out: 4, shot_id: null, line_id: null, transition_out: { kind: 'cut', seconds: 0 } }],
    texts: [], narration: { voice: 'none', lead_seconds: 0.3, lines: [] }, captions: { mode: 'none' }, music: null, source_audio: { muted: false },
    assets: { a1: { title: 'Phố', summary_vi: '…', duration_s: 10, orientation: 'landscape' } }, alternates: [],
  } as TimelineV4;
}

describe('video look (real database)', () => {
  let s: RealStudio;
  let ws: WorkspaceService;
  let projects: ProjectsController;
  let videos: VideosController;
  let look: VideoLookController;

  beforeEach(async () => {
    s = await realStudio();
    const engine = s.engine as unknown as EngineService;
    const root = mkdtempSync(join(tmpdir(), 'video-look-'));
    ws = new WorkspaceService({ get: (k: string, d?: unknown) => (k === 'STUDIO_WORKSPACES_ROOT' ? root : d) } as unknown as ConfigService, engine);
    projects = new ProjectsController(engine, ws, NO_DIRECTORY);
    videos = new VideosController(engine, ws);
    look = new VideoLookController(engine, ws);
    await insertTeam(s.db, 'team-1', OWNER);
  });
  afterEach(async () => { await s.close(); });

  it("takes the channel's look until the video picks its own, over the plan's, and puts it on the timeline at once", async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Huế' }, req(OWNER));
    const dir = await ws.dir(p.id);
    mkdirSync(join(dir, 'channel'), { recursive: true });
    writeFileSync(join(dir, 'channel', 'branding.md'), '---\nlook: warm\ntext_look:\n  text_color: "#FFFFFF"\n  outline_color: "#000000"\n  box_color: null\n  size: m\n  font: "Be Vietnam Pro"\n---\n# B\n');
    mkdirSync(join(dir, 'videos', v.id), { recursive: true });
    writeFileSync(join(dir, 'videos', v.id, 'edit-plan.json'), JSON.stringify({ look: 'vivid' }));

    const first = await look.get(v.id);
    expect(first.effective).toMatchObject({ text_look: { font: 'Be Vietnam Pro' }, look: 'vivid', color_match: false, from: { text_look: 'channel', look: 'plan', color_match: 'default' } });
    expect(first.choices.fonts).toContainEqual({ name: 'Be Vietnam Pro', scripts: ['vietnamese'] });

    await saveVideoRevision(s.engine.db, v.id, { baseRevision: 0, data: timeline(v.id), authorId: 'u' });
    const picked = await look.set(v.id, { text_look: LOOK, look: 'cinematic', color_match: true }, req(OWNER));
    expect(picked.effective).toMatchObject({ text_look: LOOK, look: 'cinematic', color_match: true, from: { text_look: 'video', look: 'video', color_match: 'video' } });
    expect(picked.revision).toBe(2);
    expect((await latestVideoRevision(s.engine.db, v.id))!.data).toMatchObject({ text_style: LOOK, look: 'cinematic', color_match: true });
    // the same pick again writes no revision
    expect((await look.set(v.id, { text_look: LOOK, look: 'cinematic', color_match: true }, req(OWNER))).revision).toBeNull();

    const back = await look.set(v.id, { text_look: null, look: null, color_match: null }, req(OWNER));
    expect(back.effective.from).toEqual({ text_look: 'channel', look: 'plan', color_match: 'default' });
    const data = (await latestVideoRevision(s.engine.db, v.id))!.data;
    expect(data).toMatchObject({ text_style: { font: 'Be Vietnam Pro' }, look: 'vivid' });
    expect(data).not.toHaveProperty('color_match');
  });

  it('refuses a font the render machines do not have, and a missing key', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Huế' }, req(OWNER));
    expect(await look.set(v.id, { text_look: { ...LOOK, font: 'Comic Sans' }, look: null, color_match: null }, req(OWNER)).catch(status)).toBe(422);
    expect(await look.set(v.id, { look: 'warm' }, req(OWNER)).catch(status)).toBe(422);
    expect((await look.get(v.id)).own).toEqual({ text_look: null, look: null, color_match: null });
  });
});
