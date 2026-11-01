/**
 * ag-music-v2's API as the person who asks (2026-11-01): Studio forwards their own Auth0 access token — the same tenant
 * and audience — so ag-music checks what they may see (`music.tracks.read`, their view scope) and counts their download.
 * Answers come in ag-music's envelope `{success, data, error, timestamp}`; `error` is a ProblemDetail with a `code`.
 */

/** ag-music's track types: songs (reviewed in 6 steps), AI music, asset, music index. */
export const AG_MUSIC_TRACK_TYPES = ['SONG', 'ASSISTED', 'ASSET', 'MUSIC_INDEX'] as const;
export type AgMusicTrackType = (typeof AG_MUSIC_TRACK_TYPES)[number];

export interface AgMusicRef { id: number; name: string }

/** One row of ag-music `GET /tracks` (the fields Studio reads). */
export interface AgMusicTrackItem {
  id: number;
  type: AgMusicTrackType;
  name: string;
  code: string | null;
  bpm: number | null;
  durationMs: number | null;
  thumbnailUrl: string | null;
  categories: { id: number; kind: string; name: string }[];
  artists: AgMusicRef[];
}

export interface AgMusicPage<T> { items: T[]; page: number; size: number; totalElements: number; totalPages: number }

/** ag-music `GET /tracks/{id}/playback`: a link to listen to the main audio. */
export interface AgMusicPlayback { trackId: number; audioUrl: string; expiresAt: string; durationMs: number | null }

/** ag-music `POST /tracks/{id}/export`: the main audio of an approved track to copy, with a download link. */
export interface AgMusicExport {
  trackId: number;
  code: string | null;
  type: AgMusicTrackType;
  name: string;
  artists: AgMusicRef[];
  origin: string | null;
  copyrightStatus: string | null;
  fileId: number;
  fileName: string;
  contentType: string | null;
  sizeBytes: number;
  durationMs: number | null;
  url: string;
  expiresAt: string;
}

export interface AgMusicTrackQuery { keyword?: string; types?: AgMusicTrackType[]; page?: number; size?: number }

/** ag-music answered with an error (`status` 0: it could not be reached). `code`: its ProblemDetail's code. */
export class AgMusicClientError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) {
    super(message);
    this.name = 'AgMusicClientError';
  }
}

export class AgMusicClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /** `baseUrl`: ag-music's API with its version (`https://music.example.com/api/v1`). */
  constructor(opts: { baseUrl: string; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /** Approved tracks the person may see, newest first. */
  listTracks(accessToken: string, q: AgMusicTrackQuery): Promise<AgMusicPage<AgMusicTrackItem>> {
    const params = new URLSearchParams({ approved: 'true', sort: 'NEWEST', page: String(q.page ?? 0), size: String(q.size ?? 20) });
    if (q.keyword) params.set('keyword', q.keyword);
    if (q.types?.length) params.set('types', q.types.join(','));
    return this.request('GET', `/tracks?${params}`, accessToken);
  }

  playback(accessToken: string, trackId: number): Promise<AgMusicPlayback> {
    return this.request('GET', `/tracks/${trackId}/playback`, accessToken);
  }

  /** Counts a download for the person (not when they own the track). */
  exportTrack(accessToken: string, trackId: number): Promise<AgMusicExport> {
    return this.request('POST', `/tracks/${trackId}/export`, accessToken);
  }

  private async request<T>(method: string, path: string, accessToken: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new AgMusicClientError(0, null, `Không gọi được ag-music: ${(e as Error).message}`);
    }
    const body = (res.headers.get('content-type') ?? '').includes('json') ? await res.json().catch(() => null) : null;
    const env = body as { success?: boolean; data?: T; error?: { code?: string; detail?: string; title?: string } } | null;
    if (!res.ok || env?.success === false) {
      const err = env?.error;
      throw new AgMusicClientError(res.status, err?.code ?? null, err?.detail || err?.title || `ag-music trả HTTP ${res.status}`);
    }
    if (!env || !('data' in env)) throw new AgMusicClientError(502, null, 'ag-music trả dữ liệu không đúng dạng');
    return env.data as T;
  }
}
