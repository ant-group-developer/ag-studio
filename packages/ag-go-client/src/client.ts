import { AgGoClientError, unwrapAgGoResponse } from "./error.js";
import type {
  GetFoldersResponse,
  FootageVideoResponse,
  AssetMediaResponse,
  ResolveAssetsBody,
  ResolveAssetsResponse,
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

    return unwrapAgGoResponse<T>(responseBody);
  }

  getFolders(actAsUserId: string): Promise<GetFoldersResponse> {
    return this.request<GetFoldersResponse>("GET", "/footage/folders", actAsUserId);
  }

  /**
   * GĐ2 (v3): fetch whole-asset footage records from ag-go.
   * Satisfies `FootageCatalogSource.getCatalog` in @ag-studio/engine.
   */
  getCatalog(
    actAsUserId: string,
    body: { folderIds: string[]; usableOnly?: boolean; minQuality?: number; orientations?: string[]; q?: string; limit?: number; cursor?: string },
  ): Promise<FootageVideoResponse> {
    return this.request<FootageVideoResponse>("POST", "/footage/catalog", actAsUserId, body);
  }

  /** GĐ2 (v3): get media URLs for one asset (preview, poster, keyframes). */
  getAssetMedia(actAsUserId: string, assetId: string): Promise<AssetMediaResponse> {
    return this.request<AssetMediaResponse>(
      "GET",
      `/footage/assets/${encodeURIComponent(assetId)}/media`,
      actAsUserId,
    );
  }

  /** GĐ2 (v3): resolve asset IDs → signed download URLs. */
  resolveAssets(actAsUserId: string, body: ResolveAssetsBody): Promise<ResolveAssetsResponse> {
    return this.request<ResolveAssetsResponse>("POST", "/footage/assets/resolve", actAsUserId, body);
  }
}
