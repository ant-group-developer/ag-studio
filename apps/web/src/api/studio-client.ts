import { useAuthToken } from "../auth/use-auth-token";
import type { TimelineV2 } from "@harness/contracts";
import type { TimelineIssue } from "@studio/timeline";

const STUDIO_API_URL =
  (import.meta.env.VITE_STUDIO_API_URL as string | undefined) ??
  "http://localhost:3100";

export interface Team {
  id: string;
  name: string;
  createdAt: string;
}

export interface TeamMember {
  userId: string;
  role: string;
  joinedAt: string;
}

export interface Production {
  id: string;
  teamId: string;
  title: string;
  brief: string | null;
  status: string;
  canvas: { width: number; height: number } | null;
  runId: string | null;
  sources: string[];
  createdAt: string;
  updatedAt: string;
  ownerUserId: string | null;
  targetSeconds: number | null;
  aspect: "16:9" | "9:16";
  language: string;
  voice: { reference: string | null; referenceText: string | null; speed: number };
  music: { track: string; gainDb: number; ducking: boolean } | null;
}

export interface BriefFields {
  targetSeconds?: number;
  aspect?: "16:9" | "9:16";
  language?: string;
  voice?: { reference?: string | null; referenceText?: string | null; speed: number } | null;
  music?: { track: string; gainDb: number; ducking: boolean } | null;
}

export interface CreateProductionData extends BriefFields {
  title: string;
  brief?: string;
}

export interface UpdateProductionData extends BriefFields {
  title: string;
  brief: string;
}

export interface ProductionAccess {
  hasAccess: boolean;
}

/** A non-2xx answer; `body` is the API's JSON error (e.g. `{ code: "revision_conflict", currentRevision }`). */
export class StudioHttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown> | null) {
    super(typeof body?.message === "string" ? body.message : `HTTP ${status}`);
    this.name = "StudioHttpError";
  }
}

async function request<T>(
  getAccessToken: () => Promise<string>,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${STUDIO_API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let parsed: Record<string, unknown> | null = null;
    try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
    throw new StudioHttpError(res.status, parsed);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function createStudioClient(getAccessToken: () => Promise<string>) {
  return {
    createTeam(name: string): Promise<Team> {
      return request<Team>(getAccessToken, "POST", "/api/teams", { name });
    },

    listTeams(): Promise<Team[]> {
      return request<Team[]>(getAccessToken, "GET", "/api/teams");
    },

    listMembers(teamId: string): Promise<TeamMember[]> {
      return request<TeamMember[]>(
        getAccessToken,
        "GET",
        `/api/teams/${teamId}/members`
      );
    },

    addMember(
      teamId: string,
      userId: string,
      role: string
    ): Promise<TeamMember> {
      return request<TeamMember>(
        getAccessToken,
        "POST",
        `/api/teams/${teamId}/members`,
        { userId, role }
      );
    },

    removeMember(teamId: string, userId: string): Promise<void> {
      return request<void>(
        getAccessToken,
        "DELETE",
        `/api/teams/${teamId}/members/${userId}`
      );
    },

    updateMemberRole(
      teamId: string,
      userId: string,
      role: string
    ): Promise<TeamMember> {
      return request<TeamMember>(
        getAccessToken,
        "PATCH",
        `/api/teams/${teamId}/members/${userId}`,
        { role }
      );
    },

    createProduction(
      teamId: string,
      data: CreateProductionData
    ): Promise<Production> {
      return request<Production>(
        getAccessToken,
        "POST",
        `/api/teams/${teamId}/productions`,
        data
      );
    },

    listProductions(teamId: string): Promise<Production[]> {
      return request<Production[]>(
        getAccessToken,
        "GET",
        `/api/teams/${teamId}/productions`
      );
    },

    getProduction(id: string): Promise<Production> {
      return request<Production>(
        getAccessToken,
        "GET",
        `/api/productions/${id}`
      );
    },

    updateProduction(
      id: string,
      data: Partial<UpdateProductionData>
    ): Promise<Production> {
      return request<Production>(
        getAccessToken,
        "PATCH",
        `/api/productions/${id}`,
        data
      );
    },

    setProductionSources(id: string, folderIds: string[]): Promise<Production> {
      return request<Production>(
        getAccessToken,
        "POST",
        `/api/productions/${id}/sources`,
        { folderIds }
      );
    },

    checkProductionAccess(id: string): Promise<ProductionAccess> {
      return request<ProductionAccess>(
        getAccessToken,
        "GET",
        `/api/productions/${id}/access`
      );
    },

    // ---- workflow ag-studio-production@1.0.0 ----
    startRun(id: string): Promise<{ runId: string }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/run`);
    },
    getRun(id: string): Promise<RunView> {
      return request(getAccessToken, "GET", `/api/productions/${id}/run`);
    },
    getStageDocument<T = unknown>(id: string, stage: string, name: string): Promise<T> {
      return request(getAccessToken, "GET", `/api/productions/${id}/run/documents/${stage}/${name}`);
    },
    submitGate(id: string, gate: "approve-treatment" | "shot-board" | "edit", document?: unknown): Promise<{ stageState: string; runState: string }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/run/gates/${gate}`, document === undefined ? {} : { document });
    },
    retryStage(id: string, stage: string): Promise<{ ok: true }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/run/stages/${stage}/retry`);
    },
    cancelRun(id: string): Promise<{ ok: true }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/run/cancel`);
    },

    // ---- editor (timeline revisions, TTS, preview) ----
    getTimeline(id: string): Promise<TimelineRevisionView> {
      return request(getAccessToken, "GET", `/api/productions/${id}/timeline`);
    },
    listRevisions(id: string): Promise<RevisionSummary[]> {
      return request(getAccessToken, "GET", `/api/productions/${id}/timeline/revisions`);
    },
    /** 409 (`StudioHttpError`, body `{ code: "revision_conflict", currentRevision }`) when `baseRevision` is stale. */
    saveRevision(id: string, baseRevision: number, data: TimelineV2, label?: string): Promise<{ revision: number; issues: TimelineIssue[] }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/timeline/revisions`, { baseRevision, data, ...(label ? { label } : {}) });
    },
    ttsLine(id: string, lineId: string, text: string): Promise<EditorJob> {
      return request(getAccessToken, "POST", `/api/productions/${id}/editor/tts`, { lineId, text });
    },
    renderPreview(id: string, revision: number): Promise<EditorJob> {
      return request(getAccessToken, "POST", `/api/productions/${id}/editor/previews`, { revision });
    },
    getEditorJob(id: string, jobId: string): Promise<EditorJob> {
      return request(getAccessToken, "GET", `/api/productions/${id}/editor/jobs/${jobId}`);
    },
    audioUrl(id: string, key: string): Promise<{ url: string }> {
      return request(getAccessToken, "GET", `/api/productions/${id}/audio?key=${encodeURIComponent(key)}`);
    },
    getExports(id: string): Promise<ExportsView> {
      return request(getAccessToken, "GET", `/api/productions/${id}/exports`);
    },
  };
}

export interface StageView {
  key: string;
  executor: "script" | "agent" | "gate" | "farm";
  state: string;
  attempts: number;
  is_gate: boolean;
  error: string | null;
  failed_checks: { check_id: string; evidence: Record<string, unknown> }[];
  outputs: { name: string; type: string; size_bytes: number }[];
}
export interface RunView {
  run_id: string;
  state: string;
  created_at: string;
  updated_at: string;
  cost_usd: number;
  waiting_gate: "approve-treatment" | "shot-board" | "edit" | null;
  stages: StageView[];
  latest_revision: number | null;
}
export interface TimelineRevisionView {
  revision: number;
  base_revision: number;
  data: TimelineV2;
  author_id: string;
  label: string | null;
  created_at: string;
  issues: TimelineIssue[];
}
export interface RevisionSummary { revision: number; base_revision: number; author_id: string; label: string | null; created_at: string }
export interface EditorJob {
  id: string;
  kind: "tts_line" | "render_preview";
  status: "queued" | "running" | "completed" | "failed";
  request: Record<string, unknown>;
  /** tts_line: `{ line_id, text, key, duration }`; render_preview: `{ key, duration_s, watermarked, revision }`. */
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  /** Signed URL of a finished preview, absent when footage scope does not cover the production. */
  url?: string;
  urlHidden?: "footage_scope";
}
export interface ExportsView {
  durationSeconds: number;
  watermarked: boolean;
  files: { kind: "mp4" | "srt" | "vtt" | "timeline"; name: string; sizeBytes: number; url: string | null; urlHidden?: "footage_scope" }[];
}

export type StudioClient = ReturnType<typeof createStudioClient>;

export function useStudioClient(): StudioClient {
  const { getAccessToken } = useAuthToken();
  return createStudioClient(getAccessToken);
}
