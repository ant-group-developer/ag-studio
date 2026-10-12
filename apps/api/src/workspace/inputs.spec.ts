/**
 * The Inputs tab routes over a real studio.db and folder: ag-go projects and videos are added only when the project's
 * owner can use them, uploads land in context/ by kind, preparing queues one background job per video, the agent's
 * jobs list and stop, and the video's sources index follows.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { addSource, claimJob, getJob, listMessages } from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import type { SiteNameService } from '../ag-go/site-name.service';
import { InputsController } from './inputs.controller';
import type { ProjectFootageService } from './project-footage.service';
import { ProjectsController } from './projects.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const OWNER = 'auth0|owner';
const EDITOR = 'auth0|editor';
const A1 = '0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11';
const A2 = '1c8b6d45-6e2f-4e5d-8b62-4e3b2f1d8e22';
const code = (e: unknown) => (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? String(e);

describe('inputs (real studio.db)', () => {
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
      search: async (actAs: string, q: { projectIds: string[] }) => {
        calls.push(['search', actAs, q]);
        if (q.projectIds.includes('agp-empty')) return { items: [], nextCursor: null, total: 0 };
        return { items: [{ assetId: A1, name: 'Hoa Lư 03.mp4', durationMs: 72_400 }], nextCursor: null, total: 1 };
      },
      check: async (actAs: string, ids: string[]) => { calls.push(['check', actAs, ids]); return { ok: ids.filter((i) => i !== A2), missing: ids.filter((i) => i === A2) }; },
      searchForPicker: async (actAs: string, q: unknown) => {
        calls.push(['picker', actAs, q]);
        return { items: [{ assetId: A1, name: 'Hoa Lư 03.mp4', durationMs: 72_400, tags: ['sông'] }], nextCursor: null, total: 1 };
      },
      facets: async (actAs: string, f: unknown) => {
        calls.push(['facets', actAs, f]);
        return {
          tags: [{ value: 'sông', count: 3 }], genres: [], timesOfDay: [], orientations: [], resolutions: [], categories: [], provinces: [], authors: [],
          projects: [{ value: 'agp-1', label: 'Ninh Bình', count: 3 }, { value: 'agp-other', label: 'Không gắn', count: 9 }],
        };
      },
    } as unknown as ProjectFootageService;
    projects = new ProjectsController(engine, ws);
    videos = new VideosController(engine, ws);
    inputs = new InputsController(engine, ws, footage, ({ current: () => 'Kho Footage' }) as unknown as SiteNameService);
    insertTeam(s.db, 'team-1', OWNER);
    s.engine.db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', ?, 'editor', ?)", [EDITOR, new Date().toISOString()]);
  });
  afterEach(() => s.close());

  it("adds an ag-go project the owner sees, refuses one they don't, and searches it as the person", async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    expect(await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-empty', label: 'Rỗng' }, req(EDITOR)).catch(code)).toBe('owner_cannot_access');
    const { source } = await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-1', label: 'Ninh Bình' }, req(EDITOR));
    expect(source).toMatchObject({ kind: 'ag_go_project', ref: 'agp-1', label: 'Ninh Bình', meta: { videos: 1 }, asset: null });
    expect(calls.at(-1)).toEqual(['search', OWNER, { projectIds: ['agp-1'], limit: 1 }]);
    const found = await inputs.footageSearch(p.id, { q: 'thuyền' }, req(EDITOR));
    expect(calls.at(-1)).toEqual(['picker', EDITOR, { projectIds: ['agp-1'], q: 'thuyền', limit: 40 }]);
    expect(found.items[0]).toMatchObject({ assetId: A1, prepared: { state: 'not_prepared' } });
    expect(await inputs.footageSearch(p.id, { agGoProjectId: 'agp-x' }, req(EDITOR)).catch(code)).toBe('not_an_input');
  });

  it("filters, sorts and pages the picker within the project's ag-go projects; facets list only those projects", async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    expect(await inputs.footageSearch(p.id, {}, req(EDITOR))).toEqual({ items: [], nextCursor: null, total: 0 });
    expect((await inputs.footageFacets(p.id, {}, req(EDITOR))).projects).toEqual([]);
    await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-1', label: 'Ninh Bình' }, req(EDITOR));
    await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-2', label: 'Hà Giang' }, req(EDITOR));
    await inputs.footageSearch(p.id, {
      agGoProjectIds: 'agp-2', tags: 'sông,núi', resolutions: '4k', orientations: 'landscape', minDurationMs: '5000', usability: 'all',
      sortBy: 'duration', sortOrder: 'asc', page: '2', limit: '20',
    }, req(EDITOR));
    expect(calls.at(-1)).toEqual(['picker', EDITOR, {
      projectIds: ['agp-2'], tags: ['sông', 'núi'], resolutions: ['4k'], orientations: ['landscape'], minDurationMs: 5000, usability: 'all',
      sortBy: 'duration', sortOrder: 'asc', page: 2, limit: 20,
    }]);
    expect(await inputs.footageSearch(p.id, { agGoProjectIds: 'agp-1,agp-x' }, req(EDITOR)).catch(code)).toBe('not_an_input');
    expect(await inputs.footageSearch(p.id, { resolutions: '8k' }, req(EDITOR)).catch(code)).toBe('invalid');
    expect(await inputs.footageSearch(p.id, { folderIds: 'f1' }, req(EDITOR)).catch(code)).toBe('invalid');

    const facets = await inputs.footageFacets(p.id, { tags: 'sông', page: '3', sortBy: 'name' }, req(EDITOR));
    expect(calls.at(-1)).toEqual(['facets', EDITOR, { projectIds: ['agp-1', 'agp-2'], tags: ['sông'] }]);
    expect(facets.tags).toEqual([{ value: 'sông', count: 3 }]);
    expect(facets.projects).toEqual([{ value: 'agp-1', label: 'Ninh Bình', count: 3 }, { value: 'agp-2', label: 'Hà Giang', count: null }]);
  });

  it("adds an ag-go video to a video (its index follows), prepares it, lists and stops the job; the video's thread hears of it", async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Tràng An' }, req(OWNER));
    expect(await inputs.add(p.id, { kind: 'ag_go_asset', ref: A2, label: 'B', videoId: v.id }, req(EDITOR)).catch(code)).toBe('owner_cannot_access');
    const added = await inputs.add(p.id, { kind: 'ag_go_asset', ref: A1, label: 'Hoa Lư 03.mp4', videoId: v.id, meta: { durationMs: 72_400 }, prepare: true }, req(EDITOR));
    expect(added.source).toMatchObject({ kind: 'ag_go_asset', videoId: v.id, asset: { state: 'queued' } });
    const jobId = (added.prepare as { job_id: string }).job_id;
    expect(getJob(s.engine.db, jobId)).toMatchObject({ kind: 'prepare_asset', thread_id: v.threadId, units: 72.4, continue_agent: 0, actor_role: 'editor' });
    const index = JSON.parse(readFileSync(join(root, p.id, 'videos', v.id, 'sources', 'index.json'), 'utf8'));
    expect(index.sources).toEqual([expect.objectContaining({ asset_id: A1, name: 'Hoa Lư 03.mp4', status: 'missing' })]);
    expect((await inputs.prepare(p.id, { assetIds: [A1, A2] }, req(EDITOR))).assets).toEqual({ [A1]: expect.objectContaining({ state: 'queued', job_id: jobId }), [A2]: { state: 'not_an_input' } });
    expect((await inputs.jobs(p.id, '1')).jobs.map((j) => j.id)).toEqual([jobId]);
    claimJob(s.engine.db, ['prepare_asset'], new Date().toISOString());
    expect(await inputs.cancel(p.id, jobId)).toMatchObject({ status: 'running', cancelRequested: true });
    expect(await inputs.cancel('other', jobId).catch(code)).toBe('not_found');
    expect(listMessages(s.engine.db, v.threadId)).toEqual([]);
    await inputs.remove(p.id, added.source.id);
    expect(JSON.parse(readFileSync(join(root, p.id, 'videos', v.id, 'sources', 'index.json'), 'utf8')).sources).toEqual([]);
  });

  it('names videos the agent added without a name, from the picked ag-go projects, when the sources are listed', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    await inputs.add(p.id, { kind: 'ag_go_project', ref: 'agp-1', label: 'Ninh Bình' }, req(EDITOR));
    addSource(s.engine.db, { projectId: p.id, kind: 'ag_go_asset', ref: A1, mediaType: 'video', label: A1, addedBy: OWNER });
    expect((await inputs.sources(p.id)).sources.find((x) => x.ref === A1)?.label).toBe(A1);
    await inputs.naming;
    expect(calls.at(-1)).toEqual(['search', OWNER, { projectIds: ['agp-1'], limit: 100 }]);
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
    expect(ref.source).toMatchObject({ kind: 'upload', ref: 'context/references/Kênh mẫu.mp4', mediaType: 'video', meta: { reference: true } });
    expect(existsSync(join(root, p.id, 'context', 'references', 'Kênh mẫu.mp4'))).toBe(true);
    // 80 MB: too big for a document, fine for a reference video
    expect((await inputs.upload(p.id, { reference: 'true' }, tmp('b.mov', 'x', 80 * 1024 * 1024), req(EDITOR))).source.ref).toBe('context/references/b.mov');
    expect(await inputs.upload(p.id, {}, tmp('big.pdf', 'x', 80 * 1024 * 1024), req(EDITOR)).catch(code)).toBe('file_too_large');
    expect(await inputs.upload(p.id, { reference: '1' }, tmp('huge.mp4', 'x', 301 * 1024 * 1024), req(EDITOR)).catch(code)).toBe('file_too_large');
    expect(await inputs.upload(p.id, { reference: '1' }, tmp('notes.md', 'x'), req(EDITOR)).catch(code)).toBe('not_video');
  });
});
