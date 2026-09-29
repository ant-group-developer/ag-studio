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
  analyzedSegments: number;
  usableSegments: number;
}

export interface GetFoldersResponse {
  folders: FolderItem[];
}

export interface FootageCatalogBody {
  folderIds: string[];
  filters?: { usable?: boolean; minQuality?: number };
  limit?: number;
  cursor?: string;
}

export interface CatalogItem {
  segmentId: string;
  assetId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  captionVi: string;
  captionEn: string;
  tags: string[];
  usable: boolean;
  approved: boolean;
}

export interface CatalogResponse {
  items: CatalogItem[];
  nextCursor: string | null;
}

export interface ResolveSegmentsBody {
  segmentIds: string[];
  purpose: 'preview' | 'final';
}

export interface ResolvedSegmentItem {
  segmentId: string;
  assetId: string;
  startMs: number;
  endMs: number;
  url: string;
  sourceKind: 'original' | 'proxy' | 'preview';
  watermarked: boolean;
  contentType: string;
  sizeBytes: number | null;
  cacheKey: string | null;
  expiresAt: string;
}

export interface ResolveSegmentsResponse {
  items: ResolvedSegmentItem[];
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

    return responseBody as T;
  }

  getFolders(actAsUserId: string): Promise<GetFoldersResponse> {
    return this.request<GetFoldersResponse>('GET', '/footage/folders', actAsUserId);
  }

  getCatalog(actAsUserId: string, body: FootageCatalogBody): Promise<CatalogResponse> {
    return this.request<CatalogResponse>('POST', '/footage/catalog', actAsUserId, body);
  }

  resolveSegments(
    actAsUserId: string,
    body: ResolveSegmentsBody,
  ): Promise<ResolveSegmentsResponse> {
    return this.request<ResolveSegmentsResponse>(
      'POST',
      '/footage/segments/resolve',
      actAsUserId,
      body,
    );
  }
}
