import { AgGoClientError, unwrapAgGoResponse } from "./error.js";
import type {
  AssetPrepsResponse,
  GetFoldersResponse,
  FootageVideoResponse,
  AssetMediaResponse,
  ResolveAssetsBody,
  ResolveAssetsResponse,
  SearchFootageQuery,
  SearchFootageResponse,
  StudioUsageEvent,
  StudioUsageEventsResponse,
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

  /** `actAsUserId` null: a service-only route (no `X-Act-As-User`). */
  private buildHeaders(actAsUserId: string | null): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Service-Key": this.serviceKey,
      ...(actAsUserId !== null ? { "X-Act-As-User": actAsUserId } : {}),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    actAsUserId: string | null,
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

  /** The analysed videos of ag-go projects (or folders) the user can reach, for a project's inputs. */
  searchFootage(actAsUserId: string, query: SearchFootageQuery): Promise<SearchFootageResponse> {
    const params = new URLSearchParams();
    if (query.projectIds?.length) params.set("projectIds", query.projectIds.join(","));
    if (query.folderIds?.length) params.set("folderIds", query.folderIds.join(","));
    if (query.q) params.set("q", query.q);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor) params.set("cursor", query.cursor);
    const qs = params.toString();
    return this.request<SearchFootageResponse>("GET", `/footage/search${qs ? `?${qs}` : ""}`, actAsUserId);
  }

  /** GĐ2 (v3): resolve asset IDs → signed download URLs. */
  resolveAssets(actAsUserId: string, body: ResolveAssetsBody): Promise<ResolveAssetsResponse> {
    return this.request<ResolveAssetsResponse>("POST", "/footage/assets/resolve", actAsUserId, body);
  }

  /** The prep of each footage (shots, frames, sheets, transcript when ready; else how far it is), acting as the user. */
  getAssetPreps(actAsUserId: string, assetIds: string[]): Promise<AssetPrepsResponse> {
    return this.request<AssetPrepsResponse>("POST", "/footage/assets/prep", actAsUserId, { assetIds });
  }

  /** Asks ag-go to prep missing or failed footage now (or to raise one waiting in a backfill); answers like `getAssetPreps`. */
  runAssetPreps(actAsUserId: string, assetIds: string[]): Promise<AssetPrepsResponse> {
    return this.request<AssetPrepsResponse>("POST", "/footage/assets/prep/run", actAsUserId, { assetIds });
  }

  /** Footage usage events (1–500), with the service key alone (scope `usage:write`); a resent `eventKey` counts once. */
  sendUsageEvents(events: StudioUsageEvent[]): Promise<StudioUsageEventsResponse> {
    return this.request<StudioUsageEventsResponse>("POST", "/usage/studio-events", null, { events });
  }
}
