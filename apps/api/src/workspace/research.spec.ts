/**
 * The Research tab routes over a real studio.db and folder: a crawl's cost before it runs, running it as a job, and
 * the research documents of the project with what Studio knows of its crawls.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { getJob } from '@ag-studio/engine';
import { insertTeam, NO_DIRECTORY, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import { ProjectsController } from './projects.controller';
import { ResearchController } from './research.controller';
import { WorkspaceService } from './workspace.service';

const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const OWNER = 'auth0|owner';
const code = (e: unknown) => (e as { getResponse?: () => { code?: string } }).getResponse?.().code ?? String(e);

describe('research (real studio.db)', () => {
  let s: RealStudio;
  let root: string;
  let projects: ProjectsController;
  const research = (env: Record<string, string>) => new ResearchController(s.engine as unknown as EngineService, ws(), { get: (k: string) => env[k] } as unknown as ConfigService);
  const ws = () => new WorkspaceService({ get: (k: string, d?: unknown) => (k === 'STUDIO_WORKSPACES_ROOT' ? root : d) } as unknown as ConfigService, s.engine as unknown as EngineService);

  beforeEach(async () => {
    s = await realStudio();
    root = mkdtempSync(join(tmpdir(), 'research-api-'));
    projects = new ProjectsController(s.engine as unknown as EngineService, ws(), NO_DIRECTORY);
    insertTeam(s.db, 'team-1', OWNER);
  });
  afterEach(() => s.close());

  it('says what a crawl costs, with the API or with yt-dlp', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    expect(await research({ YOUTUBE_API_KEY: 'k' }).estimate(p.id, { kind: 'topic', q: 'phố cổ' })).toEqual({
      request: { kind: 'topic', q: 'phố cổ', region: 'VN', days: 90, order: 'viewCount', max: 30 }, title: 'Video xem nhiều: "phố cổ" (VN, 90 ngày)',
      units: 101, large: false, source: 'youtube_api',
    });
    expect(await research({}).estimate(p.id, { kind: 'topic', q: 'phố cổ', max: 150 })).toMatchObject({ units: 0, large: true, source: 'yt-dlp' });
    expect(await research({}).estimate(p.id, { kind: 'topic', q: '' }).catch(code)).toBe('invalid');
  });

  it('runs a crawl as a research job, large ones too (a person asked)', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const job = await research({}).run(p.id, { crawl: { kind: 'trending', max: 150 } }, req(OWNER));
    expect(job).toMatchObject({ kind: 'research', status: 'queued', title: 'Xu hướng YouTube VN', threadId: null });
    expect(getJob(s.engine.db, job.id)).toMatchObject({ units: 150, actor_role: 'owner', continue_agent: 0 });
  });

  it('lists research documents newest first, with the crawls Studio wrote', async () => {
    const p = await projects.create('team-1', { name: 'A' }, req(OWNER));
    const dir = join(root, p.id, 'research');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.md'), '# Báo cáo thị trường\n\n…');
    writeFileSync(join(dir, '2026-10-10-xu-huong-vn.md'), '# Xu hướng YouTube VN\n');
    writeFileSync(join(dir, '2026-10-10-xu-huong-vn.json'), JSON.stringify({
      schema_version: 'studio.crawl/v1', request: { kind: 'trending' }, fetched_at: '2026-10-10T08:00:00Z', source: 'youtube_api', videos: [1, 2], channels: [], quota_units: 1,
    }));
    const { files } = await research({}).list(p.id);
    expect(files.map((f) => [f.path, f.title, f.crawl?.videos ?? null])).toEqual(expect.arrayContaining([
      ['research/report.md', 'Báo cáo thị trường', null],
      ['research/2026-10-10-xu-huong-vn.md', 'Xu hướng YouTube VN', 2],
    ]));
  });
});
