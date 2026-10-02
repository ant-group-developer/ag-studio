/**
 * Canva Connect REST API (generally available endpoints only): OAuth 2.0 with PKCE, binary asset uploads, design
 * imports (a PDF becomes an editable design), designs, and JPEG exports. Jobs are polled until they finish.
 * https://www.canva.dev/docs/connect/
 */

export const CANVA_AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize';
export const CANVA_API = 'https://api.canva.com/rest/v1';
/** Upload a picture, import/create a design with it, read the design's links, export it, show whose account it is. */
export const CANVA_SCOPES = ['asset:write', 'design:content:write', 'design:content:read', 'design:meta:read', 'profile:read'];

export class CanvaApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface CanvaTokens { access_token: string; refresh_token: string; expires_in: number; scope: string }
export interface CanvaDesign { id: string; urls: { edit_url: string; view_url: string } }

type Fetch = typeof fetch;
type Job<T> = { job: { id: string; status: 'in_progress' | 'success' | 'failed'; error?: { code: string; message: string } } & T };

/** Canva limits a title or an asset name to 50 characters before base64. */
const b64Name = (name: string) => Buffer.from([...name].slice(0, 50).join('') || 'AG Studio', 'utf8').toString('base64');

export class CanvaClient {
  constructor(
    private readonly o: { clientId: string; clientSecret: string; redirectUri: string; fetch?: Fetch; pollMs?: number[]; jobTimeoutMs?: number },
  ) {}

  private get fetch(): Fetch { return this.o.fetch ?? fetch; }

  authorizeUrl(p: { state: string; codeChallenge: string }): string {
    const q = new URLSearchParams({
      code_challenge: p.codeChallenge, code_challenge_method: 's256', scope: CANVA_SCOPES.join(' '), response_type: 'code',
      client_id: this.o.clientId, state: p.state, redirect_uri: this.o.redirectUri,
    });
    return `${CANVA_AUTHORIZE_URL}?${q.toString()}`;
  }

  private async fail(res: Response): Promise<never> {
    let code = `http_${res.status}`;
    let message = res.statusText;
    try {
      const body = (await res.json()) as { code?: string; message?: string; error?: string; error_description?: string };
      code = body.code ?? body.error ?? code;
      message = body.message ?? body.error_description ?? message;
    } catch { /* not JSON */ }
    throw new CanvaApiError(res.status, code, message);
  }

  private async token(body: Record<string, string>): Promise<CanvaTokens> {
    const res = await this.fetch(`${CANVA_API}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) return this.fail(res);
    return (await res.json()) as CanvaTokens;
  }

  exchangeCode(code: string, codeVerifier: string): Promise<CanvaTokens> {
    return this.token({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: this.o.redirectUri });
  }

  /** A refresh token works once: the answer carries the next one. */
  refresh(refreshToken: string): Promise<CanvaTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Best effort: the connection is dropped on our side whatever Canva answers. */
  async revoke(token: string): Promise<void> {
    try {
      await this.fetch(`${CANVA_API}/oauth/revoke`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token }).toString(),
      });
    } catch { /* ignored */ }
  }

  private async call<T>(token: string, method: string, path: string, init: { json?: unknown; body?: Buffer; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...init.headers };
    let body: BodyInit | undefined;
    if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json); }
    if (init.body) { headers['Content-Type'] = 'application/octet-stream'; body = new Uint8Array(init.body); }
    const res = await this.fetch(`${CANVA_API}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    if (!res.ok) return this.fail(res);
    return (await res.json()) as T;
  }

  /** Polls a job until it succeeds (its final state) or fails (CanvaApiError with Canva's code). */
  private async wait<T>(first: Job<T>, poll: (id: string) => Promise<Job<T>>): Promise<Job<T>['job']> {
    const delays = this.o.pollMs ?? [500, 1000, 1500, 2000, 3000];
    const deadline = Date.now() + (this.o.jobTimeoutMs ?? 120_000);
    let job = first.job;
    for (let i = 0; job.status === 'in_progress'; i++) {
      if (Date.now() > deadline) throw new CanvaApiError(504, 'job_timeout', 'Canva chưa xong việc sau 2 phút');
      await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
      job = (await poll(job.id)).job;
    }
    if (job.status === 'failed') throw new CanvaApiError(422, job.error?.code ?? 'job_failed', job.error?.message ?? 'Canva job failed');
    return job;
  }

  async profile(token: string): Promise<{ display_name: string }> {
    return (await this.call<{ profile: { display_name: string } }>(token, 'GET', '/users/me/profile')).profile;
  }

  /** A picture into the user's Canva uploads; returns the asset id. */
  async uploadAsset(token: string, name: string, data: Buffer): Promise<string> {
    type R = { asset?: { id: string } };
    const first = await this.call<Job<R>>(token, 'POST', '/asset-uploads', {
      body: data, headers: { 'Asset-Upload-Metadata': JSON.stringify({ name_base64: b64Name(name) }) },
    });
    const job = await this.wait<R>(first, (id) => this.call<Job<R>>(token, 'GET', `/asset-uploads/${encodeURIComponent(id)}`));
    if (!job.asset) throw new CanvaApiError(502, 'no_asset', 'Canva không trả về ảnh đã tải lên');
    return job.asset.id;
  }

  /** A file (here: a one-page PDF) imported as a new design of the user's. */
  async importDesign(token: string, title: string, data: Buffer, mimeType: string): Promise<CanvaDesign> {
    type R = { result?: { designs: CanvaDesign[] } };
    const first = await this.call<Job<R>>(token, 'POST', '/imports', {
      body: data, headers: { 'Import-Metadata': JSON.stringify({ title_base64: b64Name(title), mime_type: mimeType }) },
    });
    const job = await this.wait<R>(first, (id) => this.call<Job<R>>(token, 'GET', `/imports/${encodeURIComponent(id)}`));
    const design = job.result?.designs[0];
    if (!design) throw new CanvaApiError(502, 'no_design', 'Canva không tạo được thiết kế từ file');
    return design;
  }

  /** A new `width`×`height` design with the asset on it. */
  async createDesign(token: string, p: { title: string; width: number; height: number; assetId: string }): Promise<CanvaDesign> {
    const r = await this.call<{ design: CanvaDesign }>(token, 'POST', '/designs', {
      json: { type: 'type_and_asset', design_type: { type: 'custom', width: p.width, height: p.height }, asset_id: p.assetId, title: [...p.title].slice(0, 255).join('') },
    });
    return r.design;
  }

  /** The design with fresh links (they last 30 days and work only for this user). */
  async getDesign(token: string, designId: string): Promise<CanvaDesign> {
    return (await this.call<{ design: CanvaDesign }>(token, 'GET', `/designs/${encodeURIComponent(designId)}`)).design;
  }

  /** The design's first page as a JPEG at `width`×`height`. */
  async exportJpeg(token: string, designId: string, size: { width: number; height: number }): Promise<Buffer> {
    type R = { urls?: string[] };
    const first = await this.call<Job<R>>(token, 'POST', '/exports', {
      json: { design_id: designId, format: { type: 'jpg', quality: 92, width: size.width, height: size.height, pages: [1] } },
    });
    const job = await this.wait<R>(first, (id) => this.call<Job<R>>(token, 'GET', `/exports/${encodeURIComponent(id)}`));
    const url = job.urls?.[0];
    if (!url) throw new CanvaApiError(502, 'no_export', 'Canva không trả về ảnh xuất');
    const res = await this.fetch(url);
    if (!res.ok) throw new CanvaApiError(502, 'export_download', `tải ảnh xuất từ Canva lỗi ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
