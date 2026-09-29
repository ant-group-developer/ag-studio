import { AgGoClientError } from "./error.js";
import type {
  GetFoldersResponse,
  FootageCatalogBody,
  CatalogResponse,
  SegmentMediaResponse,
  ResolveSegmentsBody,
  ResolveSegmentsResponse,
} from "./types.js";

export interface AgGoClientOptions {
  baseUrl: string;
  serviceKey: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class AgGoClient {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: AgGoClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.serviceKey = opts.serviceKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  private buildHeaders(actAsUserId: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Service-Key": this.serviceKey,
      "X-Act-As-User": actAsUserId,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    actAsUserId: string,
    body?: unknown
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
      response = await this.fetchFn(url, init);
    } finally {
      clearTimeout(timer);
    }

    let responseBody: unknown;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
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
    return this.request<GetFoldersResponse>("GET", "/footage/folders", actAsUserId);
  }

  getCatalog(actAsUserId: string, body: FootageCatalogBody): Promise<CatalogResponse> {
    return this.request<CatalogResponse>("POST", "/footage/catalog", actAsUserId, body);
  }

  getSegmentMedia(actAsUserId: string, segmentId: string): Promise<SegmentMediaResponse> {
    return this.request<SegmentMediaResponse>(
      "GET",
      `/footage/segments/${encodeURIComponent(segmentId)}/media`,
      actAsUserId
    );
  }

  resolveSegments(
    actAsUserId: string,
    body: ResolveSegmentsBody
  ): Promise<ResolveSegmentsResponse> {
    return this.request<ResolveSegmentsResponse>(
      "POST",
      "/footage/segments/resolve",
      actAsUserId,
      body
    );
  }
}
