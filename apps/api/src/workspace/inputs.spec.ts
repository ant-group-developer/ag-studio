/**
 * The Inputs tab routes over a real database and folder: an ag-go project is added only by someone who may download
 * its originals, a video only from an ag-go project added, ag-go's trusted mode then searches them whoever asks;
 * removing a project still used asks first; uploads land in context/ by kind, preparing queues one background job per
 * video, the agent's jobs list and stop, and the video's sources index follows.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { addSource, claimJob, getJob, listMessages, MemoryBucket } from '@ag-studio/engine';
import { insertTeam, NO_DIRECTORY, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import type { SiteNameService } from '../ag-go/site-name.service';
import { InputsController } from './inputs.controller';
import type { ProjectFootageService } from './project-footage.service';
import { ProjectsController } from './projects.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';
import { MediaLibraryService } from './media-library.service';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const OWNER = 'auth0|owner';
const EDITOR = 'auth0|editor';
const A1 = '0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11';
const A2 = '1c8b6d45-6e2f-4e5d-8b62-4e3b2f1d8e22';
const code = (e: unknown) => (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? String(e);
/** What the person may do with each ag-go project (ag-go's `POST /footage/projects/access`). */
const ACCESS: Record<string, { canView: boolean; canDownloadOriginals: boolean; analyzedVideos: number; usableVideos: number }> = {
  'agp-1': { canView: true, canDownloadOriginals: true, analyzedVideos: 4, usableVideos: 3 },
  'agp-2': { canView: true, canDownloadOriginals: true, analyzedVideos: 2, usableVideos: 2 },
  'agp-wm': { canView: true, canDownloadOriginals: false, analyzedVideos: 5, usableVideos: 5 },
  'agp-empty': { canView: true, canDownloadOriginals: true, analyzedVideos: 1, usableVideos: 0 },
};
/** The ag-go project each video belongs to. */
const IN: Record<string, string> = { [A1]: 'agp-1', [A2]: 'agp-2' };

describe('inputs (real database)', () => {
  let s: RealStudio;
  let root: string;
  let projects: ProjectsController;
  let videos: VideosController;
  let inputs: InputsController;
  const calls: unknown[] = [];

  beforeEach(async () => {
    s = await realStudio();
    root = mkdtempSync(join(tmpdir(), 'inputs-api-'));
    const engine = s.engine as unknown as EngineService;
    const ws = new WorkspaceService({ get: (k: string, d?: unknown) => (k === 'STUDIO_WORKSPACES_ROOT' ? root : d) } as unknown as ConfigService, engine);
    calls.length = 0;
    const footage = {
      access: async (userId: string, ids: string[]) => {
        calls.push(['access', userId, ids]);
        return new Map(ids.filter((id) => ACCESS[id]).map((id) => [id, { projectId: id, ...ACCESS[id]! }]));
      },
      search: async (q: { projectIds: string[] }) => {
        calls.push(['search', q]);
        return { items: [{ assetId: A1, name: 'Hoa Lư 03.mp4', durationMs: 72_400 }], nextCursor: null, total: 1 };
      },
      check: async (projectIds: string[], ids: string[]) => {
        calls.push(['check', projectIds, ids]);
        const ok = ids.filter((i) => projectIds.includes(IN[i] ?? ''));
        return { ok, missing: ids.filter((i) => !ok.includes(i)) };
      },
      searchForPicker: async (q: unknown) => {
        calls.push(['picker', q]);
        return { items: [{ assetId: A1, name: 'Hoa Lư 03.mp4', durationMs: 72_400, tags: ['sông'] }], nextCursor: null, total: 1 };
      },
      facets: async (f: unknown) => {
        calls.push(['facets', f]);
        return {
          tags: [{ value: 'sông', count: 3 }], genres: [], timesOfDay: [], orientations: [], resolutions: [], categories: [], provinces: [], authors: [],
          projects: [{ value: 'agp-1', label: 'Ninh Bình', count: 3 }, { value: 'agp-other', label: 'Không gắn', count: 9 }],
        };
      },
    } as unknown as ProjectFootageService;
    projects = new ProjectsController(engine, ws, NO_DIRECTORY);
    videos = new VideosController(engine, ws);
    inputs = new InputsController(engine, ws, footage, ({ current: () => 'Kho Footage' }) as unknown as SiteNameService, new MediaLibraryService(engine));
    // audio and video go to the bucket (the person's media library); a test that looks at the objects puts its own
    Object.assign(s.engine, { bucket: new MemoryBucket() });
    await insertTeam(s.db, 'team-1', OWNER);
    await s.engine.db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', ?, 'editor', ?)", [EDITOR, new Date().toISOString()]);
  });
  afterEach(async () => { await s.close(); });

  it('adds an ag-go project the person may download the originals of, says why the others cannot be, and searches it whoever asks', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    expect(await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-wm', label: 'Watermark' }, req(EDITOR)).catch(code)).toBe('ag_go_view_only');
    expect(await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-empty', label: 'Rỗng' }, req(EDITOR)).catch(code)).toBe('ag_go_no_videos');
    expect(await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-x', label: 'Không thấy' }, req(EDITOR)).catch(code)).toBe('ag_go_not_visible');
    const { source } = await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-1', label: 'Ninh Bình' }, req(EDITOR));
    expect(source).toMatchObject({ kind: 'ag_go_project', ref: 'agp-1', label: 'Ninh Bình', meta: { videos: 3 }, asset: null });
    expect(calls.at(-1)).toEqual(['access', EDITOR, ['agp-1']]);
    const found = await inputs.footageSearch(p.id, { q: 'thuyền' });
    expect(calls.at(-1)).toEqual(['picker', { projectIds: ['agp-1'], q: 'thuyền', limit: 40 }]);
    expect(found.items[0]).toMatchObject({ assetId: A1, prepared: { state: 'not_prepared' } });
    expect(await inputs.footageSearch(p.id, { agGoProjectId: 'agp-x' }).catch(code)).toBe('not_an_input');
  });

  it('tells the picker, as the person, which ag-go projects they may add', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const r = await inputs.agGoAccess(p.id, { projectIds: ['agp-1', 'agp-wm', 'agp-empty', 'agp-x', 'agp-1'] }, req(EDITOR));
    expect(calls.at(-1)).toEqual(['access', EDITOR, ['agp-1', 'agp-wm', 'agp-empty', 'agp-x']]);
    expect(r.items).toEqual([
      { projectId: 'agp-1', state: 'addable', analyzedVideos: 4, usableVideos: 3 },
      { projectId: 'agp-wm', state: 'view_only', analyzedVideos: 5, usableVideos: 5 },
      { projectId: 'agp-empty', state: 'no_videos', analyzedVideos: 1, usableVideos: 0 },
      { projectId: 'agp-x', state: 'not_visible', analyzedVideos: 0, usableVideos: 0 },
    ]);
    expect(await inputs.agGoAccess(p.id, { projectIds: [] }, req(EDITOR)).catch(code)).toBe('invalid');
  });

  it("filters, sorts and pages the picker within the project's ag-go projects; facets list only those projects", async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    expect(await inputs.footageSearch(p.id, {})).toEqual({ items: [], nextCursor: null, total: 0 });
    expect((await inputs.footageFacets(p.id, {})).projects).toEqual([]);
    await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-1', label: 'Ninh Bình' }, req(EDITOR));
    await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-2', label: 'Hà Giang' }, req(EDITOR));
    await inputs.footageSearch(p.id, {
      agGoProjectIds: 'agp-2', tags: 'sông,núi', resolutions: '4k', orientations: 'landscape', minDurationMs: '5000', usability: 'all',
      sortBy: 'duration', sortOrder: 'asc', page: '2', limit: '20',
    });
    expect(calls.at(-1)).toEqual(['picker', {
      projectIds: ['agp-2'], tags: ['sông', 'núi'], resolutions: ['4k'], orientations: ['landscape'], minDurationMs: 5000, usability: 'all',
      sortBy: 'duration', sortOrder: 'asc', page: 2, limit: 20,
    }]);
    expect(await inputs.footageSearch(p.id, { agGoProjectIds: 'agp-1,agp-x' }).catch(code)).toBe('not_an_input');
    expect(await inputs.footageSearch(p.id, { resolutions: '8k' }).catch(code)).toBe('invalid');
    expect(await inputs.footageSearch(p.id, { folderIds: 'f1' }).catch(code)).toBe('invalid');

    const facets = await inputs.footageFacets(p.id, { tags: 'sông', page: '3', sortBy: 'name' });
    expect(calls.at(-1)).toEqual(['facets', { projectIds: ['agp-1', 'agp-2'], tags: ['sông'] }]);
    expect(facets.tags).toEqual([{ value: 'sông', count: 3 }]);
    expect(facets.projects).toEqual([{ value: 'agp-1', label: 'Ninh Bình', count: 3 }, { value: 'agp-2', label: 'Hà Giang', count: null }]);
  });

  it("adds an ag-go video to a video (its index follows), prepares it, lists and stops the job; the video's thread hears of it", async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Tràng An' }, req(OWNER));
    expect(await inputs.add(p.id, { kind: 'ag_go_asset', ref: A1, label: 'A', videoId: v.id }, req(EDITOR)).catch(code)).toBe('no_ag_go_project');
    await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-1', label: 'Ninh Bình' }, req(EDITOR));
    expect(await inputs.add(p.id, { kind: 'ag_go_asset', ref: A2, label: 'B', videoId: v.id }, req(EDITOR)).catch(code)).toBe('not_in_added_project');
    expect(calls.at(-1)).toEqual(['check', ['agp-1'], [A2]]);
    const added = await inputs.add(p.id, { kind: 'ag_go_asset', ref: A1, label: 'Hoa Lư 03.mp4', videoId: v.id, meta: { durationMs: 72_400 }, prepare: true }, req(EDITOR));
    expect(added.source).toMatchObject({ kind: 'ag_go_asset', videoId: v.id, asset: { state: 'queued' } });
    const jobId = (added.prepare as { job_id: string }).job_id;
    expect(await getJob(s.engine.db, jobId)).toMatchObject({ kind: 'prepare_asset', thread_id: v.threadId, units: null, continue_agent: false, actor_role: 'editor' });
    const index = JSON.parse(readFileSync(join(root, p.id, 'videos', v.id, 'sources', 'index.json'), 'utf8'));
    expect(index.sources).toEqual([expect.objectContaining({ asset_id: A1, name: 'Hoa Lư 03.mp4', status: 'missing' })]);
    expect((await inputs.prepare(p.id, { assetIds: [A1, A2] }, req(EDITOR))).assets).toEqual({ [A1]: expect.objectContaining({ state: 'queued', job_id: jobId }), [A2]: { state: 'not_an_input' } });
    expect((await inputs.jobs(p.id, '1')).jobs.map((j) => j.id)).toEqual([jobId]);
    await claimJob(s.engine.db, ['prepare_asset'], new Date().toISOString());
    // the list says how many videos stand where (each once), alongside the rows as before
    expect((await inputs.sources(p.id)).counts).toEqual({ videos: 1, ready: 0, preparing: 1, failed: 0, notPrepared: 0 });
    expect((await inputs.sources(p.id, v.id)).sources.filter((x) => x.kind === 'ag_go_asset').map((x) => x.asset?.state)).toEqual(['preparing']);
    expect(await inputs.cancel(p.id, jobId)).toMatchObject({ status: 'running', cancelRequested: true });
    expect(await inputs.cancel('other', jobId).catch(code)).toBe('not_found');
    expect(await listMessages(s.engine.db, v.threadId)).toEqual([]);
    await inputs.remove(p.id, added.source.id, undefined, req(EDITOR));
    expect(JSON.parse(readFileSync(join(root, p.id, 'videos', v.id, 'sources', 'index.json'), 'utf8')).sources).toEqual([]);
  });

  it('asks before removing an ag-go project whose videos are used and in no other project of it', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Tràng An' }, req(OWNER));
    const one = (await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-1', label: 'Ninh Bình' }, req(EDITOR))).source;
    const two = (await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-2', label: 'Hà Giang' }, req(EDITOR))).source;
    await inputs.add(p.id, { kind: 'ag_go_asset', ref: A1, label: 'Hoa Lư 03.mp4', videoId: v.id }, req(EDITOR));
    await inputs.remove(p.id, two.id, undefined, req(EDITOR));
    const refused = await inputs.remove(p.id, one.id, undefined, req(EDITOR)).catch((e: { getResponse: () => unknown }) => e.getResponse());
    expect(refused).toMatchObject({ code: 'project_in_use', assets: 1, videos: ['Tràng An'] });
    expect(calls.at(-1)).toEqual(['check', [], [A1]]);
    await inputs.remove(p.id, one.id, '1', req(EDITOR));
    expect((await inputs.sources(p.id)).sources.map((x) => x.kind)).toEqual(['ag_go_asset']);
  });

  it('names videos the agent added without a name, from the picked ag-go projects, when the sources are listed', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-1', label: 'Ninh Bình' }, req(EDITOR));
    await addSource(s.engine.db, { projectId: p.id, kind: 'ag_go_asset', ref: A1, mediaType: 'video', label: A1, addedBy: OWNER });
    expect((await inputs.sources(p.id)).sources.find((x) => x.ref === A1)?.label).toBe(A1);
    await inputs.naming;
    expect(calls.at(-1)).toEqual(['search', { projectIds: ['agp-1'], limit: 100 }]);
    expect((await inputs.sources(p.id)).sources.find((x) => x.ref === A1)?.label).toBe('Hoa Lư 03.mp4');
    const searches = calls.length;
    await inputs.sources(p.id);
    expect(calls).toHaveLength(searches);
  });

  it('uploads documents, images and audio into context/ by kind; refuses Word and video files', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const tmp = (name: string, body: string) => { const path = join(mkdtempSync(join(tmpdir(), 'up-')), name); writeFileSync(path, body); return { path, originalname: name, size: body.length }; };
    const doc = await inputs.upload(p.id, {}, tmp('Ghi chú.md', '# Ghi chú'), req(EDITOR));
    expect(doc.source).toMatchObject({ kind: 'upload', ref: 'context/uploads/Ghi chú.md', mediaType: 'document', label: 'Ghi chú.md' });
    const img = await inputs.upload(p.id, {}, tmp('logo.PNG', 'x'), req(EDITOR));
    expect(img.source).toMatchObject({ ref: 'context/images/logo.PNG', mediaType: 'image' });
    const again = await inputs.upload(p.id, {}, tmp('Ghi chú.md', '# 2'), req(EDITOR));
    expect(again.source.ref).toBe('context/uploads/Ghi chú (2).md');
    expect(existsSync(join(root, p.id, 'context', 'images', 'logo.PNG'))).toBe(true);
    expect(await inputs.upload(p.id, {}, tmp('a.docx', 'x'), req(EDITOR)).catch(code)).toBe('docx_not_supported');
    expect(await inputs.upload(p.id, {}, tmp('a.mp4', 'x'), req(EDITOR)).catch(code)).toBe('video_from_ag_go');
    expect((await inputs.sources(p.id)).sources.map((x) => x.ref)).toEqual(['context/uploads/Ghi chú.md', 'context/images/logo.PNG', 'context/uploads/Ghi chú (2).md']);
  });

  it('a reference video (to learn an edit style from) goes to context/references/, up to 300 MB; only videos', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const tmp = (name: string, body: string, size = body.length) => { const path = join(mkdtempSync(join(tmpdir(), 'up-')), name); writeFileSync(path, body); return { path, originalname: name, size }; };
    const ref = await inputs.upload(p.id, { reference: '1' }, tmp('Kênh mẫu.mp4', 'video'), req(EDITOR));
    expect(ref.source).toMatchObject({ kind: 'upload', ref: 'context/references/Kênh mẫu.mp4', mediaType: 'video', meta: { reference: true, bytes: 5 } });
    expect(ref.source.mediaId).toEqual(expect.any(String));
    // the person's media library holds it, the server's disk does not
    expect(existsSync(join(root, p.id, 'context', 'references', 'Kênh mẫu.mp4'))).toBe(false);
    // 80 MB: too big for a document, fine for a reference video
    expect((await inputs.upload(p.id, { reference: 'true' }, tmp('b.mov', 'x', 80 * 1024 * 1024), req(EDITOR))).source.ref).toBe('context/references/b.mov');
    expect(await inputs.upload(p.id, {}, tmp('big.pdf', 'x', 80 * 1024 * 1024), req(EDITOR)).catch(code)).toBe('file_too_large');
    expect(await inputs.upload(p.id, { reference: '1' }, tmp('huge.mp4', 'x', 301 * 1024 * 1024), req(EDITOR)).catch(code)).toBe('file_too_large');
    expect(await inputs.upload(p.id, { reference: '1' }, tmp('notes.md', 'x'), req(EDITOR)).catch(code)).toBe('not_video');
  });

  it('audio uploads go up to 300 MB (a whole music track); other files stay at 50 MB', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const tmp = (name: string, size: number) => { const path = join(mkdtempSync(join(tmpdir(), 'up-')), name); writeFileSync(path, 'x'); return { path, originalname: name, size }; };
    const music = await inputs.upload(p.id, {}, tmp('Nhạc nền.MP3', 80 * 1024 * 1024), req(EDITOR));
    expect(music.source).toMatchObject({ ref: 'context/audio/Nhạc nền.MP3', mediaType: 'audio', mediaId: expect.any(String) });
    expect(existsSync(join(root, p.id, 'context', 'audio', 'Nhạc nền.MP3'))).toBe(false);
    expect(await inputs.upload(p.id, {}, tmp('dai.wav', 301 * 1024 * 1024), req(EDITOR)).catch(code)).toBe('file_too_large');
    expect(await inputs.upload(p.id, {}, tmp('anh.png', 60 * 1024 * 1024), req(EDITOR)).catch(code)).toBe('file_too_large');
  });

  it('a file put straight on the bucket: checked before the link is signed, taken by its key, then removed there', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const bucket = new MemoryBucket();
    Object.assign(s.engine, { bucket });
    expect(await inputs.signUpload(p.id, { purpose: 'source', name: 'a.docx', size: 10 }, req(EDITOR)).catch(code)).toBe('docx_not_supported');
    expect(await inputs.signUpload(p.id, { purpose: 'source', name: 'dai.wav', size: 301 * 1024 * 1024 }, req(EDITOR)).catch(code)).toBe('file_too_large');
    // prod 23/10: a 10-minute WAV track, refused at the old 100 MB
    expect(await inputs.signUpload(p.id, { purpose: 'source', name: 'Pale Afternoon.wav', size: 113_909_824, contentType: 'audio/wav' }, req(EDITOR))).toMatchObject({ key: expect.any(String) });
    expect(await inputs.signUpload(p.id, { purpose: 'reference', name: 'notes.md', size: 10 }, req(EDITOR)).catch(code)).toBe('not_video');
    const link = await inputs.signUpload(p.id, { purpose: 'source', name: 'Nhạc nền.mp3', size: 3, contentType: 'audio/mpeg' }, req(EDITOR));
    expect(link).toMatchObject({ contentType: 'audio/mpeg', url: `memory://${link.key}?put=audio%2Fmpeg` });
    // audio goes into the person's media library, and stays there
    expect(link.key).toMatch(/^library\/studio\/users\/auth0_editor-[0-9a-f]{10}\/media\/[0-9a-f-]{36}\.mp3$/);
    await bucket.put(link.key, Buffer.from('mp3'));
    const up = await inputs.upload(p.id, { uploadKey: link.key, name: 'Nhạc nền.mp3', videoId: undefined }, undefined, req(EDITOR));
    expect(up.source).toMatchObject({ ref: 'context/audio/Nhạc nền.mp3', mediaType: 'audio', meta: { bytes: 3, key: link.key } });
    expect(existsSync(join(root, p.id, 'context', 'audio', 'Nhạc nền.mp3'))).toBe(false);
    expect(bucket.objects.has(link.key)).toBe(true);
    // someone else's library key is not taken
    expect(await inputs.upload(p.id, { uploadKey: link.key, name: 'x.mp3' }, undefined, req(OWNER)).catch(code)).toBe('upload_key');
    // a document still goes through the raw uploads, onto the disk
    const doc = await inputs.signUpload(p.id, { purpose: 'source', name: 'Kịch bản.md', size: 3 }, req(EDITOR));
    expect(doc.key.startsWith(`uploads/${p.id}/`)).toBe(true);
    await bucket.put(doc.key, Buffer.from('# A'));
    expect((await inputs.upload(p.id, { uploadKey: doc.key, name: 'Kịch bản.md' }, undefined, req(EDITOR))).source.ref).toBe('context/uploads/Kịch bản.md');
    expect(readFileSync(join(root, p.id, 'context', 'uploads', 'Kịch bản.md'), 'utf8')).toBe('# A');
    expect(bucket.objects.has(doc.key)).toBe(false);

    // a reference video, by JSON
    const ref = await inputs.signUpload(p.id, { purpose: 'reference', name: 'Mẫu.mp4', size: 5 }, req(EDITOR));
    await bucket.put(ref.key, Buffer.from('video'));
    expect((await inputs.upload(p.id, { uploadKey: ref.key, name: 'Mẫu.mp4', reference: true }, undefined, req(EDITOR))).source.ref).toBe('context/references/Mẫu.mp4');

    // another project's key, a key that is not an upload, a missing object, a name left out
    const other = 'uploads/other-project/0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11';
    await bucket.put(other, Buffer.from('x'));
    expect(await inputs.upload(p.id, { uploadKey: other, name: 'a.md' }, undefined, req(EDITOR)).catch(code)).toBe('upload_key');
    expect(bucket.objects.has(other)).toBe(true);
    expect(await inputs.upload(p.id, { uploadKey: 'library/music/a.m4a', name: 'a.md' }, undefined, req(EDITOR)).catch(code)).toBe('upload_key');
    const gone = await inputs.signUpload(p.id, { purpose: 'source', name: 'a.md', size: 1 }, req(EDITOR));
    expect(await inputs.upload(p.id, { uploadKey: gone.key, name: 'a.md' }, undefined, req(EDITOR)).catch(code)).toBe('upload_missing');
    expect(await inputs.upload(p.id, { uploadKey: gone.key }, undefined, req(EDITOR)).catch(code)).toBe('name_missing');

    // larger on the bucket than the browser said: refused by its real size, and dropped
    const liar = await inputs.signUpload(p.id, { purpose: 'source', name: 'b.pdf', size: 1 }, req(EDITOR));
    await bucket.put(liar.key, Buffer.alloc(51 * 1024 * 1024));
    expect(await inputs.upload(p.id, { uploadKey: liar.key, name: 'b.pdf' }, undefined, req(EDITOR)).catch(code)).toBe('file_too_large');
    expect(bucket.objects.has(liar.key)).toBe(false);
  });

  it('footage from the computer: a video or photo put where footage is kept, added to the video and prepared at once', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Tràng An' }, req(OWNER));
    const bucket = new MemoryBucket();
    Object.assign(s.engine, { bucket });
    expect(await inputs.signUpload(p.id, { purpose: 'footage', name: 'ghi chú.pdf', size: 10 }, req(EDITOR)).catch(code)).toBe('file_type');
    expect(await inputs.signUpload(p.id, { purpose: 'footage', name: 'dai.mov', size: 5 * 1024 ** 3 }, req(EDITOR)).catch(code)).toBe('file_too_large');
    expect(await inputs.signUpload(p.id, { purpose: 'footage', name: 'anh.png', size: 60 * 1024 ** 2 }, req(EDITOR)).catch(code)).toBe('file_too_large');
    // no ag-go project needed: the file is Studio's
    const link = await inputs.signUpload(p.id, { purpose: 'footage', name: 'Hang Múa.MOV', size: 5, contentType: 'video/quicktime' }, req(EDITOR));
    expect(link.key).toMatch(/^library\/studio\/users\/auth0_editor-[0-9a-f]{10}\/media\/[0-9a-f-]{36}\.mov$/);
    await bucket.put(link.key, Buffer.from('movie'));
    const r = await inputs.addFootage(p.id, { uploadKey: link.key, name: 'Hang Múa.MOV', videoId: v.id }, req(EDITOR));
    expect(r.source).toMatchObject({ kind: 'upload_asset', mediaType: 'video', label: 'Hang Múa.MOV', videoId: v.id, meta: { key: link.key, bytes: 5 } });
    expect(r.source.mediaId).toBe(r.source.ref);
    expect(r.prepare).toMatchObject({ state: 'queued', job_id: expect.any(String) });
    // the file stays where it is: renders read it from there
    expect(bucket.objects.has(link.key)).toBe(true);
    const index = JSON.parse(readFileSync(join(root, p.id, 'videos', v.id, 'sources', 'index.json'), 'utf8'));
    expect(index.sources).toMatchObject([{ asset_id: r.source.ref, name: 'Hang Múa.MOV', status: 'missing' }]);
    // a key of another project, or one never put
    expect(await inputs.addFootage(p.id, { uploadKey: link.key, name: 'x.mov', videoId: v.id }, req(OWNER)).catch(code)).toBe('upload_key');
    expect(await inputs.addFootage(p.id, { uploadKey: `library/studio/projects/other/footage/${r.source.ref}.mov`, name: 'x.mov', videoId: v.id }, req(EDITOR)).catch(code)).toBe('upload_key');
    const never = await inputs.signUpload(p.id, { purpose: 'footage', name: 'x.jpg', size: 1 }, req(EDITOR));
    expect(await inputs.addFootage(p.id, { uploadKey: never.key, name: 'x.jpg', videoId: v.id }, req(EDITOR)).catch(code)).toBe('upload_missing');
    // a video still goes to the Footage section, not to context/
    expect(await inputs.signUpload(p.id, { purpose: 'source', name: 'a.mp4', size: 10 }, req(EDITOR)).catch(code)).toBe('video_from_ag_go');
  });
});
