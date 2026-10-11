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

export interface ResolveAssetsBody {
  assetIds: string[];
  purpose: 'preview' | 'final';
  /** Mirror of `@ag-studio/ag-go-client`: a clean rendition first, then the short edge nearest; older ag-go ignores it. */
  prefer?: { short_edge?: number; clean?: boolean };
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
  /** Asset ids ag-go could not serve to this user. */
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

  private buildHeaders(actAsUserId: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Service-Key': this.serviceKey,
      'X-Act-As-User': actAsUserId,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    actAsUserId: string,
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

  /** The analysed videos of ag-go projects (or folders) the user can reach. */
  searchFootage(actAsUserId: string, query: SearchFootageQuery): Promise<SearchFootageResponse> {
    const qs = footageParams(query).toString();
    return this.request<SearchFootageResponse>('GET', `/footage/search${qs ? `?${qs}` : ''}`, actAsUserId);
  }

  /** How many videos have each tag, genre, category… under the filters (a facet leaves its own filter out). */
  getFootageFacets(actAsUserId: string, filters: FootageFilters): Promise<FootageFacets> {
    const qs = footageParams(filters).toString();
    return this.request<FootageFacets>('GET', `/footage/facets${qs ? `?${qs}` : ''}`, actAsUserId);
  }

  /** GĐ2 (v3): resolve whole-asset IDs → signed download URLs. */
  resolveAssets(actAsUserId: string, body: ResolveAssetsBody): Promise<ResolveAssetsResponse> {
    return this.request<ResolveAssetsResponse>('POST', '/footage/assets/resolve', actAsUserId, body);
  }

  /** GĐ2 (v3): get media URLs for one asset. */
  getAssetMedia(actAsUserId: string, assetId: string): Promise<AssetMediaResponse> {
    return this.request<AssetMediaResponse>('GET', `/footage/assets/${encodeURIComponent(assetId)}/media`, actAsUserId);
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
