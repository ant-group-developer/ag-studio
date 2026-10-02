/**
 * Canva for a Studio user against a fake Canva behind `fetch`, over a real studio.db: connecting (PKCE, one-time
 * state, tokens encrypted at rest), one refresh at a time and reconnecting when Canva refuses it, opening a thumbnail
 * with editable words (PDF import) or as a flat picture when the import fails, reusing the design, and bringing the
 * edited picture back as a new thumbnail.
 */
import { createHash } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  getCanvaDesign, insertThumbnail, listThumbnails, MemoryBucket, thumbnailFontFile, type EpisodeRecord, type EpisodeThumbnail,
  type ThumbnailRenderer,
} from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import { CanvaService } from './canva.service';

const PROD = '66666666-6666-4666-8666-666666666666';
const USER = 'auth0|editor';
const CONFIG: Record<string, string> = {
  CANVA_CLIENT_ID: 'cid', CANVA_CLIENT_SECRET: 'secret', CANVA_REDIRECT_URI: 'https://studio.test/api/canva/oauth/callback',
  CANVA_TOKEN_KEY: 'ab'.repeat(32), STUDIO_WEB_URL: 'https://studio.test/',
};
const config = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as unknown as ConfigService;
const style = { position: 'bottom', size: 'l', text_color: '#FFFFFF', outline_color: '#000000', box_color: null, uppercase: true } as const;

/** A JPEG header a PDF can embed (it is never decoded). */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 2, 208, 5, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.from([0xff, 0xd9])]);

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }

function fakeCanva() {
  const calls: Call[] = [];
  const s = { n: 0, refreshes: 0, failImport: false, refreshFails: false, designs: new Set<string>() };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const tokens = () => { s.n++; return { access_token: `access-${s.n}`, refresh_token: `refresh-${s.n}`, token_type: 'Bearer', expires_in: 14400, scope: 'asset:write' }; };
  const design = (id: string) => { s.designs.add(id); return { id, urls: { edit_url: `https://www.canva.com/design/${id}/edit`, view_url: '' } }; };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    if (url.endsWith('/oauth/token')) {
      const p = new URLSearchParams(String(init!.body));
      if (p.get('grant_type') === 'authorization_code') return p.get('code') === 'good' && p.get('code_verifier') ? json(200, tokens()) : json(400, { code: 'invalid_grant', message: 'bad code' });
      s.refreshes++;
      // a refresh token works once
      return !s.refreshFails && p.get('refresh_token') === `refresh-${s.n}` ? json(200, tokens()) : json(400, { code: 'invalid_grant', message: 'used' });
    }
    if (url.endsWith('/oauth/revoke')) return json(200, {});
    if (url.endsWith('/users/me/profile')) return json(200, { profile: { display_name: 'Lan' } });
    if (url.endsWith('/imports')) return s.failImport ? json(400, { code: 'invalid_file', message: 'cannot read' }) : json(200, { job: { id: 'imp1', status: 'in_progress' } });
    if (url.endsWith('/imports/imp1')) return json(200, { job: { id: 'imp1', status: 'success', result: { designs: [design('D-import')] } } });
    if (url.endsWith('/asset-uploads')) return json(200, { job: { id: 'up1', status: 'success', asset: { id: 'A1' } } });
    if (url.endsWith('/designs') && method === 'POST') return json(200, { design: design('D-flat') });
    const m = /\/designs\/([^/]+)$/.exec(url);
    if (m) return s.designs.has(m[1]!) ? json(200, { design: design(m[1]!) }) : json(404, { code: 'design_not_found', message: 'gone' });
    if (url.endsWith('/exports')) return json(200, { job: { id: 'ex1', status: 'in_progress' } });
    if (url.endsWith('/exports/ex1')) return json(200, { job: { id: 'ex1', status: 'success', urls: ['https://export.canva.test/x.jpg'] } });
    if (url === 'https://export.canva.test/x.jpg') return new Response(new Uint8Array(Buffer.from('canva-jpeg')));
    return json(404, { code: 'not_found', message: url });
  }) as typeof fetch;
  return { calls, s, fetchImpl };
}

const renderer: ThumbnailRenderer = {
  async extractFrame() { throw new Error('not used'); },
  async compose() { throw new Error('not used'); },
  async normalize(input, out) { copyFileSync(input, out); },
};

describe('CanvaService (fake Canva, real studio.db)', () => {
  let s: RealStudio;
  let bucket: MemoryBucket;
  let canva: ReturnType<typeof fakeCanva>;
  let svc: CanvaService;
  let ep: EpisodeRecord;
  let drawn: EpisodeThumbnail;

  async function connect(): Promise<void> {
    const url = new URL(svc.authorize(USER, '/productions/p1?episode=e1'));
    expect(await svc.callback({ code: 'good', state: url.searchParams.get('state')! })).toBe('https://studio.test/productions/p1?episode=e1&canva=connected');
  }

  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    const now = new Date().toISOString();
    s.db.run(`INSERT INTO productions (id, team_id, title, status, created_at, updated_at, owner_user_id, aspect) VALUES (?, 'team-1', 'Phở', 'draft', ?, ?, 'auth0|owner', '16:9')`, [PROD, now, now]);
    s.db.run(`INSERT INTO episodes (id, production_id, idx, title, hook, created_at, updated_at) VALUES ('ep-1', ?, 1, 'Phở sáng Hà Nội', '', ?, ?)`, [PROD, now, now]);
    bucket = new MemoryBucket();
    await bucket.put('frame.jpg', JPEG);
    await bucket.put('drawn.jpg', Buffer.from('drawn'));
    drawn = insertThumbnail(s.engine.db, {
      episode_id: 'ep-1', kind: 'composed', source_run_id: null, parent_id: null, t_s: 2, asset_id: 'asset-1', base_key: 'frame.jpg', image_key: 'drawn.jpg',
      text: 'Phở 6 giờ sáng', style, width: 1280, height: 720, size_bytes: 5, created_by: USER,
    });
    ep = s.engine.db.get<EpisodeRecord>('SELECT * FROM episodes WHERE id = ?', ['ep-1'])!;
    canva = fakeCanva();
    const engine = Object.assign(s.engine, { bucket }) as unknown as EngineService;
    svc = new CanvaService(config(CONFIG), engine, canva.fetchImpl);
  });
  afterEach(() => s.close());

  it('connects with PKCE and a one-time state, keeps the tokens encrypted, and sends the browser back to the app', async () => {
    expect(svc.connection(USER)).toEqual({ enabled: true, connected: false, displayName: null });
    const url = new URL(svc.authorize(USER, '/productions/p1'));
    expect(url.origin + url.pathname).toBe('https://www.canva.com/api/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'cid', code_challenge_method: 's256', response_type: 'code', redirect_uri: CONFIG.CANVA_REDIRECT_URI,
    });
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['asset:write', 'design:content:write', 'design:content:read']));
    const state = url.searchParams.get('state')!;
    const row = s.db.get<{ code_verifier: string; return_to: string }>('SELECT * FROM canva_oauth_states WHERE state = ?', [state])!;
    expect(createHash('sha256').update(row.code_verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));

    expect(await svc.callback({ code: 'good', state })).toBe('https://studio.test/productions/p1?canva=connected');
    expect(svc.connection(USER)).toEqual({ enabled: true, connected: true, displayName: 'Lan' });
    const stored = JSON.stringify(s.db.all('SELECT * FROM canva_connections'));
    expect(stored).not.toContain('access-1');
    expect(stored).not.toContain('refresh-1');
    // the state worked once; a refusal and a foreign return path come back as errors inside the app
    expect(await svc.callback({ code: 'good', state })).toBe('https://studio.test/?canva=error&reason=state_invalid');
    const refused = new URL(svc.authorize(USER, 'https://evil.example/steal')).searchParams.get('state')!;
    expect(await svc.callback({ error: 'access_denied', state: refused })).toBe('https://studio.test/?canva=error&reason=access_denied');

    await svc.disconnect(USER);
    expect(svc.connection(USER).connected).toBe(false);
    expect(canva.calls.some((c) => c.url.endsWith('/oauth/revoke'))).toBe(true);
  });

  it('refreshes an expiring token once for concurrent calls, and asks to reconnect when Canva refuses the refresh', async () => {
    await connect();
    s.db.run('UPDATE canva_connections SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()]);
    const token = (svc as unknown as { accessToken(u: string): Promise<string> }).accessToken.bind(svc);
    expect(await Promise.all([token(USER), token(USER)])).toEqual(['access-2', 'access-2']);
    expect(canva.s.refreshes).toBe(1);
    expect(await token(USER)).toBe('access-2');

    s.db.run('UPDATE canva_connections SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()]);
    canva.s.refreshFails = true;
    const err = await token(USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(((err as ConflictException).getResponse() as { code: string }).code).toBe('canva_reconnect');
    expect(svc.connection(USER).connected).toBe(false);
  });

  it.skipIf(!thumbnailFontFile())('opens a picture with words as an imported PDF, and the same design again next time', async () => {
    await expect(svc.openThumbnail(USER, ep, drawn)).rejects.toBeInstanceOf(ConflictException);
    await connect();
    expect(await svc.openThumbnail(USER, ep, drawn)).toEqual({ designId: 'D-import', editUrl: 'https://www.canva.com/design/D-import/edit' });
    const imp = canva.calls.find((c) => c.url.endsWith('/imports'))!;
    expect(imp.headers['Content-Type']).toBe('application/octet-stream');
    const meta = JSON.parse(imp.headers['Import-Metadata']!) as { title_base64: string; mime_type: string };
    expect(Buffer.from(meta.title_base64, 'base64').toString('utf8')).toBe('Phở sáng Hà Nội');
    expect(meta.mime_type).toBe('application/pdf');
    expect(Buffer.from(imp.body as Uint8Array).subarray(0, 5).toString()).toBe('%PDF-');
    expect(getCanvaDesign(s.engine.db, drawn.id, USER)).toMatchObject({ design_id: 'D-import', imported: 1 });

    const imports = canva.calls.filter((c) => c.url.endsWith('/imports')).length;
    expect((await svc.openThumbnail(USER, ep, drawn)).designId).toBe('D-import');
    expect(canva.calls.filter((c) => c.url.endsWith('/imports'))).toHaveLength(imports);
  });

  it('falls back to the flat picture on a new design when the import fails, and brings the edit back as a new thumbnail', async () => {
    await connect();
    canva.s.failImport = true;
    expect((await svc.openThumbnail(USER, ep, drawn)).designId).toBe('D-flat');
    const upload = canva.calls.find((c) => c.url.endsWith('/asset-uploads'))!;
    expect(Buffer.from(upload.body as Uint8Array).toString()).toBe('drawn');
    const create = canva.calls.find((c) => c.url.endsWith('/designs') && c.method === 'POST')!;
    expect(JSON.parse(String(create.body))).toMatchObject({ design_type: { type: 'custom', width: 1280, height: 720 }, asset_id: 'A1' });
    expect(getCanvaDesign(s.engine.db, drawn.id, USER)!.imported).toBe(0);

    const back = await svc.pullThumbnail(USER, ep, drawn, renderer);
    expect(back).toMatchObject({ kind: 'canva', parent_id: drawn.id, created_by: USER, width: 1280, height: 720 });
    expect(bucket.objects.get(back.image_key)!.toString()).toBe('canva-jpeg');
    const exp = canva.calls.find((c) => c.url.endsWith('/exports'))!;
    expect(JSON.parse(String(exp.body))).toMatchObject({ design_id: 'D-flat', format: { type: 'jpg', width: 1280, height: 720 } });
    expect(listThumbnails(s.engine.db, 'ep-1').map((t) => t.kind)).toEqual(['composed', 'canva']);
    // another user never opened it
    await expect(svc.pullThumbnail('auth0|other', ep, drawn, renderer)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is off without its settings', () => {
    const off = new CanvaService(config({}), s.engine as unknown as EngineService);
    expect(off.connection(USER)).toEqual({ enabled: false, connected: false, displayName: null });
    expect(() => off.authorize(USER, '/')).toThrow(ServiceUnavailableException);
  });
});

describe('TokenCipher', () => {
  it('reads back what it sealed, and refuses another key or a changed value', async () => {
    const { TokenCipher } = await import('./canva-crypto');
    const a = new TokenCipher('ab'.repeat(32));
    const sealed = a.encrypt('access-token');
    expect(sealed).not.toContain('access-token');
    expect(a.decrypt(sealed)).toBe('access-token');
    expect(() => new TokenCipher('cd'.repeat(32)).decrypt(sealed)).toThrow();
    const parts = sealed.split('.');
    const data = parts[3]!;
    expect(() => a.decrypt([...parts.slice(0, 3), `${data.startsWith('A') ? 'B' : 'A'}${data.slice(1)}`].join('.'))).toThrow();
    expect(() => new TokenCipher('short')).toThrow(/32 bytes/);
  });
});
