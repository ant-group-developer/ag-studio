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
  instrumental?: boolean;
  /** Waveform of the main audio, reduced (`null` until ag-music has processed the file). */
  peaks?: number[] | null;
  downloadCount?: number;
  playCount?: number;
}

/** Kinds of ag-music categories, the groups of its filter sidebar. */
export const AG_MUSIC_CATEGORY_KINDS = ['GENRE', 'THEME', 'MOOD', 'EFFECT', 'INSTRUMENT'] as const;
export type AgMusicCategoryKind = (typeof AG_MUSIC_CATEGORY_KINDS)[number];

export interface AgMusicFacetItem { id: number; name: string; count: number }

/** ag-music `GET /tracks/facets`: how many tracks per choice of each filter group, on the same filter. */
export interface AgMusicFacets {
  categories: Partial<Record<AgMusicCategoryKind, AgMusicFacetItem[]>>;
  artists: AgMusicFacetItem[];
  instrumental: Record<string, number>;
  voiceGenders: Record<string, number>;
  releaseStatuses: Record<string, number>;
  origins: Record<string, number>;
  purposes: Record<string, number>;
}

export interface AgMusicPage<T> { items: T[]; page: number; size: number; totalElements: number; totalPages: number }

/** ag-music `GET /tracks/{id}` (the fields Studio reads): what the library shows of a copied track. */
export interface AgMusicTrackDetail {
  id: number;
  bpm: number | null;
  categories: { id: number; kind: string; name: string }[];
  artists: AgMusicRef[];
}

/** ag-music `GET /tracks/{id}/playback`: a link to listen to the main audio. */
export interface AgMusicPlayback { trackId: number; audioUrl: string; expiresAt: string; durationMs: number | null }

/** ag-music `POST /tracks/{id}/export`: the main audio of an approved track, not a copyright violation, with a download link. */
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

/**
 * Why a track copied before can no longer be used: removed (in ag-music's trash, a copyright removal too), not visible to
 * the person asking (or gone for good), not approved, a copyright violation.
 */
export type AgMusicExportBlock = 'DELETED' | 'NOT_FOUND' | 'NOT_APPROVED' | 'COPYRIGHT_VIOLATION';

/** ag-music `POST /tracks/export-status`: one per id asked, in the same order. */
export interface AgMusicExportStatus { trackId: number; usable: boolean; reason: AgMusicExportBlock | null; copyrightStatus: string | null }

export const AG_MUSIC_SORTS = ['NEWEST', 'MOST_DOWNLOADED', 'MOST_PLAYED', 'NAME'] as const;
export type AgMusicSort = (typeof AG_MUSIC_SORTS)[number];

/** The filters of ag-music's track list Studio passes on (in a group "or", between groups "and"). */
export interface AgMusicTrackFilter {
  keyword?: string | undefined;
  types?: AgMusicTrackType[] | undefined;
  categoryIds?: number[] | undefined;
  artistIds?: number[] | undefined;
  instrumental?: boolean | undefined;
  voiceGenders?: string[] | undefined;
  purposes?: string[] | undefined;
  origins?: string[] | undefined;
  releaseStatuses?: string[] | undefined;
  bpmFrom?: number | undefined;
  bpmTo?: number | undefined;
}

export interface AgMusicTrackQuery extends AgMusicTrackFilter { sort?: AgMusicSort | undefined; page?: number; size?: number }

/** Always approved tracks only (and not a copyright violation): the ones that can be copied. */
function filterParams(f: AgMusicTrackFilter): URLSearchParams {
  const params = new URLSearchParams({ approved: 'true' });
  const list = (k: string, v: readonly (string | number)[] | undefined) => { if (v?.length) params.set(k, v.join(',')); };
  if (f.keyword) params.set('keyword', f.keyword);
  list('types', f.types);
  list('categoryIds', f.categoryIds);
  list('artistIds', f.artistIds);
  if (f.instrumental !== undefined) params.set('instrumental', String(f.instrumental));
  list('voiceGenders', f.voiceGenders);
  list('purposes', f.purposes);
  list('origins', f.origins);
  list('releaseStatuses', f.releaseStatuses);
  if (f.bpmFrom !== undefined) params.set('bpmFrom', String(f.bpmFrom));
  if (f.bpmTo !== undefined) params.set('bpmTo', String(f.bpmTo));
  return params;
}

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

  /** Approved tracks the person may see, newest first unless `sort` says otherwise. */
  listTracks(accessToken: string, q: AgMusicTrackQuery): Promise<AgMusicPage<AgMusicTrackItem>> {
    const params = filterParams(q);
    params.set('sort', q.sort ?? 'NEWEST');
    params.set('page', String(q.page ?? 0));
    params.set('size', String(q.size ?? 20));
    return this.request('GET', `/tracks?${params}`, accessToken);
  }

  /** Counts per choice of the filter sidebar, on the approved tracks the person may see that match `f`. */
  facets(accessToken: string, f: AgMusicTrackFilter): Promise<AgMusicFacets> {
    return this.request('GET', `/tracks/facets?${filterParams(f)}`, accessToken);
  }

  track(accessToken: string, trackId: number): Promise<AgMusicTrackDetail> {
    return this.request('GET', `/tracks/${trackId}`, accessToken);
  }

  playback(accessToken: string, trackId: number): Promise<AgMusicPlayback> {
    return this.request('GET', `/tracks/${trackId}/playback`, accessToken);
  }

  /** The file to copy; no download counted yet (`confirmExport` once the copy is in the library). */
  exportTrack(accessToken: string, trackId: number): Promise<AgMusicExport> {
    return this.request('POST', `/tracks/${trackId}/export`, accessToken);
  }

  /** The copy is in the library: counts one download for the person, once per 30 minutes (not when they own the track). */
  confirmExport(accessToken: string, trackId: number): Promise<{ counted: boolean }> {
    return this.request('POST', `/tracks/${trackId}/export/confirm`, accessToken);
  }

  /** Whether tracks copied before may still be used (up to 100 ids). */
  exportStatus(accessToken: string, trackIds: number[]): Promise<AgMusicExportStatus[]> {
    return this.request('POST', '/tracks/export-status', accessToken, { ids: trackIds });
  }

  private async request<T>(method: string, path: string, accessToken: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new AgMusicClientError(0, null, `Không gọi được ag-music: ${(e as Error).message}`);
    }
    const answer = (res.headers.get('content-type') ?? '').includes('json') ? await res.json().catch(() => null) : null;
    const env = answer as { success?: boolean; data?: T; error?: { code?: string; detail?: string; title?: string } } | null;
    if (!res.ok || env?.success === false) {
      const err = env?.error;
      throw new AgMusicClientError(res.status, err?.code ?? null, err?.detail || err?.title || `ag-music trả HTTP ${res.status}`);
    }
    if (!env || !('data' in env)) throw new AgMusicClientError(502, null, 'ag-music trả dữ liệu không đúng dạng');
    return env.data as T;
  }
}
