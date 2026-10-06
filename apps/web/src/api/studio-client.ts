import { useAuthToken } from "../auth/use-auth-token";
import type { TimelineV3, YoutubeKit, SeriesPlan, StudioCatalog, StudioResearch, TrendReport, StudioRnd, StudioBranding, StudioBrief, ThumbnailStyle } from "@harness/contracts";
import type { TimelineIssue } from "@studio/timeline";

const STUDIO_API_URL =
  (import.meta.env.VITE_STUDIO_API_URL as string | undefined) ??
  "http://localhost:3100";

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

export type ProductionStatus = "draft" | "planning" | "waiting_approval" | "producing" | "done" | "failed" | "archived";
export type TeamRole = "owner" | "producer" | "editor" | "viewer";
export type EpisodeStatus = "planned" | "producing" | "waiting_approval" | "ready" | "failed" | "cancelled";

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MeProfile {
  userId: string;
  name: string;
  email: string;
  avatar: string | null;
  isAdmin: boolean;
}

export interface Team {
  id: string;
  name: string;
  role: TeamRole | null;
  memberCount: number;
  productionCount: number;
  createdAt: string;
}

/** A person as Account API knows them; fields are null when Account API has no match. */
export interface UserSummary {
  userId: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
}

export interface TeamMember extends UserSummary {
  role: TeamRole;
  joinedAt: string;
}

/** One team as its page shows it: the caller's role (null for an admin who is not a member) and counts. */
export interface TeamDetail {
  id: string;
  name: string;
  role: TeamRole | null;
  memberCount: number;
  productionCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The AI steps a team skill can apply to (an empty list = every step). */
export type TeamSkillStep = "intake" | "trend-report" | "rnd" | "branding" | "plan-episodes" | "timeline" | "youtube-kit";

/** "Quy chuẩn & skill" of a team: markdown its Claude calls follow. */
export interface TeamSkill {
  id: string;
  teamId: string;
  name: string;
  purpose: string;
  appliesTo: TeamSkillStep[];
  content: string;
  enabled: boolean;
  position: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamSkillInput {
  name: string;
  purpose?: string;
  appliesTo?: TeamSkillStep[];
  content: string;
  enabled?: boolean;
  position?: number;
}

export interface Production {
  id: string;
  teamId: string;
  teamName: string;
  title: string;
  description: string;
  goal: string;
  audience: string;
  tone: string;
  notes: string;
  sources: string[];
  youtubeChannels: string[];
  ownChannels: string[];
  hasRnd: boolean;
  hasBranding: boolean;
  waitingGate: "approve-rnd" | "approve-branding" | "approve-plan" | null;
  keywords: string[];
  episodeTargetSeconds: number | null;
  maxEpisodes: number | null;
  aspect: "16:9" | "9:16";
  language: string;
  music: { track: string; gainDb: number; ducking: boolean } | null;
  status: ProductionStatus;
  runId: string | null;
  episodeCounts: { total: number; ready: number; producing: number; waitingApproval: number; failed: number };
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionInput {
  title: string;
  description?: string;
  goal?: string;
  audience?: string;
  tone?: string;
  notes?: string;
  sources: string[];
  youtubeChannels?: string[];
  ownChannels?: string[];
  keywords?: string[];
  episodeTargetSeconds?: number | null;
  maxEpisodes?: number | null;
  aspect?: "16:9" | "9:16";
  language?: string;
  music?: { track: string; gainDb: number; ducking: boolean } | null;
}

export interface ProductionAccess {
  hasAccess: boolean;
}

export interface EpisodeSummary {
  id: string;
  idx: number;
  title: string;
  hook: string;
  status: EpisodeStatus;
  currentStage: string | null;
  progress: number | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  updatedAt: string;
}

export interface EpisodeDetail extends EpisodeSummary {
  plan: unknown; // StudioEpisode
  run: RunView | null;
  youtube: YoutubeKit | null;
  selectedTitle: number;
  /** The picture the episode uses (new thumbnails API — see `listThumbnails`/`selectThumbnail`). */
  selectedThumbnailId: string | null;
  /** @deprecated superseded by `selectedThumbnailId` + the thumbnails routes; kept only for episodes exported
   *  before 1.2.0. Not used by the UI any more. */
  selectedThumbnail: number;
  /** @deprecated see `selectedThumbnail`. */
  thumbnails: { url: string; index: number }[];
  /** `url` shows the file; `downloadUrl` makes the browser save it (Content-Disposition: attachment). */
  exportFiles: { kind: "mp4" | "thumbnail" | "youtube" | "timeline" | "pack"; url: string; downloadUrl: string; sizeBytes: number; name: string }[];
  finalVideoUrl: string | null;
  finalVideoDownloadUrl: string | null;
  latestRevision: number | null;
}

export interface EpisodePatch {
  youtube?: YoutubeKit;
  selectedTitle?: 0 | 1 | 2;
}

/** A non-2xx answer. `body` is normalised as `{ code, message, ...details }` from the envelope error
 *  (flat, so `body.currentRevision`, `body.missing`, `body.failed` etc. work as before), or the raw
 *  JSON body when the server answers without the envelope. */
export class StudioHttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown> | null) {
    super(typeof body?.message === "string" ? body.message : `HTTP ${status}`);
    this.name = "StudioHttpError";
  }
}

/** True when `v` looks like `{ data, success, error, requestId, timestamp }`. */
function isEnvelope(v: unknown): v is { success: boolean; data: unknown; error: unknown; requestId: string; timestamp: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.success === "boolean" && "data" in r && "error" in r && typeof r.requestId === "string";
}

/** Flatten envelope error `{ code, message, details, fieldErrors }` into `{ code, message, ...details, fieldErrors? }`. */
function flattenEnvelopeError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== "object" || Array.isArray(err)) return {};
  const e = err as Record<string, unknown>;
  const { code, message, details, fieldErrors } = e;
  return {
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : details !== undefined
        ? { details }
        : {}),
    ...(fieldErrors !== undefined ? { fieldErrors } : {}),
  };
}

async function request<T>(
  getAccessToken: () => Promise<string>,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = await getAccessToken();
  // FormData (file uploads) must keep the browser's own multipart Content-Type (with its boundary);
  // everything else goes as JSON.
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const res = await fetch(`${STUDIO_API_URL}${path}`, {
    method,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      Authorization: `Bearer ${token}`,
    },
    body: isFormData ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let parsed: Record<string, unknown> | null = null;
    try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
    const normalised = isEnvelope(parsed) && parsed.error
      ? flattenEnvelopeError(parsed.error)
      : parsed;
    throw new StudioHttpError(res.status, normalised);
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json() as unknown;
  return (isEnvelope(json) ? json.data : json) as T;
}

// ---------------------------------------------------------------------------
// Run/Stage views (same shape as GĐ2 for the episode editor)
// ---------------------------------------------------------------------------

export interface StageView {
  key: string;
  executor: string;
  state: string;
  attempts: number;
  is_gate: boolean;
  reused: boolean;
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
  waiting_gate: string | null;
  stages: StageView[];
  latest_revision: number | null;
}

// ---------------------------------------------------------------------------
// Editor (timeline)
// ---------------------------------------------------------------------------

export interface TimelineRevisionView {
  revision: number;
  data: TimelineV3;
  issues: TimelineIssue[];
  savedAt: string;
  authorId: string;
}

export interface RevisionSummary {
  revision: number;
  baseRevision: number;
  authorId: string;
  label: string | null;
  createdAt: string;
}

/** Media a Premiere project is packed with: the 720p analysis proxy, or the originals (download right needed). */
export type PremiereMedia = "proxy" | "original";

export interface EditorJob {
  id: string;
  kind: "render_preview" | "export_premiere";
  status: "queued" | "running" | "completed" | "failed";
  progress: number | null;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  url?: string;
  urlHidden?: "footage_scope";
}

// ---------------------------------------------------------------------------
// Asset media
// ---------------------------------------------------------------------------

export interface AssetMedia {
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

// ---------------------------------------------------------------------------
// Thumbnails (ag-studio-episode@1.2.0): clean frames + words drawn by Studio, plus Canva
// ---------------------------------------------------------------------------

export type ThumbnailKind = "frame" | "suggestion" | "composed" | "upload" | "canva" | "ai";

export interface ThumbnailView {
  id: string;
  kind: ThumbnailKind;
  tS: number | null;
  assetId: string | null;
  parentId: string | null;
  text: string | null;
  style: ThumbnailStyle | null;
  width: number;
  height: number;
  sizeBytes: number;
  /** "system" for a render's own frames/suggestions; a user id otherwise. */
  createdBy: string;
  createdAt: string;
  url: string;
  /** Sets the file to be saved (Content-Disposition: attachment). */
  downloadUrl: string;
  /** A person made it: can be deleted. */
  deletable: boolean;
  /** Words can be drawn on its clean picture. */
  drawable: boolean;
  /** The caller opened a Canva design for this picture. */
  inCanva: boolean;
}

export interface ThumbnailList {
  items: ThumbnailView[];
  selectedId: string | null;
  canDraw: boolean;
  canCutFrames: boolean;
  framesPending: boolean;
  framesError: string | null;
  footageHidden: boolean;
}

/** `GET /api/canva/connection`: enabled=false hides every Canva control in the UI. */
export interface CanvaConnection {
  enabled: boolean;
  connected: boolean;
  displayName: string | null;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function createStudioClient(getAccessToken: () => Promise<string>) {
  return {
    // ---- Me ----
    getMe(): Promise<MeProfile> {
      return request<MeProfile>(getAccessToken, "GET", "/api/me");
    },

    // ---- Teams ----
    listTeams(params?: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: string; q?: string }): Promise<Paged<Team>> {
      return request<Paged<Team>>(getAccessToken, "GET", `/api/teams${buildQuery(params ?? {})}`);
    },
    createTeam(name: string): Promise<Team> {
      return request<Team>(getAccessToken, "POST", "/api/teams", { name });
    },
    updateTeam(teamId: string, name: string): Promise<Team> {
      return request<Team>(getAccessToken, "PATCH", `/api/teams/${teamId}`, { name });
    },
    deleteTeam(teamId: string): Promise<void> {
      return request<void>(getAccessToken, "DELETE", `/api/teams/${teamId}`);
    },

    getTeam(teamId: string): Promise<TeamDetail> {
      return request<TeamDetail>(getAccessToken, "GET", `/api/teams/${teamId}`);
    },

    // ---- Team skills ----
    listTeamSkills(teamId: string): Promise<TeamSkill[]> {
      return request<TeamSkill[]>(getAccessToken, "GET", `/api/teams/${teamId}/skills`);
    },
    createTeamSkill(teamId: string, input: TeamSkillInput): Promise<TeamSkill> {
      return request<TeamSkill>(getAccessToken, "POST", `/api/teams/${teamId}/skills`, input);
    },
    updateTeamSkill(teamId: string, skillId: string, patch: Partial<TeamSkillInput>): Promise<TeamSkill> {
      return request<TeamSkill>(getAccessToken, "PATCH", `/api/teams/${teamId}/skills/${skillId}`, patch);
    },
    deleteTeamSkill(teamId: string, skillId: string): Promise<void> {
      return request<void>(getAccessToken, "DELETE", `/api/teams/${teamId}/skills/${skillId}`);
    },

    // ---- Team members ----
    listMembers(teamId: string, params?: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: string; q?: string }): Promise<Paged<TeamMember>> {
      return request<Paged<TeamMember>>(getAccessToken, "GET", `/api/teams/${teamId}/members${buildQuery(params ?? {})}`);
    },
    searchMemberCandidates(teamId: string, keyword: string): Promise<UserSummary[]> {
      return request<UserSummary[]>(getAccessToken, "GET", `/api/teams/${teamId}/member-candidates?keyword=${encodeURIComponent(keyword)}`);
    },
    addMember(teamId: string, userId: string, role: string): Promise<TeamMember> {
      return request<TeamMember>(getAccessToken, "POST", `/api/teams/${teamId}/members`, { userId, role });
    },
    removeMember(teamId: string, userId: string): Promise<void> {
      return request<void>(getAccessToken, "DELETE", `/api/teams/${teamId}/members/${userId}`);
    },
    updateMemberRole(teamId: string, userId: string, role: string): Promise<TeamMember> {
      return request<TeamMember>(getAccessToken, "PATCH", `/api/teams/${teamId}/members/${userId}`, { role });
    },

    // ---- Productions ----
    listProductions(params?: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: string; q?: string; teamId?: string; status?: string }): Promise<Paged<Production>> {
      return request<Paged<Production>>(getAccessToken, "GET", `/api/productions${buildQuery(params ?? {})}`);
    },
    listTeamProductions(teamId: string, params?: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: string; q?: string; status?: string }): Promise<Paged<Production>> {
      return request<Paged<Production>>(getAccessToken, "GET", `/api/teams/${teamId}/productions${buildQuery(params ?? {})}`);
    },
    createProduction(teamId: string, data: ProductionInput): Promise<Production> {
      return request<Production>(getAccessToken, "POST", `/api/teams/${teamId}/productions`, data);
    },
    getProduction(id: string): Promise<Production> {
      return request<Production>(getAccessToken, "GET", `/api/productions/${id}`);
    },
    updateProduction(id: string, data: Partial<ProductionInput>): Promise<Production> {
      return request<Production>(getAccessToken, "PATCH", `/api/productions/${id}`, data);
    },
    deleteProduction(id: string): Promise<void> {
      return request<void>(getAccessToken, "DELETE", `/api/productions/${id}`);
    },
    checkProductionAccess(id: string): Promise<ProductionAccess> {
      return request<ProductionAccess>(getAccessToken, "GET", `/api/productions/${id}/access`);
    },
    getProductionCatalog(id: string): Promise<StudioCatalog> {
      return request<StudioCatalog>(getAccessToken, "GET", `/api/productions/${id}/catalog`);
    },
    getAssetMedia(productionId: string, assetId: string): Promise<AssetMedia> {
      return request<AssetMedia>(getAccessToken, "GET", `/api/productions/${productionId}/assets/${assetId}/media`);
    },

    // ---- Plan run ----
    startRun(id: string): Promise<{ runId: string }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/run`);
    },
    getRun(id: string): Promise<RunView> {
      return request(getAccessToken, "GET", `/api/productions/${id}/run`);
    },
    getRunDocument<T = unknown>(id: string, stage: string, name: string): Promise<T> {
      return request(getAccessToken, "GET", `/api/productions/${id}/run/documents/${stage}/${name}`);
    },
    getResearch(id: string): Promise<StudioResearch> {
      return this.getRunDocument<StudioResearch>(id, "research", "research.json");
    },
    getTrendReport(id: string): Promise<TrendReport> {
      return this.getRunDocument<TrendReport>(id, "trend-report", "trend-report.json");
    },
    getSeriesPlan(id: string, stage: "plan-episodes" | "approve-plan" = "plan-episodes"): Promise<SeriesPlan> {
      return this.getRunDocument<SeriesPlan>(id, stage, "series-plan.json");
    },
    submitApprovePlan(id: string, document: SeriesPlan): Promise<{ accepted: true }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/run/gates/approve-plan`, { document });
    },
    getRndDraft(id: string): Promise<StudioRnd | null> {
      return this.getRunDocument<StudioRnd>(id, "rnd", "rnd.json").catch((e: unknown) => {
        if (e instanceof StudioHttpError && e.status === 404) return null;
        throw e;
      });
    },
    getBrandingDraft(id: string): Promise<StudioBranding | null> {
      return this.getRunDocument<StudioBranding>(id, "branding", "branding.json").catch((e: unknown) => {
        if (e instanceof StudioHttpError && e.status === 404) return null;
        throw e;
      });
    },
    getBriefDoc(id: string): Promise<StudioBrief | null> {
      return this.getRunDocument<StudioBrief>(id, "brief", "brief.json").catch((e: unknown) => {
        if (e instanceof StudioHttpError && e.status === 404) return null;
        throw e;
      });
    },
    getProductionRnd(id: string): Promise<{ document: StudioRnd | null; updatedAt: string; updatedBy: string }> {
      return request(getAccessToken, "GET", `/api/productions/${id}/rnd`);
    },
    putProductionRnd(id: string, document: StudioRnd): Promise<{ document: StudioRnd; updatedAt: string; updatedBy: string; warnings: { code: string; message: string }[] }> {
      return request(getAccessToken, "PUT", `/api/productions/${id}/rnd`, { document });
    },
    getProductionBranding(id: string): Promise<{ document: StudioBranding | null; updatedAt: string; updatedBy: string }> {
      return request(getAccessToken, "GET", `/api/productions/${id}/branding`);
    },
    putProductionBranding(id: string, document: StudioBranding): Promise<{ document: StudioBranding; updatedAt: string; updatedBy: string; warnings: { code: string; message: string }[] }> {
      return request(getAccessToken, "PUT", `/api/productions/${id}/branding`, { document });
    },
    submitApproveRnd(id: string, document: StudioRnd): Promise<{ accepted: true }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/run/gates/approve-rnd`, { document });
    },
    submitApproveBranding(id: string, document: StudioBranding): Promise<{ accepted: true }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/run/gates/approve-branding`, { document });
    },
    retryStage(id: string, stage: string): Promise<{ ok: true }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/run/stages/${stage}/retry`);
    },
    resumeStage(id: string, stage: string): Promise<{ runId: string; reused: string[] }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/run/stages/${stage}/resume`);
    },
    cancelRun(id: string): Promise<{ ok: true }> {
      return request(getAccessToken, "POST", `/api/productions/${id}/run/cancel`);
    },

    // ---- Episodes ----
    listEpisodes(productionId: string, params?: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: string }): Promise<Paged<EpisodeSummary>> {
      return request<Paged<EpisodeSummary>>(getAccessToken, "GET", `/api/productions/${productionId}/episodes${buildQuery(params ?? {})}`);
    },
    getEpisode(productionId: string, episodeId: string): Promise<EpisodeDetail> {
      return request<EpisodeDetail>(getAccessToken, "GET", `/api/productions/${productionId}/episodes/${episodeId}`);
    },
    patchEpisode(productionId: string, episodeId: string, data: EpisodePatch): Promise<EpisodeDetail> {
      return request<EpisodeDetail>(getAccessToken, "PATCH", `/api/productions/${productionId}/episodes/${episodeId}`, data);
    },
    rerenderEpisode(productionId: string, episodeId: string): Promise<{ runId: string }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/rerender`);
    },
    cancelEpisode(productionId: string, episodeId: string): Promise<void> {
      return request<void>(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/cancel`);
    },
    retryEpisodeStage(productionId: string, episodeId: string, stage: string): Promise<{ ok: true }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/stages/${stage}/retry`);
    },
    getEpisodeDocument<T = unknown>(productionId: string, episodeId: string, stage: string, name: string): Promise<T> {
      return request<T>(getAccessToken, "GET", `/api/productions/${productionId}/episodes/${episodeId}/documents/${stage}/${name}`);
    },
    /** 403 `footage_hidden`, built on demand, stored once per content; the URL saves the zip (no video). */
    youtubePack(productionId: string, episodeId: string): Promise<{ url: string; name: string; sizeBytes: number }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/youtube-pack`);
    },

    // ---- Thumbnails (403 `footage_hidden` outside the caller's footage scope, 503 `thumbnails_unavailable`
    // without ffmpeg on the API box) ----
    listThumbnails(productionId: string, episodeId: string): Promise<ThumbnailList> {
      return request(getAccessToken, "GET", `/api/productions/${productionId}/episodes/${episodeId}/thumbnails`);
    },
    selectThumbnail(productionId: string, episodeId: string, thumbnailId: string): Promise<ThumbnailList> {
      return request(getAccessToken, "PUT", `/api/productions/${productionId}/episodes/${episodeId}/thumbnails/selected`, { thumbnailId });
    },
    /** Half-size JPEG data URL, not kept. */
    previewThumbnail(productionId: string, episodeId: string, baseId: string, text: string, style: ThumbnailStyle): Promise<{ dataUrl: string }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/thumbnails/preview`, { baseId, text, style });
    },
    composeThumbnail(productionId: string, episodeId: string, baseId: string, text: string, style: ThumbnailStyle): Promise<ThumbnailView> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/thumbnails/compose`, { baseId, text, style });
    },
    /** A clean `frame` of the final video at `tS` seconds. */
    captureThumbnail(productionId: string, episodeId: string, tS: number): Promise<ThumbnailView> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/thumbnails/capture`, { tS });
    },
    /** JPEG/PNG/WebP ≤ 10 MB. */
    uploadThumbnail(productionId: string, episodeId: string, file: File): Promise<ThumbnailView> {
      const form = new FormData();
      form.append("file", file);
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/thumbnails/upload`, form);
    },
    /** 202 `{started, pending}`: cuts the clean frames of an episode rendered before 1.2.0 in the background. */
    startCutFrames(productionId: string, episodeId: string): Promise<{ started: boolean; pending: boolean }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/thumbnails/frames`);
    },
    /** Only pictures a person made (422 `not_user_made` otherwise). */
    deleteThumbnail(productionId: string, episodeId: string, thumbnailId: string): Promise<ThumbnailList> {
      return request(getAccessToken, "DELETE", `/api/productions/${productionId}/episodes/${episodeId}/thumbnails/${thumbnailId}`);
    },

    // ---- Canva ----
    getCanvaConnection(): Promise<CanvaConnection> {
      return request(getAccessToken, "GET", "/api/canva/connection");
    },
    /** `returnTo` is a path in the web app; the caller sets `window.location.href = authorizeUrl` next. */
    authorizeCanva(returnTo: string): Promise<{ authorizeUrl: string }> {
      return request(getAccessToken, "POST", "/api/canva/authorize", { returnTo });
    },
    disconnectCanva(): Promise<{ ok: true }> {
      return request(getAccessToken, "DELETE", "/api/canva/connection");
    },
    /** 409 `canva_not_connected`/`canva_reconnect`, 503 `canva_disabled`, 502 `canva_failed`, 429 `canva_busy`. */
    openThumbnailInCanva(productionId: string, episodeId: string, thumbnailId: string): Promise<{ designId: string; editUrl: string }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/thumbnails/${thumbnailId}/canva`);
    },
    /** A new `canva` picture, `parentId` = `thumbnailId`. 404 `no_canva_design` if it was never opened. */
    pullCanvaThumbnail(productionId: string, episodeId: string, thumbnailId: string): Promise<ThumbnailView> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/thumbnails/${thumbnailId}/canva/pull`);
    },

    // ---- Editor (timeline revisions, preview) ----
    getTimeline(productionId: string, episodeId: string): Promise<TimelineRevisionView> {
      return request(getAccessToken, "GET", `/api/productions/${productionId}/episodes/${episodeId}/timeline`);
    },
    listRevisions(productionId: string, episodeId: string): Promise<RevisionSummary[]> {
      return request(getAccessToken, "GET", `/api/productions/${productionId}/episodes/${episodeId}/timeline/revisions`);
    },
    /** 409 (`StudioHttpError`, body `{ code: "revision_conflict", currentRevision }`) when `baseRevision` is stale. */
    saveRevision(productionId: string, episodeId: string, baseRevision: number, data: TimelineV3, label?: string): Promise<{ revision: number; issues: TimelineIssue[]; approved?: boolean }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/timeline/revisions`, { baseRevision, data, ...(label ? { label } : {}) });
    },
    renderPreview(productionId: string, episodeId: string, revision: number): Promise<EditorJob> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/editor/previews`, { revision });
    },
    getEditorJob(productionId: string, episodeId: string, jobId: string): Promise<EditorJob> {
      return request(getAccessToken, "GET", `/api/productions/${productionId}/episodes/${episodeId}/editor/jobs/${jobId}`);
    },
    /** Latest first. */
    listEditorJobs(productionId: string, episodeId: string, kind: EditorJob["kind"]): Promise<EditorJob[]> {
      return request(getAccessToken, "GET", `/api/productions/${productionId}/episodes/${episodeId}/editor/jobs?kind=${kind}`);
    },
    /** 403 when `original` is asked for by someone who may not download originals. */
    exportPremiere(productionId: string, episodeId: string, media: PremiereMedia): Promise<EditorJob> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/episodes/${episodeId}/exports/premiere`, { media });
    },

    // ---- Call log (403 `footage_scope` outside the caller's ag-go scope) ----
    listLlmCalls(productionId: string, params?: { episodeId?: string; page?: number; pageSize?: number }): Promise<Paged<LlmCallSummary>> {
      return request(getAccessToken, "GET", `/api/productions/${productionId}/llm-calls${buildQuery(params ?? {})}`);
    },
    getLlmCall(productionId: string, callId: string): Promise<LlmCallDetail> {
      return request(getAccessToken, "GET", `/api/productions/${productionId}/llm-calls/${callId}`);
    },
    listHumanEdits(productionId: string, params?: { page?: number; pageSize?: number }): Promise<Paged<HumanEditView>> {
      return request(getAccessToken, "GET", `/api/productions/${productionId}/human-edits${buildQuery(params ?? {})}`);
    },

    // ---- Chat (spec local-chat §3.1) ----
    createDraft(teamId: string, text: string): Promise<{ productionId: string; user: ChatTurn; assistant: ChatTurn | null }> {
      return request(getAccessToken, "POST", `/api/teams/${teamId}/drafts`, { text });
    },
    getChatThread(productionId: string, episodeId?: string | null): Promise<ChatThreadView> {
      return request(getAccessToken, "GET", `/api/productions/${productionId}/chat${buildQuery({ episodeId: episodeId ?? undefined })}`);
    },
    sendChat(productionId: string, text: string, episodeId?: string | null): Promise<{ user: ChatTurn; assistant: ChatTurn | null }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/chat`, { text, ...(episodeId ? { episodeId } : {}) });
    },
    applyChatProposal(productionId: string, turnId: string): Promise<{ revision?: number }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/chat/${turnId}/apply`);
    },
    startProduction(productionId: string): Promise<{ runId: string }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/start`);
    },
    approveChat(productionId: string, input: { stageKey: string; episodeId?: string | null; turnId?: string | null }): Promise<{ stageState: string; runState: string; revision?: number }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/chat/approve`, {
        stageKey: input.stageKey, ...(input.episodeId ? { episodeId: input.episodeId } : {}), ...(input.turnId ? { turnId: input.turnId } : {}),
      });
    },
    retryChatStep(productionId: string, stageKey: string, episodeId?: string | null): Promise<{ ok: true }> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/chat/retry`, { stageKey, ...(episodeId ? { episodeId } : {}) });
    },
    saveManualEdit(productionId: string, input: { stageKey: string; episodeId?: string | null; document: unknown }): Promise<ChatTurn> {
      return request(getAccessToken, "POST", `/api/productions/${productionId}/chat/manual`, {
        stageKey: input.stageKey, document: input.document, ...(input.episodeId ? { episodeId: input.episodeId } : {}),
      });
    },
    getOverview(): Promise<{ items: OverviewItem[] }> {
      return request(getAccessToken, "GET", "/api/studio/overview");
    },
    getClaudeUsage(): Promise<ClaudeUsage> {
      return request(getAccessToken, "GET", "/api/studio/claude");
    },
    setClaudeMaxConcurrent(claudeMaxConcurrent: number): Promise<ClaudeUsage> {
      return request(getAccessToken, "PUT", "/api/studio/settings", { claudeMaxConcurrent });
    },
  };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatScopeName = "intake" | "gate" | "failed" | "timeline";
export type ChatAction = "answer" | "revise" | "suggest_approve" | "render" | "export" | "retry";

export interface ChatTurn {
  id: string; production_id: string; episode_id: string | null; run_id: string | null;
  scope: ChatScopeName; stage_key: string; turn: number; role: "user" | "assistant" | "system";
  text: string; mentions: { kind: "folder"; id: string; name: string }[]; context: unknown;
  proposal: unknown; action: ChatAction | null;
  status: "pending" | "running" | "done" | "failed" | "rate_limited"; not_before: string | null;
  problems: { code: string; message: string }[];
  llm_call_id: string | null; created_by: string | null; applied_at: string | null; created_at: string; updated_at: string;
}

export interface ChatScopeKey { productionId: string; episodeId: string | null; runId: string | null; stageKey: string; scope: ChatScopeName }

export interface ChatThreadView {
  turns: ChatTurn[];
  scope: ChatScopeKey | null;
  blocked: { code: "busy" | "nothing_to_chat" | string; stage: string | null } | null;
  current: { turnId: string | null; document: unknown; draft: unknown; pendingApply: boolean } | null;
  queueAhead: number;
}

export type OverviewGroup = "waiting_you" | "needs_attention" | "running" | "done";
export interface OverviewEpisode { id: string; idx: number; title: string; status: EpisodeStatus; step: string | null; group: OverviewGroup }
export interface OverviewItem { id: string; teamId: string; title: string; updatedAt: string; step: string | null; group: OverviewGroup; episodes: OverviewEpisode[] }

export interface ClaudeUsage { running: number; waiting: number; max: number; source: "settings" | "env" }

// ---------------------------------------------------------------------------
// Call log
// ---------------------------------------------------------------------------

export type LlmCallOutcome = "accepted" | "rejected" | "failed" | "rate_limited";

export interface LlmCallSummary {
  id: string;
  createdAt: string;
  episodeId: string | null;
  episodeIdx: number | null;
  stageKey: string;
  skill: string;
  model: string;
  round: number;
  outcome: LlmCallOutcome;
  problems: { code: string; message: string }[];
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  wallSeconds: number;
  hasPayload: boolean;
}

export interface LlmCallDetail extends LlmCallSummary {
  prompt: string | null;
  response: string | null;
  structuredOutput: unknown;
  warnings: { code: string; message: string }[];
}

export type HumanEditKind = "trend_report" | "series_plan" | "youtube_kit" | "episode_rerender" | "episode_cancel" | "rnd" | "branding" | "rnd_edit" | "branding_edit" | "thumbnail";

export interface HumanEditView {
  id: string;
  createdAt: string;
  userId: string;
  episodeId: string | null;
  episodeIdx: number | null;
  kind: HumanEditKind;
  llmCallId: string | null;
  changed: boolean;
  before: unknown;
  after: unknown;
}

export type StudioClient = ReturnType<typeof createStudioClient>;

export function useStudioClient(): StudioClient {
  const { getAccessToken } = useAuthToken();
  return createStudioClient(getAccessToken);
}
