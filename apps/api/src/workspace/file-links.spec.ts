/**
 * The short link that plays a workspace file: made for one file of one project and one person, served without a login
 * (an `<audio>` element sends no bearer token), with ranges so a player seeks, and refused for any other file, an
 * altered or expired link, hidden folders and archived projects.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { signFileLink } from '@ag-studio/engine';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { insertTeam, NO_DIRECTORY, realStudio, type RealStudio } from '../test/real-studio';
import { EngineService } from '../studio/engine.service';
import { FileLinkService, FileStreamController } from './file-links';
import { ProjectsController } from './projects.controller';
import { WorkspaceService } from './workspace.service';

const SECRET = 's'.repeat(32);
const OWNER = 'auth0|owner';
const req = (userId: string) => ({ authContext: { userId, accessToken: 't' } }) as unknown as Request;
const config = (values: Record<string, string>) => ({ get: (k: string, d?: unknown) => values[k] ?? d }) as unknown as ConfigService;
/** Like the API's global Auth0Guard for a request without a token: only `@Public()` routes let it in. */
const publicOnly = { canActivate: (ctx: ExecutionContext) => new Reflector().get(IS_PUBLIC_KEY, ctx.getHandler()) === true };

describe('workspace file links (real studio.db and folder)', () => {
  let s: RealStudio;
  let root: string;
  let links: FileLinkService;
  let app: INestApplication;
  let base: string;
  let projectId: string;
  const get = (url: string, headers: Record<string, string> = {}) => fetch(`${base}${url}`, { headers });

  beforeEach(async () => {
    s = await realStudio();
    root = mkdtempSync(join(tmpdir(), 'file-links-'));
    const engine = s.engine as unknown as EngineService;
    const ws = new WorkspaceService(config({ STUDIO_WORKSPACES_ROOT: root }), engine);
    links = new FileLinkService(config({ STUDIO_AGENT_TOKEN_SECRET: SECRET }));
    insertTeam(s.db, 'team-1', OWNER);
    projectId = (await new ProjectsController(engine, ws, NO_DIRECTORY).create('team-1', { name: 'A' }, req(OWNER))).id;
    mkdirSync(join(root, projectId, 'context', 'audio'), { recursive: true });
    writeFileSync(join(root, projectId, 'context', 'audio', 'nhạc 1.mp3'), Buffer.from('ID3-0123456789'));
    mkdirSync(join(root, projectId, '.trash'), { recursive: true });
    writeFileSync(join(root, projectId, '.trash', 'cu.mp3'), 'ID3');
    // the route as the API serves it: under /api, behind a guard that lets only public routes in without a login
    const mod = await Test.createTestingModule({
      controllers: [FileStreamController],
      providers: [
        { provide: EngineService, useValue: engine }, { provide: WorkspaceService, useValue: ws }, { provide: FileLinkService, useValue: links },
        { provide: APP_GUARD, useValue: publicOnly },
      ],
    }).compile();
    // vitest compiles without decorator metadata, so Nest cannot inject by type here: hand the controller its services
    Object.assign(mod.get(FileStreamController), { engine, workspace: ws, links });
    app = mod.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterEach(async () => {
    await app.close();
    s.close();
  });

  it('plays the file it was made for, whole or a range of it', async () => {
    const url = links.url(projectId, 'context/audio/nhạc 1.mp3', OWNER);
    const whole = await get(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toContain('audio/mpeg');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('cache-control')).toBe('private, max-age=900');
    expect(await whole.text()).toBe('ID3-0123456789');
    const part = await get(url, { Range: 'bytes=4-7' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 4-7/14');
    expect(await part.text()).toBe('0123');
  });

  it('refuses another file, another project, an altered or expired link, hidden folders, missing files and archived projects', async () => {
    const url = links.url(projectId, 'context/audio/nhạc 1.mp3', OWNER);
    const t = new URL(url, 'http://x').searchParams.get('t')!;
    const at = (path: string, token: string, project = projectId) =>
      get(`/api/projects/${project}/files/stream?path=${encodeURIComponent(path)}&t=${encodeURIComponent(token)}`);
    expect((await at('CLAUDE.md', t)).status).toBe(403);
    expect((await at('context/audio/nhạc 1.mp3', t, '00000000-0000-0000-0000-000000000000')).status).toBe(403);
    const altered = await at('context/audio/nhạc 1.mp3', `${t}x`);
    expect(altered.status).toBe(401);
    expect(await altered.json()).toMatchObject({ code: 'bad_file_link' });
    const expired = signFileLink({ project: projectId, path: 'context/audio/nhạc 1.mp3', sub: OWNER, exp: 1 }, SECRET);
    expect((await at('context/audio/nhạc 1.mp3', expired)).status).toBe(401);
    expect((await get(new FileLinkService(config({})).url(projectId, 'context/audio/nhạc 1.mp3', OWNER))).status).toBe(401);
    expect((await get(links.url(projectId, '.trash/cu.mp3', OWNER))).status).toBe(404);
    expect((await get(links.url(projectId, 'context/audio/khong.mp3', OWNER))).status).toBe(404);
    expect((await get(links.url(projectId, '../ngoai.mp3', OWNER))).status).toBe(403);
    s.engine.db.run('UPDATE projects SET archived_at = ? WHERE id = ?', [new Date().toISOString(), projectId]);
    expect((await get(url)).status).toBe(404);
  });
});
