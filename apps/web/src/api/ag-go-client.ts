import { useAuthToken } from "../auth/use-auth-token";

const AG_GO_API_URL = import.meta.env.VITE_AG_GO_API_URL as string | undefined;

export interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  usableSegments: number;
}

export interface FolderListResponse {
  folders: FolderItem[];
}

export async function getFolders(
  accessToken: string
): Promise<FolderListResponse> {
  if (!AG_GO_API_URL) {
    throw new Error("VITE_AG_GO_API_URL is not configured");
  }
  const res = await fetch(`${AG_GO_API_URL}/footage/folders`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return unwrapAgGoResponse<FolderListResponse>(await res.json());
}

/**
 * Media for one footage segment, scoped to the viewer's own Auth0 token (ag-go enforces footage scope
 * itself). `previewUrl` is a watermarked preview of the *whole* asset -- play it from `startMs` to `endMs`
 * to see this segment.
 */
export interface SegmentMedia {
  segmentId: string;
  assetId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  keyframeUrls: string[];
  previewUrl: string | null;
  previewWidth: number;
}

/**
 * `null` when the segment's asset is outside the viewer's footage scope (ag-go answers 403/404): the caller
 * must fall back to text only (the segment's caption), never show an error page for this.
 */
export async function getSegmentMedia(
  accessToken: string,
  segmentId: string
): Promise<SegmentMedia | null> {
  if (!AG_GO_API_URL) {
    throw new Error("VITE_AG_GO_API_URL is not configured");
  }
  const res = await fetch(
    `${AG_GO_API_URL}/footage/segments/${encodeURIComponent(segmentId)}/media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return unwrapAgGoResponse<SegmentMedia>(await res.json());
}

/**
 * ag-go-api answers `{ data, requestId, success, error, timestamp }` (its ApiResponseInterceptor); the payload
 * is `data`. A body without that envelope is returned as is.
 */
export function unwrapAgGoResponse<T>(body: unknown): T {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (typeof b.success === "boolean" && "data" in b && typeof b.requestId === "string") return b.data as T;
  }
  return body as T;
}

/** React hook that returns ag-go API helpers bound to the current Auth0 token. */
export function useAgGoClient() {
  const { getAccessToken } = useAuthToken();
  return {
    getFolders: async (): Promise<FolderListResponse> => {
      const token = await getAccessToken();
      return getFolders(token);
    },
    getSegmentMedia: async (segmentId: string): Promise<SegmentMedia | null> => {
      const token = await getAccessToken();
      return getSegmentMedia(token, segmentId);
    },
  };
}
