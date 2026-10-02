import {
  BadGatewayException, ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getCanvaDesign, saveCanvaDesign, thumbnailFontFile, thumbnailPdf, thumbnailTextLines, uploadThumbnail,
  type EpisodeRecord, type EpisodeThumbnail, type ThumbnailRenderer,
} from '@ag-studio/engine';
import { readFileSync } from 'node:fs';
import { EngineService } from '../studio/engine.service';
import { CanvaApiError, CanvaClient, type CanvaTokens } from './canva-client';
import { pkcePair, randomState, TokenCipher } from './canva-crypto';

/** Tests hand the Canva client a fake `fetch` through this token. */
export const CANVA_FETCH = 'CANVA_FETCH';

const STATE_TTL_MS = 10 * 60_000;
/** Refresh a little before Canva would refuse the access token. */
const REFRESH_MARGIN_MS = 5 * 60_000;

interface ConnectionRow { user_id: string; display_name: string | null; access_token_enc: string; refresh_token_enc: string; expires_at: string; scope: string }
interface StateRow { state: string; user_id: string; code_verifier: string; return_to: string; created_at: string }

/** Only paths inside the web app: never another site (an open redirect). */
function safeReturnTo(path: string | undefined): string {
  return path && path.length <= 500 && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/';
}

/**
 * Canva for each Studio user (plan phase D): connect their own Canva account (OAuth with PKCE, tokens encrypted at
 * rest, refreshed one at a time per user since a refresh token works once), open a thumbnail in Canva with its words
 * still editable, and bring the edited picture back as a new thumbnail. Off unless every CANVA_* value is set.
 */
@Injectable()
export class CanvaService {
  private readonly logger = new Logger(CanvaService.name);
  private readonly client: CanvaClient | null = null;
  private readonly cipher: TokenCipher | null = null;
  private readonly webUrl: string;
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    config: ConfigService,
    private readonly engine: EngineService,
    @Optional() @Inject(CANVA_FETCH) fetchImpl?: typeof fetch,
  ) {
    const clientId = config.get<string>('CANVA_CLIENT_ID');
    const clientSecret = config.get<string>('CANVA_CLIENT_SECRET');
    const redirectUri = config.get<string>('CANVA_REDIRECT_URI');
    const key = config.get<string>('CANVA_TOKEN_KEY');
    this.webUrl = (config.get<string>('STUDIO_WEB_URL') ?? '').replace(/\/+$/, '');
    if (clientId && clientSecret && redirectUri && key) {
      this.client = new CanvaClient({ clientId, clientSecret, redirectUri, ...(fetchImpl ? { fetch: fetchImpl, pollMs: [1] } : {}) });
      this.cipher = new TokenCipher(key);
    }
  }

  get enabled(): boolean { return this.client !== null; }

  private require(): { client: CanvaClient; cipher: TokenCipher } {
    if (!this.client || !this.cipher) throw new ServiceUnavailableException({ code: 'canva_disabled', message: 'Studio chưa được cấu hình kết nối Canva' });
    return { client: this.client, cipher: this.cipher };
  }

  private row(userId: string): ConnectionRow | undefined {
    return this.engine.db.get<ConnectionRow>('SELECT * FROM canva_connections WHERE user_id = ?', [userId]);
  }

  connection(userId: string): { enabled: boolean; connected: boolean; displayName: string | null } {
    const row = this.enabled ? this.row(userId) : undefined;
    return { enabled: this.enabled, connected: !!row, displayName: row?.display_name ?? null };
  }

  /** The Canva page where the user allows Studio; Canva then sends them to the callback with `state`. */
  authorize(userId: string, returnTo: string | undefined): string {
    const { client } = this.require();
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const now = Date.now();
    this.engine.db.run('DELETE FROM canva_oauth_states WHERE created_at < ?', [new Date(now - STATE_TTL_MS).toISOString()]);
    this.engine.db.run(
      'INSERT INTO canva_oauth_states (state, user_id, code_verifier, return_to, created_at) VALUES (?, ?, ?, ?, ?)',
      [state, userId, verifier, safeReturnTo(returnTo), new Date(now).toISOString()],
    );
    return client.authorizeUrl({ state, codeChallenge: challenge });
  }

  private back(path: string, params: Record<string, string>): string {
    return `${this.webUrl}${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams(params).toString()}`;
  }

  /**
   * Canva sends the browser back here (no Studio login on this request): the one-time `state` says who started the
   * connection. Returns where to send the browser in the web app, with `canva=connected` or `canva=error`.
   */
  async callback(q: { code?: string; state?: string; error?: string }): Promise<string> {
    const row = q.state ? this.engine.db.get<StateRow>('SELECT * FROM canva_oauth_states WHERE state = ?', [q.state]) : undefined;
    if (row) this.engine.db.run('DELETE FROM canva_oauth_states WHERE state = ?', [row.state]);
    if (!row || Date.parse(row.created_at) < Date.now() - STATE_TTL_MS) return this.back('/', { canva: 'error', reason: 'state_invalid' });
    if (q.error || !q.code) return this.back(row.return_to, { canva: 'error', reason: q.error ?? 'no_code' });
    try {
      const { client } = this.require();
      const tokens = await client.exchangeCode(q.code, row.code_verifier);
      let displayName: string | null = null;
      try { displayName = (await client.profile(tokens.access_token)).display_name; } catch { /* the name is only shown */ }
      this.save(row.user_id, tokens, displayName);
      return this.back(row.return_to, { canva: 'connected' });
    } catch (e) {
      this.logger.warn(`Canva connection of ${row.user_id} failed: ${e instanceof Error ? e.message : String(e)}`);
      return this.back(row.return_to, { canva: 'error', reason: e instanceof CanvaApiError ? e.code : 'failed' });
    }
  }

  private save(userId: string, t: CanvaTokens, displayName?: string | null): void {
    const { cipher } = this.require();
    const now = new Date().toISOString();
    this.engine.db.run(
      `INSERT INTO canva_connections (user_id, display_name, access_token_enc, refresh_token_enc, expires_at, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET display_name = COALESCE(excluded.display_name, canva_connections.display_name),
         access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
         expires_at = excluded.expires_at, scope = excluded.scope, updated_at = excluded.updated_at`,
      [userId, displayName ?? null, cipher.encrypt(t.access_token), cipher.encrypt(t.refresh_token),
        new Date(Date.now() + t.expires_in * 1000).toISOString(), t.scope, now, now],
    );
  }

  async disconnect(userId: string): Promise<void> {
    const row = this.row(userId);
    if (!row) return;
    this.engine.db.run('DELETE FROM canva_connections WHERE user_id = ?', [userId]);
    if (this.client && this.cipher) {
      try { await this.client.revoke(this.cipher.decrypt(row.refresh_token_enc)); } catch { /* dropped on our side anyway */ }
    }
  }

  private reconnect(userId: string): never {
    this.engine.db.run('DELETE FROM canva_connections WHERE user_id = ?', [userId]);
    throw new ConflictException({ code: 'canva_reconnect', message: 'Kết nối Canva đã hết hạn, hãy kết nối lại Canva' });
  }

  /** A live access token; at most one refresh per user at a time (the refresh token works once). */
  private async accessToken(userId: string): Promise<string> {
    const { client, cipher } = this.require();
    const row = this.row(userId);
    if (!row) throw new ConflictException({ code: 'canva_not_connected', message: 'Bạn chưa kết nối Canva' });
    if (Date.parse(row.expires_at) - REFRESH_MARGIN_MS > Date.now()) return cipher.decrypt(row.access_token_enc);
    const running = this.refreshing.get(userId);
    if (running) return running;
    const p = (async () => {
      // read again: another request may have refreshed while this one waited
      const current = this.row(userId);
      if (!current) return this.reconnect(userId);
      if (Date.parse(current.expires_at) - REFRESH_MARGIN_MS > Date.now()) return cipher.decrypt(current.access_token_enc);
      try {
        const tokens = await client.refresh(cipher.decrypt(current.refresh_token_enc));
        this.save(userId, tokens);
        return tokens.access_token;
      } catch (e) {
        if (e instanceof CanvaApiError && (e.status === 400 || e.status === 401)) return this.reconnect(userId);
        throw this.httpError(e);
      }
    })().finally(() => this.refreshing.delete(userId));
    this.refreshing.set(userId, p);
    return p;
  }

  private httpError(e: unknown): unknown {
    if (!(e instanceof CanvaApiError)) return e;
    if (e.status === 429) return new HttpException({ code: 'canva_busy', message: 'Canva đang giới hạn số lần gọi, thử lại sau ít phút' }, HttpStatus.TOO_MANY_REQUESTS);
    return new BadGatewayException({ code: 'canva_failed', message: `Canva báo lỗi: ${e.message}`, canvaCode: e.code });
  }

  private async withToken<T>(userId: string, fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken(userId);
    try {
      return await fn(token);
    } catch (e) {
      if (e instanceof CanvaApiError && e.status === 401) return this.reconnect(userId);
      throw this.httpError(e);
    }
  }

  /**
   * The thumbnail as a design in the user's Canva: a picture with words becomes a PDF whose words stay editable
   * (Canva's design import); without words, or when the import fails, the picture goes on a new design of its size.
   * The same user opening it again gets the same design.
   */
  async openThumbnail(userId: string, ep: EpisodeRecord, t: EpisodeThumbnail): Promise<{ designId: string; editUrl: string }> {
    this.require();
    return this.withToken(userId, async (token) => {
      const client = this.client!;
      const known = getCanvaDesign(this.engine.db, t.id, userId);
      if (known) {
        try {
          const d = await client.getDesign(token, known.design_id);
          return { designId: d.id, editUrl: d.urls.edit_url };
        } catch (e) {
          // deleted in Canva or no longer theirs: make a new one
          if (!(e instanceof CanvaApiError) || (e.status !== 403 && e.status !== 404)) throw e;
        }
      }
      const size = { width: t.width, height: t.height };
      const title = `${ep.title}`.trim() || 'Thumbnail';
      const font = thumbnailFontFile();
      if (t.text && t.style && t.base_key && t.kind !== 'canva' && font) {
        try {
          const pdf = await thumbnailPdf({
            background: await this.engine.bucket.get(t.base_key), ...size, style: t.style, title,
            lines: thumbnailTextLines(t.text, { ...size, style: t.style }), font: readFileSync(font),
          });
          const d = await client.importDesign(token, title, pdf, 'application/pdf');
          saveCanvaDesign(this.engine.db, { thumbnail_id: t.id, user_id: userId, design_id: d.id, imported: true });
          return { designId: d.id, editUrl: d.urls.edit_url };
        } catch (e) {
          if (e instanceof CanvaApiError && (e.status === 401 || e.status === 429)) throw e;
          this.logger.warn(`Canva import of thumbnail ${t.id} failed, using the flat picture: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const assetId = await client.uploadAsset(token, title, await this.engine.bucket.get(t.image_key));
      const d = await client.createDesign(token, { title, ...size, assetId });
      saveCanvaDesign(this.engine.db, { thumbnail_id: t.id, user_id: userId, design_id: d.id, imported: false });
      return { designId: d.id, editUrl: d.urls.edit_url };
    });
  }

  /** The design as the user left it in Canva, back as a new `canva` thumbnail of the episode. */
  async pullThumbnail(userId: string, ep: EpisodeRecord, t: EpisodeThumbnail, renderer: ThumbnailRenderer): Promise<EpisodeThumbnail> {
    this.require();
    const known = getCanvaDesign(this.engine.db, t.id, userId);
    if (!known) throw new NotFoundException({ code: 'no_canva_design', message: 'Ảnh này chưa được mở trong Canva' });
    const jpeg = await this.withToken(userId, (token) => this.client!.exportJpeg(token, known.design_id, { width: t.width, height: t.height }));
    const deps = { core: this.engine.core, db: this.engine.db, bucket: this.engine.bucket };
    return uploadThumbnail(deps, renderer, ep, jpeg, userId, 'canva', t.id);
  }
}
