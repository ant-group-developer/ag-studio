import { useMemo } from "react";
import { useAuthToken } from "../auth/use-auth-token";

const AG_GO_API_URL = import.meta.env.VITE_AG_GO_API_URL as string | undefined;

export interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  usableVideos: number;
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

/** An ag-go project as `GET /projects` lists it (the person's own scope). */
export interface AgGoProject {
  id: string;
  name: string;
  folderPath?: string;
  folderName?: string;
  videoCount: number;
  imageCount: number;
  mediaCount: number;
  ownerUser?: { id: string; name?: string } | null;
}

export interface AgGoProjectPage {
  items: AgGoProject[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** One media item of an ag-go project (`GET /projects/:id/media`). */
export interface AgGoProjectMedia {
  id: string;
  assetId: string;
  caption: string | null;
  thumbnailUrl?: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  asset: { assetType: "image" | "video"; originalFilename?: string | null };
}

export interface AgGoProjectMediaPage {
  items: AgGoProjectMedia[];
  nextCursor: string | null;
}

async function agGoGet<T>(accessToken: string, path: string): Promise<T> {
  if (!AG_GO_API_URL) throw new Error("VITE_AG_GO_API_URL is not configured");
  const res = await fetch(`${AG_GO_API_URL}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return unwrapAgGoResponse<T>(await res.json());
}

/** The ag-go projects the person can see, by name (`keyword`), a page at a time. */
export function getAgGoProjects(accessToken: string, q: { keyword?: string; page?: number; pageSize?: number } = {}): Promise<AgGoProjectPage> {
  const query = new URLSearchParams();
  if (q.keyword) query.set("keyword", q.keyword);
  query.set("page", String(q.page ?? 1));
  query.set("pageSize", String(q.pageSize ?? 20));
  return agGoGet(accessToken, `/projects?${query.toString()}`);
}

/** The media of one ag-go project, a page at a time (`limit` ≤ 100). */
export function getAgGoProjectMedia(accessToken: string, projectId: string, q: { cursor?: string; limit?: number } = {}): Promise<AgGoProjectMediaPage> {
  const query = new URLSearchParams();
  if (q.cursor) query.set("cursor", q.cursor);
  query.set("limit", String(q.limit ?? 60));
  return agGoGet(accessToken, `/projects/${encodeURIComponent(projectId)}/media?${query.toString()}`);
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

export type AgGoWebClient = ReturnType<typeof createAgGoWebClient>;

/** ag-go API helpers bound to a token getter. */
export function createAgGoWebClient(getAccessToken: () => Promise<string>) {
  return {
    getFolders: async (): Promise<FolderListResponse> => {
      const token = await getAccessToken();
      return getFolders(token);
    },
    getProjects: async (q: { keyword?: string; page?: number; pageSize?: number } = {}): Promise<AgGoProjectPage> => getAgGoProjects(await getAccessToken(), q),
    getProjectMedia: async (projectId: string, q: { cursor?: string; limit?: number } = {}): Promise<AgGoProjectMediaPage> =>
      getAgGoProjectMedia(await getAccessToken(), projectId, q),
  };
}

/** React hook that returns ag-go API helpers bound to the current Auth0 token (stable across renders). */
export function useAgGoClient(): AgGoWebClient {
  const { getAccessToken } = useAuthToken();
  return useMemo(() => createAgGoWebClient(getAccessToken), [getAccessToken]);
}
