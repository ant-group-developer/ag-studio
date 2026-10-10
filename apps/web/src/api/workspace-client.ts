/**
 * The Studio API of the agent workspace (spec 2026-10-10 agent-workspace): a team's projects (one YouTube channel
 * each), their videos, and the project's files.
 */
import { useMemo } from "react";
import { useAuthToken } from "../auth/use-auth-token";
import { buildQuery, request, requestBlob } from "./http";

export type ProjectAspect = "16:9" | "9:16";
export type VideoStatus = "draft" | "in_progress" | "rendering" | "done";

export interface ProjectSettings {
  model?: string;
  target_seconds?: number;
  team_skills?: string[];
  auto_fix: boolean;
  auto_continue: boolean;
}

export interface Project {
  id: string;
  teamId: string;
  name: string;
  channelUrl: string | null;
  description: string;
  language: string;
  aspect: ProjectAspect;
  settings: ProjectSettings;
  ownerUserId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProjectListItem extends Project {
  videoCount: number;
  lastActivityAt: string;
}

export interface Video {
  id: string;
  projectId: string;
  idx: number;
  title: string;
  status: VideoStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateProjectInput {
  name: string;
  channelUrl?: string;
  description?: string;
  language?: string;
  aspect?: ProjectAspect;
}

export type UpdateProjectInput = Partial<Omit<CreateProjectInput, "channelUrl">> & {
  channelUrl?: string | null;
  settings?: ProjectSettings;
};

export type FileAccess = "write" | "read" | "none";

export interface WorkspaceEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
  mtime: string;
  access: FileAccess;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  sha256: string;
  mtime: string;
  mime: string;
  binary: boolean;
  text: string | null;
}

export interface SavedFile {
  path: string;
  sha256: string;
  size: number;
  versionId: string;
}

export interface FileVersion {
  id: string;
  path: string;
  sha256: string;
  size: number;
  author_kind: "user" | "agent" | "studio";
  author_id: string | null;
  message_id: string | null;
  created_at: string;
  has_content: number;
}

export interface FileVersionDetail extends FileVersion {
  content: string | null;
  issues: string | null;
}

const enc = encodeURIComponent;

export function createWorkspaceClient(getAccessToken: () => Promise<string>) {
  const call = <T,>(method: string, path: string, body?: unknown) => request<T>(getAccessToken, method, path, body);
  return {
    // ---- Projects ----
    listProjects(teamId: string, opts: { archived?: boolean } = {}): Promise<{ projects: ProjectListItem[] }> {
      return call("GET", `/api/teams/${enc(teamId)}/projects${buildQuery({ archived: opts.archived ? "true" : undefined })}`);
    },
    createProject(teamId: string, input: CreateProjectInput): Promise<Project> {
      return call("POST", `/api/teams/${enc(teamId)}/projects`, input);
    },
    getProject(projectId: string): Promise<Project & { videos: Video[] }> {
      return call("GET", `/api/projects/${enc(projectId)}`);
    },
    updateProject(projectId: string, patch: UpdateProjectInput): Promise<Project> {
      return call("PATCH", `/api/projects/${enc(projectId)}`, patch);
    },
    archiveProject(projectId: string): Promise<void> {
      return call("DELETE", `/api/projects/${enc(projectId)}`);
    },

    // ---- Videos ----
    listVideos(projectId: string): Promise<{ videos: Video[] }> {
      return call("GET", `/api/projects/${enc(projectId)}/videos`);
    },
    createVideo(projectId: string, input: { title?: string } = {}): Promise<Video> {
      return call("POST", `/api/projects/${enc(projectId)}/videos`, input);
    },
    getVideo(videoId: string): Promise<Video> {
      return call("GET", `/api/videos/${enc(videoId)}`);
    },
    updateVideo(videoId: string, patch: { title?: string; status?: VideoStatus }): Promise<Video> {
      return call("PATCH", `/api/videos/${enc(videoId)}`, patch);
    },
    archiveVideo(videoId: string): Promise<void> {
      return call("DELETE", `/api/videos/${enc(videoId)}`);
    },

    // ---- Files ----
    listFiles(projectId: string): Promise<{ entries: WorkspaceEntry[] }> {
      return call("GET", `/api/projects/${enc(projectId)}/files`);
    },
    readFile(projectId: string, path: string): Promise<WorkspaceFile> {
      return call("GET", `/api/projects/${enc(projectId)}/files/content${buildQuery({ path })}`);
    },
    fileBlob(projectId: string, path: string): Promise<Blob> {
      return requestBlob(getAccessToken, `/api/projects/${enc(projectId)}/files/raw${buildQuery({ path })}`);
    },
    /** `baseSha256`: the checksum of the copy edited; `null` for a new file. 409 `file_conflict` when it moved. */
    writeFile(projectId: string, input: { path: string; content: string; baseSha256?: string | null }): Promise<SavedFile> {
      return call("PUT", `/api/projects/${enc(projectId)}/files/content`, input);
    },
    deleteFile(projectId: string, path: string, baseSha256?: string): Promise<void> {
      return call("DELETE", `/api/projects/${enc(projectId)}/files${buildQuery({ path, baseSha256 })}`);
    },
    uploadFile(projectId: string, file: File, dir?: string): Promise<SavedFile> {
      const form = new FormData();
      form.append("file", file);
      if (dir) form.append("dir", dir);
      return call("POST", `/api/projects/${enc(projectId)}/files/upload`, form);
    },
    listFileVersions(projectId: string, path: string): Promise<{ versions: FileVersion[] }> {
      return call("GET", `/api/projects/${enc(projectId)}/files/versions${buildQuery({ path })}`);
    },
    getFileVersion(projectId: string, versionId: string): Promise<FileVersionDetail> {
      return call("GET", `/api/projects/${enc(projectId)}/files/versions/${enc(versionId)}`);
    },
    restoreFileVersion(projectId: string, versionId: string, baseSha256?: string | null): Promise<SavedFile> {
      return call("POST", `/api/projects/${enc(projectId)}/files/versions/${enc(versionId)}/restore`, baseSha256 === undefined ? {} : { baseSha256 });
    },
  };
}

export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;

export function useWorkspaceClient(): WorkspaceClient {
  const { getAccessToken } = useAuthToken();
  return useMemo(() => createWorkspaceClient(getAccessToken), [getAccessToken]);
}
