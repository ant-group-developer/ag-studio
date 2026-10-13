/**
 * Projects, videos and workspace files over a real studio.db and a real folder: creating a project seeds its
 * workspace (versioned as Studio's), a person edits CLAUDE.md against the copy they saw, uploads keep their name,
 * hidden folders stay hidden, and every change has a version to restore.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { MemoryBucket } from '@ag-studio/engine';
import { insertTeam, NO_DIRECTORY, realStudio, type RealStudio } from '../test/real-studio';
import type { AccountDirectoryService } from '../auth/account-directory.service';
import type { EngineService } from '../studio/engine.service';
import { FileLinkService } from './file-links';
import { FilesController, safeFileName } from './files.controller';
import { ProjectsController } from './projects.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const OWNER = 'auth0|owner';

async function failure(p: Promise<unknown> | (() => unknown)) {
  try { await (typeof p === 'function' ? p() : p); } catch (e) {
    const body = (e as { getResponse?: () => { code?: string } }).getResponse?.() ?? {};
    return `${(e as Error).constructor.name}:${body.code ?? ''}`;
  }
  return null;
}

describe('workspace routes (real studio.db and folder)', () => {
  let s: RealStudio;
  let root: string;
  let projects: ProjectsController;
  let videos: VideosController;
  let files: FilesController;

  beforeEach(async () => {
    s = await realStudio();
    root = mkdtempSync(join(tmpdir(), 'ws-api-'));
    const engine = s.engine as unknown as EngineService;
    const ws = new WorkspaceService({ get: (k: string, d?: unknown) => (k === 'STUDIO_WORKSPACES_ROOT' ? root : d) } as unknown as ConfigService, engine);
    projects = new ProjectsController(engine, ws, NO_DIRECTORY);
    videos = new VideosController(engine, ws);
    files = new FilesController(engine, ws, new FileLinkService({ get: () => 's'.repeat(32) } as unknown as ConfigService));
    insertTeam(s.db, 'team-1', OWNER);
  });
  afterEach(() => s.close());

  it('creates a project with its workspace, lists it, edits it and archives it', async () => {
    expect(await failure(projects.create('team-1', { name: ' ' }, req(OWNER)))).toBe('BadRequestException:invalid');
    const p = await projects.create('team-1', { name: 'Du lịch Việt', channelUrl: '@dulichviet', description: 'Đi bộ chậm' }, req(OWNER));
    expect(p).toMatchObject({ teamId: 'team-1', name: 'Du lịch Việt', aspect: '16:9', settings: { auto_fix: true } });
    expect(readFileSync(join(root, p.id, 'CLAUDE.md'), 'utf8')).toContain('Đi bộ chậm');
    const claudeVersions = await files.versions(p.id, 'CLAUDE.md');
    expect(claudeVersions.versions.map((v) => v.author_kind)).toEqual(['studio']);

    expect((await projects.list('team-1')).projects.map((x) => [x.name, x.videoCount])).toEqual([['Du lịch Việt', 0]]);
    const edited = await projects.update(p.id, { description: 'Kênh du lịch chậm', settings: { model: 'sonnet' } });
    expect(edited).toMatchObject({ description: 'Kênh du lịch chậm', settings: { model: 'sonnet', auto_fix: true } });
    expect(await failure(projects.update(p.id, { colour: 'red' }))).toBe('BadRequestException:invalid');
    await projects.archive(p.id);
    expect((await projects.list('team-1')).projects).toEqual([]);
    expect(await failure(projects.get('nope'))).toBe('NotFoundException:not_found');
  });

  it('lists each project with who made it: name and avatar from the Account API, or only the id when it does not know them', async () => {
    const people = new Map([[OWNER, { userId: OWNER, name: 'Chủ nhóm', email: 'owner@ant-group.net', avatar: 'https://a/x.png' }]]);
    const asked: string[][] = [];
    const named = new ProjectsController(s.engine as unknown as EngineService, new WorkspaceService({ get: (k: string, d?: unknown) => (k === 'STUDIO_WORKSPACES_ROOT' ? root : d) } as unknown as ConfigService, s.engine as unknown as EngineService),
      { summaries: async (ids: string[]) => { asked.push(ids); return people; } } as unknown as AccountDirectoryService);
    await named.create('team-1', { name: 'A' }, req(OWNER));
    await named.create('team-1', { name: 'B' }, req('auth0|gone'));
    const listed = (await named.list('team-1')).projects;
    expect(Object.fromEntries(listed.map((p) => [p.name, p.creator]))).toEqual({
      A: { userId: OWNER, name: 'Chủ nhóm', email: 'owner@ant-group.net', avatar: 'https://a/x.png' },
      B: { userId: 'auth0|gone', name: null, email: null, avatar: null },
    });
    expect(asked).toHaveLength(1);
  });

  it('adds videos one at a time, each with its folder and a number', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v1 = await videos.create(p.id, {}, req(OWNER));
    const v2 = await videos.create(p.id, { title: 'Hội An mưa' }, req(OWNER));
    expect([v1.title, v1.idx, v2.title, v2.idx]).toEqual(['Video 1', 1, 'Hội An mưa', 2]);
    expect(existsSync(join(root, p.id, 'videos', v1.id))).toBe(true);
    expect((await projects.get(p.id)).videos.map((v) => v.idx)).toEqual([2, 1]);
    expect(await videos.update(v1.id, { status: 'in_progress' })).toMatchObject({ status: 'in_progress' });
    expect(await failure(videos.update(v1.id, { status: 'published' }))).toBe('BadRequestException:invalid');
    await videos.archive(v1.id);
    expect((await videos.list(p.id)).videos.map((v) => v.idx)).toEqual([2]);
  });

  it('saves a file against the copy the person saw, keeps versions, and restores one', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const current = await files.content(p.id, 'CLAUDE.md', req(OWNER));
    const saved = await files.write(p.id, { path: 'CLAUDE.md', content: `${current.text}\n- Không dùng nhạc buồn.\n`, baseSha256: current.sha256 }, req(OWNER));
    expect(await failure(files.write(p.id, { path: 'CLAUDE.md', content: 'cũ', baseSha256: current.sha256 }, req(OWNER)))).toBe('ConflictException:file_conflict');
    expect(await failure(files.write(p.id, { path: '.studio/status.json', content: '{}' }, req(OWNER)))).toBe('UnprocessableEntityException:read_only');
    expect(await failure(files.write(p.id, { path: '../x.md', content: 'x' }, req(OWNER)))).toBe('UnprocessableEntityException:bad_path');

    const { versions } = await files.versions(p.id, 'CLAUDE.md');
    expect(versions.map((v) => v.author_kind)).toEqual(['user', 'studio']);
    const restored = await files.restore(p.id, versions[1]!.id, { baseSha256: saved.sha256 }, req(OWNER));
    expect(restored.sha256).toBe(current.sha256);
  });

  it('shows what a version changed against the one before it or a chosen base', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const current = await files.content(p.id, 'CLAUDE.md', req(OWNER));
    const saved = await files.write(p.id, { path: 'CLAUDE.md', content: `${current.text}\n- Không dùng nhạc buồn.\n`, baseSha256: current.sha256 }, req(OWNER));
    const d = await files.diff(p.id, saved.versionId);
    expect(d).toMatchObject({ path: 'CLAUDE.md', version_id: saved.versionId, added: 2, removed: 0 });
    expect('hunks' in d && d.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['', '- Không dùng nhạc buồn.']);
    const { versions } = await files.versions(p.id, 'CLAUDE.md');
    expect(await files.diff(p.id, saved.versionId, versions[1]!.id)).toMatchObject({ before_version_id: versions[1]!.id });
    expect(await files.diff(p.id, saved.versionId, 'none')).toMatchObject({ before_version_id: null, removed: 0 });
    const upload = await files.write(p.id, { path: 'context/a.md', content: 'x\n' }, req(OWNER));
    expect(await failure(files.diff(p.id, saved.versionId, upload.versionId))).toBe('UnprocessableEntityException:bad_base');
    expect(await failure(files.diff(p.id, 'nope'))).toBe('NotFoundException:not_found');
  });

  it('lists the tree without hidden folders and refuses to read them', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    mkdirSync(join(root, p.id, '.claude'), { recursive: true });
    writeFileSync(join(root, p.id, '.claude', 'settings.json'), '{}');
    const { entries } = await files.tree(p.id);
    expect(entries.some((e) => e.path.startsWith('.claude'))).toBe(false);
    expect(entries.find((e) => e.path === 'CLAUDE.md')?.access).toBe('write');
    expect(await failure(files.content(p.id, '.claude/settings.json', req(OWNER)))).toBe('NotFoundException:not_found');
  });

  it('uploads into context/uploads under the given name, numbering a second copy', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const tmp = mkdtempSync(join(tmpdir(), 'up-'));
    const upload = (name: string) => {
      const path = join(tmp, `${Math.random()}`);
      writeFileSync(path, '# Kịch bản mẫu\n');
      return { path, originalname: name, size: 16 };
    };
    const first = await files.upload(p.id, {}, upload('Kịch bản.md'), req(OWNER));
    const second = await files.upload(p.id, {}, upload('Kịch bản.md'), req(OWNER));
    expect([first.path, second.path]).toEqual(['context/uploads/Kịch bản.md', 'context/uploads/Kịch bản (2).md']);
    expect(await failure(files.upload(p.id, {}, undefined, req(OWNER)))).toBe('BadRequestException:file_missing');
    const res = { setHeader: () => undefined } as unknown as Response;
    expect((await files.raw(p.id, 'context/uploads/Kịch bản.md', res)).getStream()).toBeDefined();
  });

  it('tells a file that is not text from its size alone, with a link to play it, and streams its bytes', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    mkdirSync(join(root, p.id, 'context', 'clips'), { recursive: true });
    writeFileSync(join(root, p.id, 'context', 'clips', 'Hội An.mp4'), Buffer.alloc(4096, 7));
    const video = await files.content(p.id, 'context/clips/Hội An.mp4', req(OWNER));
    expect(video).toMatchObject({ path: 'context/clips/Hội An.mp4', size: 4096, mime: 'video/mp4', binary: true, text: null, sha256: null, issues: [] });
    expect(video.streamUrl?.startsWith(`/api/projects/${p.id}/files/stream?path=context%2Fclips%2FH%E1%BB%99i%20An.mp4&t=`)).toBe(true);
    // a text file is as before: read whole, with its checksum, and no link
    expect(await files.content(p.id, 'CLAUDE.md', req(OWNER))).toMatchObject({ binary: false, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), streamUrl: null });
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as unknown as Response;
    const chunks: Buffer[] = [];
    for await (const c of (await files.raw(p.id, 'context/clips/Hội An.mp4', res)).getStream()) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).length).toBe(4096);
    expect(headers).toMatchObject({ 'Content-Type': 'video/mp4', 'Content-Length': '4096' });
    expect(await failure(files.raw(p.id, 'context/clips/khong.mp4', res))).toBe('NotFoundException:not_found');
  });

  it('takes a file the browser put on the bucket by its key, then removes it there', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const bucket = new MemoryBucket();
    Object.assign(s.engine, { bucket });
    const key = `uploads/${p.id}/0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11`;
    await bucket.put(key, Buffer.from('# Ghi chú'));
    const saved = await files.upload(p.id, { uploadKey: key, name: 'Ghi chú.md', dir: 'context/notes' }, undefined, req(OWNER));
    expect(saved.path).toBe('context/notes/Ghi chú.md');
    expect(readFileSync(join(root, p.id, 'context', 'notes', 'Ghi chú.md'), 'utf8')).toBe('# Ghi chú');
    expect(bucket.objects.has(key)).toBe(false);
    expect(await failure(files.upload(p.id, { uploadKey: 'uploads/library/0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11', name: 'a.md' }, undefined, req(OWNER))))
      .toBe('BadRequestException:upload_key');
  });

  it('makes an uploaded name safe', () => {
    expect(safeFileName('C:\\Users\\a\\note:1.md')).toBe('note_1.md');
    expect(safeFileName(Buffer.from('Ghi chú.md', 'utf8').toString('latin1'))).toBe('Ghi chú.md');
    expect(safeFileName('Ghi chú.md')).toBe('Ghi chú.md');
  });
});
