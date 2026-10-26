/**
 * CJS reimplementation of @ag-studio/ag-go-client for use in this CommonJS NestJS app.
 * Avoids ESM/CJS interop issues.
 */

export interface AgGoClientOptions {
  baseUrl: string;
  serviceKey: string;
  timeoutMs?: number;
}

export interface FolderItem {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  analyzedVideos: number;
  usableVideos: number;
}

export interface GetFoldersResponse {
  folders: FolderItem[];
}

/** ag-go `POST /footage/studio/assets/resolve` (trusted mode): only videos of `projectIds` are served, the others are `missing`. */
export interface StudioResolveAssetsBody {
  projectIds: string[];
  assetIds: string[];
  purpose: 'preview' | 'final';
  /** Mirror of `@ag-studio/ag-go-client`: a clean rendition first, then the short edge nearest. */
  prefer?: { short_edge?: number; clean?: boolean };
}

/** What a person may do with one ag-go project (`POST /footage/projects/access`, asked as that person). */
export interface AgGoProjectAccess {
  projectId: string;
  /** Listed for them on ag-go's Projects page (watermarked unless the originals are open). */
  canView: boolean;
  /** They may download its originals: only such projects are added to a Studio project. */
  canDownloadOriginals: boolean;
  /** Analysed videos (0 when they cannot see the project), and the usable ones among them. */
  analyzedVideos: number;
  usableVideos: number;
}

/** Mirrors of ag-go's footage search vocabulary (`footage/dto/search-query.dto.ts`). */
export const FOOTAGE_RESOLUTIONS = ['4k', '2k', '1080p', '720p', 'sd'] as const;
export const FOOTAGE_SORT_FIELDS = ['relevance', 'analyzedAt', 'quality', 'duration', 'resolution', 'name', 'folder', 'project'] as const;
export const FOOTAGE_USABILITIES = ['usable', 'unusable', 'all'] as const;

/** Filters of ag-go `GET /footage/search` and `GET /footage/facets`. */
export interface FootageFilters {
  projectIds?: string[];
  folderIds?: string[];
  q?: string;
  categoryIds?: string[];
  ownerUserIds?: string[];
  provinceIds?: string[];
  resolutions?: (typeof FOOTAGE_RESOLUTIONS)[number][];
  tags?: string[];
  genres?: string[];
  timesOfDay?: string[];
  orientations?: string[];
  minDurationMs?: number;
  maxDurationMs?: number;
  usability?: (typeof FOOTAGE_USABILITIES)[number];
}

/** Query of ag-go `GET /footage/search` (mirror of `@ag-studio/ag-go-client`); `page` wins over `cursor`. */
export interface SearchFootageQuery extends FootageFilters {
  limit?: number;
  cursor?: string;
  page?: number;
  sortBy?: (typeof FOOTAGE_SORT_FIELDS)[number];
  sortOrder?: 'asc' | 'desc';
}

/** One value of a footage facet: how many videos have it under the other filters. */
export interface FacetValue { value: string; label?: string; count: number }

export interface FootageFacets {
  tags: FacetValue[];
  genres: FacetValue[];
  timesOfDay: FacetValue[];
  orientations: FacetValue[];
  resolutions: FacetValue[];
  categories: FacetValue[];
  provinces: FacetValue[];
  projects: FacetValue[];
  authors: FacetValue[];
}

/** Query string of footage filters: lists comma-joined, empty ones left out, in a fixed order. */
function footageParams(query: SearchFootageQuery): URLSearchParams {
  const params = new URLSearchParams();
  const order: (keyof SearchFootageQuery)[] = [
    'projectIds', 'folderIds', 'q', 'categoryIds', 'ownerUserIds', 'provinceIds', 'resolutions', 'tags', 'genres', 'timesOfDay', 'orientations',
    'minDurationMs', 'maxDurationMs', 'usability', 'page', 'cursor', 'limit', 'sortBy', 'sortOrder',
  ];
  for (const key of order) {
    const v = query[key];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) { if (v.length) params.set(key, v.join(',')); } else params.set(key, String(v));
  }
  return params;
}

export interface FootageSearchItem {
  assetId: string;
  name: string;
  projectIds?: string[] | null;
  projectNames?: string[] | null;
  durationMs: number;
  width?: number | null;
  height?: number | null;
  orientation?: string | null;
  hasAudio?: boolean | null;
  hasSpeech?: boolean | null;
  thumbnailUrl?: string | null;
  titleVi?: string | null;
  summaryVi?: string | null;
  folderIds?: string[] | null;
  analyzedAt?: string | null;
  quality?: number | null;
  genre?: string | null;
  timeOfDay?: string | null;
  tags?: string[] | null;
  usable?: boolean | null;
}

export interface SearchFootageResponse {
  items: FootageSearchItem[];
  nextCursor: string | null;
  total: number;
}

export interface ResolvedAssetItem {
  assetId: string;
  url: string;
  sourceKind: 'original' | 'proxy' | 'preview';
  watermarked: boolean;
  contentType: string;
  sizeBytes: number | null;
  cacheKey: string | null;
  expiresAt: string;
}

export interface ResolveAssetsResponse {
  items: ResolvedAssetItem[];
  /** Asset ids ag-go could not serve (trusted mode: those outside the projects given). */
  missing?: string[];
}

export interface AssetMediaResponse {
  assetId: string;
  previewUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  watermarked: boolean;
  posterUrl: string | null;
  keyframes: { url: string; tMs: number }[];
  contactSheetUrl: string | null;
  durationMs: number;
  expiresAt: string;
}

/** Where the prep of one footage stands at ag-go (mirror of `@ag-studio/ag-go-client`, contract H2 of plan 2026-10-13). */
export type AssetPrepState = 'ready' | 'running' | 'missing' | 'failed';
export type AssetPrepPhase = 'queued' | 'cutting' | 'transcribing';
export type AssetPrepTranscriptStatus = 'none' | 'skipped' | 'done' | 'failed';

export interface AssetPrepTranscript {
  language: string | null;
  alignment: 'word' | 'segment';
  engine: string;
  segments: { start: number; end: number; text: string; words: { word: string; start: number; end: number; score?: number }[] }[];
}

/** A ready prep: shots, a 480 px frame per shot and contact sheets (signed GET urls), the raw transcript. */
export interface AssetPrep {
  prepId: string;
  preparedAt: string;
  durationS: number;
  width: number;
  height: number;
  fps: number | null;
  hasAudio: boolean;
  sourceKind: string;
  watermarked: boolean;
  scene: { threshold: number; minShotS: number; maxShotS: number };
  shots: { n: number; in: number; out: number; frame: string; url: string }[];
  sheets: { file: string; shots: number[]; url: string }[];
  transcriptStatus: AssetPrepTranscriptStatus;
  transcript: AssetPrepTranscript | null;
}

export interface AssetPrepItem {
  assetId: string;
  state: AssetPrepState;
  phase: AssetPrepPhase | null;
  progress: number | null;
  error: string | null;
  prep: AssetPrep | null;
}

export interface AssetPrepsResponse {
  items: AssetPrepItem[];
}

export class AgGoClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`AgGoClient HTTP ${status}`);
    this.name = 'AgGoClientError';
  }
}

export class AgGoClient {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly timeoutMs: number;

  constructor(opts: AgGoClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.serviceKey = opts.serviceKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** `actAsUserId` null: ag-go's trusted mode for Studio (`/footage/studio/*`, no `X-Act-As-User`). */
  private buildHeaders(actAsUserId: string | null): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Service-Key': this.serviceKey,
      ...(actAsUserId !== null ? { 'X-Act-As-User': actAsUserId } : {}),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    actAsUserId: string | null,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildHeaders(actAsUserId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } finally {
      clearTimeout(timer);
    }

    let responseBody: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    if (!response.ok) {
      throw new AgGoClientError(response.status, responseBody);
    }

    return unwrapAgGoResponse<T>(responseBody);
  }

  getFolders(actAsUserId: string): Promise<GetFoldersResponse> {
    return this.request<GetFoldersResponse>('GET', '/footage/folders', actAsUserId);
  }

  /** Whether the person sees each ag-go project and may download its originals, with its analysed and usable videos. */
  projectAccess(actAsUserId: string, projectIds: string[]): Promise<{ items: AgGoProjectAccess[] }> {
    return this.request<{ items: AgGoProjectAccess[] }>('POST', '/footage/projects/access', actAsUserId, { projectIds });
  }

  /**
   * The analysed videos of `projectIds` (ag-go projects added to a Studio project), in ag-go's trusted mode for Studio:
   * the service key alone, whoever asks.
   */
  studioSearchFootage(query: SearchFootageQuery & { projectIds: string[] }): Promise<SearchFootageResponse> {
    const qs = footageParams(query).toString();
    return this.request<SearchFootageResponse>('GET', `/footage/studio/search?${qs}`, null);
  }

  /** How many videos of `projectIds` have each tag, genre, category… under the filters (a facet leaves its own filter out). */
  studioFootageFacets(filters: FootageFilters & { projectIds: string[] }): Promise<FootageFacets> {
    const qs = footageParams(filters).toString();
    return this.request<FootageFacets>('GET', `/footage/studio/facets?${qs}`, null);
  }

  /** Signed URLs of whole videos of `projectIds` (originals for a final render); the others are `missing`. */
  studioResolveAssets(body: StudioResolveAssetsBody): Promise<ResolveAssetsResponse> {
    return this.request<ResolveAssetsResponse>('POST', '/footage/studio/assets/resolve', null, body);
  }

  /** GĐ2 (v3): get media URLs for one asset. */
  getAssetMedia(actAsUserId: string, assetId: string): Promise<AssetMediaResponse> {
    return this.request<AssetMediaResponse>('GET', `/footage/assets/${encodeURIComponent(assetId)}/media`, actAsUserId);
  }

  /** The prep of each footage (shots, frames, sheets, transcript when ready; else how far it is). */
  getAssetPreps(actAsUserId: string, assetIds: string[]): Promise<AssetPrepsResponse> {
    return this.request<AssetPrepsResponse>('POST', '/footage/assets/prep', actAsUserId, { assetIds });
  }

  /** Asks ag-go to prep missing or failed footage now (or to raise one waiting in a backfill); answers like `getAssetPreps`. */
  runAssetPreps(actAsUserId: string, assetIds: string[]): Promise<AssetPrepsResponse> {
    return this.request<AssetPrepsResponse>('POST', '/footage/assets/prep/run', actAsUserId, { assetIds });
  }
}

/**
 * ag-go-api answers `{ data, requestId, success, error, timestamp }` (its ApiResponseInterceptor); the payload
 * is `data`. A body without that envelope is returned as is.
 */
export function unwrapAgGoResponse<T>(body: unknown): T {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (typeof b.success === 'boolean' && 'data' in b && typeof b.requestId === 'string') return b.data as T;
  }
  return body as T;
}
