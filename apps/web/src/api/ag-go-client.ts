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
  return res.json() as Promise<FolderListResponse>;
}
