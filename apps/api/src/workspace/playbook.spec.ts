/**
 * Playbook and lessons routes over a real database and folder: a person marks a step's document done (its frontmatter),
 * a file's checks come back when it is read or saved, and a proposed lesson goes into memory/lessons.md on accept.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { listLessonProposals, saveThreadSummary, getThread } from '@ag-studio/engine';
import { insertTeam, NO_DIRECTORY, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import { FileLinkService } from './file-links';
import { FilesController } from './files.controller';
import { PlaybookController } from './playbook.controller';
import { ProjectsController } from './projects.controller';
import { ThreadsController } from './threads.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const OWNER = 'auth0|owner';

describe('playbook and lessons (real database)', () => {
  let s: RealStudio;
  let root: string;
  let projects: ProjectsController;
  let videos: VideosController;
  let files: FilesController;
  let playbook: PlaybookController;
  let threads: ThreadsController;

  beforeEach(async () => {
    s = await realStudio();
    root = mkdtempSync(join(tmpdir(), 'pb-api-'));
    const engine = s.engine as unknown as EngineService;
    const ws = new WorkspaceService({ get: (k: string, d?: unknown) => (k === 'STUDIO_WORKSPACES_ROOT' ? root : d) } as unknown as ConfigService, engine);
    projects = new ProjectsController(engine, ws, NO_DIRECTORY);
    videos = new VideosController(engine, ws);
    files = new FilesController(engine, ws, new FileLinkService({ get: () => 's'.repeat(32) } as unknown as ConfigService));
    playbook = new PlaybookController(engine, ws);
    threads = new ThreadsController(engine);
    await insertTeam(s.db, 'team-1', OWNER);
  });
  afterEach(async () => { await s.close(); });

  it('says where steps stand; marking a step writes its document status', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const v = await videos.create(p.id, { title: 'Huế' }, req(OWNER));
    const st = await playbook.status(p.id, v.id);
    expect(st.project.map((x) => x.status)).toEqual(['missing', 'missing', 'missing', 'missing']);
    expect(st.video?.[0]).toMatchObject({ key: 'brief', primary: `videos/${v.id}/brief.md` });
    await playbook.mark(p.id, 'style', { status: 'skipped' }, req(OWNER));
    expect(readFileSync(join(root, p.id, 'channel', 'style.md'), 'utf8')).toBe('---\nstatus: skipped\n---\n# Phong cách dựng\n');
    expect((await playbook.status(p.id)).project.find((x) => x.key === 'style')?.status).toBe('skipped');
    const fail = await playbook.mark(p.id, 'brief', { status: 'done' }, req(OWNER)).catch((e: { getResponse: () => { code: string } }) => e.getResponse().code);
    expect(fail).toBe('video_required');
    const studio = await playbook.mark(p.id, 'prepare', { status: 'done', videoId: v.id }, req(OWNER)).catch((e: { getResponse: () => { code: string } }) => e.getResponse().code);
    expect(studio).toBe('studio_step');
  });

  it('returns the checks of a file when it is read and when it is saved', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const saved = await files.write(p.id, { path: 'channel/branding.md', content: "---\ntext_look: { text_color: '#FFFFFF', outline_color: '#FDFDFD', box_color: null, size: m }\n---\n", baseSha256: null }, req(OWNER));
    expect(saved.issues.map((i) => i.code)).toEqual(['text_look_no_contrast']);
    expect((await files.content(p.id, 'channel/branding.md', req(OWNER))).issues.map((i) => i.code)).toEqual(['text_look_no_contrast']);
    expect((await files.content(p.id, 'CLAUDE.md', req(OWNER))).issues).toEqual([]);
  });

  it('a proposed lesson goes into memory/lessons.md when accepted', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const [kenh] = (await threads.list(p.id)).threads;
    await saveThreadSummary(s.engine.db, {
      thread: (await getThread(s.engine.db, kenh!.id))!, dir: join(root, p.id), now: new Date().toISOString(),
      summary: { summary_md: 's', lessons: ['Không dùng nhạc buồn.', 'Chữ địa danh viết hoa.'] },
    });
    const [a, b] = (await playbook.lessons(p.id, 'proposed')).lessons;
    await playbook.accept(p.id, a!.id, { text: 'Không bao giờ dùng nhạc buồn.' }, req(OWNER));
    await playbook.dismiss(p.id, b!.id, req(OWNER));
    expect(readFileSync(join(root, p.id, 'memory', 'lessons.md'), 'utf8')).toContain('- Không bao giờ dùng nhạc buồn.');
    expect((await listLessonProposals(s.engine.db, p.id)).map((l) => l.status)).toEqual(['accepted', 'dismissed']);
  });
});
