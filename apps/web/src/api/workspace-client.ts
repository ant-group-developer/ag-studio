/**
 * The Studio API of the agent workspace (spec 2026-10-10 agent-workspace): a team's projects (one YouTube channel
 * each), their videos, and the project's files.
 */
import { useMemo } from "react";
import { useAuthToken } from "../auth/use-auth-token";
import { buildQuery, request, requestBlob, STUDIO_API_URL } from "./http";

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

/** What Studio's checks say of a file: errors it cannot use as is, warnings. */
export interface FileIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  sha256: string;
  mtime: string;
  mime: string;
  binary: boolean;
  text: string | null;
  issues: FileIssue[];
}

export interface SavedFile {
  path: string;
  sha256: string;
  size: number;
  versionId: string;
  issues?: FileIssue[];
}

// ---------------------------------------------------------------------------
// Playbook (suggested steps) and lessons
// ---------------------------------------------------------------------------

export type StepStatus = "missing" | "draft" | "invalid" | "done" | "skipped" | "stale" | "running";

export interface StepState {
  key: string;
  scope: "project" | "video";
  title: string;
  description: string;
  skill: string | null;
  optional: boolean;
  requires: string[];
  status: StepStatus;
  outputs: { path: string; role: "doc" | "data" | "studio"; exists: boolean; issues: FileIssue[] }[];
  issues: FileIssue[];
  primary: string;
  prompts: { do: string; redo: string | null; revise: string | null };
  staleBecause: string[];
  /** Steps of the other scope this one builds on that are not done yet (a note; absent from an older API). */
  outsideRequires?: string[];
  detail: string | null;
}

export interface PlaybookStatus {
  custom: boolean;
  issues: FileIssue[];
  /** Whose steps `next` suggests: the video's (a video's chat) or the channel's. */
  scope?: "project" | "video";
  project: StepState[];
  video: StepState[] | null;
  next: { scope: "project" | "video"; key: string }[];
  /** The channel's steps still open. */
  projectOpen?: number;
}

export interface LessonProposal {
  id: string;
  project_id: string;
  thread_id: string | null;
  text: string;
  status: "proposed" | "accepted" | "dismissed";
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
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

export interface DiffLine { kind: "context" | "add" | "del"; text: string }
export interface DiffHunk { old_start: number; old_lines: number; new_start: number; new_lines: number; lines: DiffLine[] }
/** What a version changed (`GET files/versions/:id/diff`): hunks with 3 lines of context, or why it cannot be shown. */
export type VersionDiff = { path: string; version_id: string; before_version_id: string | null } & (
  | { hunks: DiffHunk[]; added: number; removed: number; unavailable?: undefined }
  | { unavailable: "binary" | "too_large" }
);

// ---------------------------------------------------------------------------
// Chat with the agent
// ---------------------------------------------------------------------------

export type AgentPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; started_at: string; ended_at?: string; is_error?: boolean; result?: string };

export type AgentPhase =
  | { kind: "starting" }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "tool"; tool: string; detail: string | null }
  | { kind: "done" };

export type MessageStatus = "pending" | "running" | "done" | "failed" | "rate_limited" | "cancelled";

/** A file a turn changed: its last version against the one before the turn; line counts when both are text ≤ 1 MB. */
export interface ChangedFile {
  path: string;
  change: "added" | "modified" | "deleted";
  version_id: string;
  before_version_id: string | null;
  added?: number;
  removed?: number;
}
export type TeamRoleName = "viewer" | "editor" | "producer" | "owner";

export interface ChatMessage {
  id: string;
  threadId: string;
  seq: number;
  role: "user" | "assistant" | "system";
  status: MessageStatus;
  text: string;
  parts: AgentPart[];
  phase: AgentPhase | null;
  attachments: string[];
  trigger: "user" | "job" | "action" | "autofix" | "system";
  notBefore: string | null;
  error: string | null;
  cancelRequested: boolean;
  costUsd: number | null;
  createdBy: string | null;
  actorRole: TeamRoleName | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** What the turn changed; null for older turns or while it runs (older APIs leave it out). */
  changedFiles?: ChangedFile[] | null;
}

export interface Thread {
  id: string;
  projectId: string;
  videoId: string | null;
  kind: "project" | "video";
  title: string;
  useLessons: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  messageCount?: number;
  lastMessageAt?: string | null;
  busy?: boolean;
}

export interface ThreadRefView { threadId: string; mode: "summary" | "full"; title: string }

export interface ThreadDetail extends Thread {
  refs: ThreadRefView[];
  messages: ChatMessage[];
}

/** What a new thread (or video) learns from earlier chats of the project. */
export interface Learning {
  useLessons: boolean;
  threads: { threadId: string; mode: "summary" | "full" }[];
}

export interface Activity {
  id: string;
  kind: "agent_turn" | "tool_call" | "job";
  status: "waiting" | "running" | "rate_limited";
  title: string;
  phase: AgentPhase | null;
  detail: string | null;
  startedAt: string | null;
  notBefore: string | null;
  progress: number | null;
  etaSeconds: number | null;
  node: string | null;
  cancellable: boolean;
  parentId: string | null;
  threadId: string | null;
  threadTitle: string | null;
  videoId: string | null;
  /** Jobs: their kind; otherwise null. */
  jobKind: JobKind | null;
}

// ---- Inputs and jobs ----
export type JobKind = "prepare_asset" | "transcribe_upload" | "tts" | "fit" | "render_preview" | "render_final" | "export_premiere" | "research" | "style_watch" | "thumbnail";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobView {
  id: string;
  projectId: string;
  videoId: string | null;
  threadId: string | null;
  kind: JobKind;
  status: JobStatus;
  title: string;
  request: unknown;
  result: unknown;
  error: string | null;
  /** What it does now, e.g. "Farm · GPU-02 · đọc lời thoại". */
  phase: string | null;
  progress: number | null;
  etaSeconds: number | null;
  /** The farm machine (its name when known). */
  nodeId: string | null;
  cancelRequested: boolean;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type AssetState =
  | { state: "queued" | "preparing"; job_id: string; phase: string | null; progress: number | null }
  | { state: "ready"; folder: string; readme: string; shots: number | null; duration_s: number | null; transcript: boolean }
  | { state: "failed"; error: string | null }
  | { state: "not_prepared" }
  | { state: "not_an_input" };

export type SourceKind = "ag_go_project" | "ag_go_asset" | "upload";
export interface SourceItem {
  id: string;
  projectId: string;
  videoId: string | null;
  kind: SourceKind;
  ref: string;
  mediaType: "video" | "image" | "audio" | "document" | "mixed";
  label: string;
  meta: Record<string, unknown>;
  addedBy: string;
  addedAt: string;
  asset: AssetState | null;
}

export interface FootageItem {
  assetId: string;
  name: string;
  durationMs: number;
  width?: number | null;
  height?: number | null;
  hasAudio?: boolean | null;
  hasSpeech?: boolean | null;
  projectNames?: string[] | null;
  summaryVi?: string | null;
  thumbnailUrl?: string | null;
  titleVi?: string | null;
  orientation?: string | null;
  projectIds?: string[];
  analyzedAt?: string | null;
  quality?: number | null;
  genre?: string | null;
  timeOfDay?: string | null;
  tags?: string[];
  usable?: boolean | null;
  prepared: AssetState;
}

export const FOOTAGE_SORTS = ["relevance", "analyzedAt", "quality", "duration", "resolution", "name", "project"] as const;
export type FootageSort = (typeof FOOTAGE_SORTS)[number];
export const FOOTAGE_RESOLUTIONS = ["4k", "2k", "1080p", "720p", "sd"] as const;
export const FOOTAGE_ORIENTATIONS = ["landscape", "portrait", "square"] as const;
export const FOOTAGE_TIMES_OF_DAY = ["day", "night", "golden_hour", "indoor", "mixed", "unknown"] as const;
export type FootageUsability = "usable" | "unusable" | "all";

/** The video picker's filters (ag-go's footage filters, within the ag-go projects picked for the project). */
export interface FootageFilters {
  agGoProjectIds?: string[];
  q?: string;
  categoryIds?: string[];
  ownerUserIds?: string[];
  provinceIds?: string[];
  resolutions?: string[];
  tags?: string[];
  genres?: string[];
  timesOfDay?: string[];
  orientations?: string[];
  minDurationMs?: number;
  maxDurationMs?: number;
  usability?: FootageUsability;
}

export interface FootageQuery extends FootageFilters {
  page?: number;
  cursor?: string;
  limit?: number;
  sortBy?: FootageSort;
  sortOrder?: "asc" | "desc";
}

/** How many videos have a value under the other filters (`null`: ag-go did not count it). */
export interface FacetValue { value: string; label?: string; count: number | null }
export interface FootageFacets {
  projects: FacetValue[];
  categories: FacetValue[];
  provinces: FacetValue[];
  authors: FacetValue[];
  resolutions: FacetValue[];
  orientations: FacetValue[];
  timesOfDay: FacetValue[];
  genres: FacetValue[];
  tags: FacetValue[];
}

/** A footage query as the API reads it: lists comma-joined, empty ones left out. */
export function footageQueryString(q: FootageQuery): string {
  const flat: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) { if (v.length) flat[k] = v.join(","); } else flat[k] = v as string | number;
  }
  return buildQuery(flat);
}

export type AddSourceInput =
  | { kind: "ag_go_project"; ref: string; label: string }
  | { kind: "ag_go_asset"; ref: string; label: string; videoId?: string; meta?: { durationMs?: number; thumbnailUrl?: string; agGoProjectId?: string }; prepare?: boolean };

// ---- A video's media and the project's audio ----
export type RenderKind = "render_preview" | "render_final" | "export_premiere";
export interface RenderView {
  jobId: string;
  kind: RenderKind;
  revision: number;
  durationS: number | null;
  width: number | null;
  height: number | null;
  watermarked: boolean | null;
  sizeBytes: number | null;
  note: string;
  finishedAt: string | null;
}
/** A render's link, asked for one render at a time. */
export interface RenderLink {
  jobId: string;
  /** null when the person's own ag-go rights do not cover the footage in it, or ag-go could not say (`footage_check_failed`). */
  url: string | null;
  urlHidden?: "footage_scope" | "footage_check_failed";
}

export interface TimelineClipRow {
  clip_id: string; at: number; length: number; asset: string; asset_id: string; in: number; out: number | null; shot_id: string | null;
  line_id: string | null; section_title: string | null; transition: "cut" | "dissolve"; muted?: boolean;
}
export interface TimelineSummary {
  revision: number;
  label: string | null;
  approx_seconds: number;
  clips: TimelineClipRow[];
  texts: { text_id: string; kind: string; text: string; start: number; duration: number; position: string }[];
  narration: { voice: string; lines: { line_id: string; text: string }[] };
  music: { track: string; gain_db: number; ducking: boolean } | null;
  issues: string[];
}

export interface ProjectAudioView {
  voice: Record<string, unknown> | null;
  music: Record<string, unknown> | null;
  summary: { voice: string; music: string };
}
export type VoiceOrigin = "synthetic" | "own" | "licensed";

// ---- Confirmation cards ----
/** YouTube refusing to let the Studio server download (ISO times); Studio forgets it at `until` or after a download. */
export interface YoutubeBlock { blockedAt: string; until: string; where: "studio" }
export type ActionKind = "render_final" | "export_premiere" | "delete_video" | "crawl_large" | "reference_download";
export interface ActionView {
  id: string;
  projectId: string;
  videoId: string | null;
  threadId: string;
  messageId: string | null;
  kind: ActionKind;
  title: string;
  summary: string;
  params: Record<string, unknown>;
  revision: number | null;
  status: "proposed" | "confirmed" | "rejected" | "expired" | "failed";
  /** The team role confirming it needs. */
  needs: TeamRoleName;
  decidedBy: string | null;
  decidedAt: string | null;
  jobId: string | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
}

// ---- Research ----
export type CrawlInput =
  | { kind: "trending"; region?: string; category?: string; max?: number }
  | { kind: "topic"; q: string; region?: string; days?: number; order?: "viewCount" | "relevance" | "date"; max?: number }
  | { kind: "top_channels"; q: string; region?: string; max?: number }
  | { kind: "channel_top"; channel: string; max?: number };

export interface CrawlEstimate {
  request: CrawlInput;
  title: string;
  /** YouTube Data API units at most (0 with yt-dlp). */
  units: number;
  large: boolean;
  source: "youtube_api" | "yt-dlp";
}

export interface ResearchFile {
  path: string;
  title: string;
  modifiedAt: string;
  size: number;
  crawl: { kind: CrawlInput["kind"]; fetchedAt: string; source: string; videos: number; channels: number; quotaUnits: number } | null;
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
    createVideo(projectId: string, input: { title?: string; prompt?: string; learning?: Learning } = {}): Promise<Video & { threadId: string }> {
      return call("POST", `/api/projects/${enc(projectId)}/videos`, input);
    },
    getVideo(videoId: string): Promise<Video & { threadId: string }> {
      return call("GET", `/api/videos/${enc(videoId)}`);
    },
    updateVideo(videoId: string, patch: { title?: string; status?: VideoStatus }): Promise<Video> {
      return call("PATCH", `/api/videos/${enc(videoId)}`, patch);
    },
    archiveVideo(videoId: string): Promise<void> {
      return call("DELETE", `/api/videos/${enc(videoId)}`);
    },

    // ---- Threads ----
    listThreads(projectId: string, videoId?: string): Promise<{ threads: Thread[] }> {
      return call("GET", `/api/projects/${enc(projectId)}/threads${buildQuery({ videoId })}`);
    },
    createThread(projectId: string, input: { title?: string; learning?: Learning } = {}): Promise<Thread> {
      return call("POST", `/api/projects/${enc(projectId)}/threads`, input);
    },
    getThread(threadId: string): Promise<ThreadDetail> {
      return call("GET", `/api/threads/${enc(threadId)}`);
    },
    sendMessage(threadId: string, input: { text: string; attachments?: string[] }): Promise<{ message: ChatMessage; turn: ChatMessage | null }> {
      return call("POST", `/api/threads/${enc(threadId)}/messages`, input);
    },
    cancelTurn(threadId: string, messageId: string): Promise<ChatMessage> {
      return call("POST", `/api/threads/${enc(threadId)}/messages/${enc(messageId)}/cancel`, {});
    },
    renameThread(threadId: string, title: string): Promise<Thread> {
      return call("PATCH", `/api/threads/${enc(threadId)}`, { title });
    },
    setLearning(threadId: string, learning: Learning): Promise<Thread> {
      return call("PUT", `/api/threads/${enc(threadId)}/learning`, learning);
    },
    archiveThread(threadId: string): Promise<void> {
      return call("DELETE", `/api/threads/${enc(threadId)}`);
    },
    getActivity(projectId: string): Promise<{ activity: Activity[] }> {
      return call("GET", `/api/projects/${enc(projectId)}/activity`);
    },
    /** Server-sent events of a thread (`messages`), read with fetch so the bearer token goes along. */
    async openThreadEvents(threadId: string, signal: AbortSignal): Promise<Response> {
      return fetch(`${STUDIO_API_URL}/api/threads/${enc(threadId)}/events`, { headers: { Authorization: `Bearer ${await getAccessToken()}` }, signal });
    },
    /** Server-sent events of a project (`changed`). */
    async openProjectEvents(projectId: string, signal: AbortSignal): Promise<Response> {
      return fetch(`${STUDIO_API_URL}/api/projects/${enc(projectId)}/events`, { headers: { Authorization: `Bearer ${await getAccessToken()}` }, signal });
    },

    // ---- Playbook and lessons ----
    getPlaybook(projectId: string, videoId?: string | null): Promise<PlaybookStatus> {
      return call("GET", `/api/projects/${enc(projectId)}/playbook${buildQuery({ videoId: videoId ?? undefined })}`);
    },
    markStep(projectId: string, stepKey: string, input: { status: "done" | "skipped" | "draft"; videoId?: string }): Promise<SavedFile> {
      return call("POST", `/api/projects/${enc(projectId)}/playbook/steps/${enc(stepKey)}/mark`, input);
    },
    customizePlaybook(projectId: string): Promise<{ path: string; created: boolean }> {
      return call("POST", `/api/projects/${enc(projectId)}/playbook/customize`, {});
    },
    listLessons(projectId: string, opts: { status?: LessonProposal["status"]; threadId?: string } = {}): Promise<{ lessons: LessonProposal[] }> {
      return call("GET", `/api/projects/${enc(projectId)}/lessons${buildQuery({ status: opts.status, threadId: opts.threadId })}`);
    },
    acceptLesson(projectId: string, lessonId: string, text?: string): Promise<LessonProposal> {
      return call("POST", `/api/projects/${enc(projectId)}/lessons/${enc(lessonId)}/accept`, text ? { text } : {});
    },
    dismissLesson(projectId: string, lessonId: string): Promise<void> {
      return call("POST", `/api/projects/${enc(projectId)}/lessons/${enc(lessonId)}/dismiss`, {});
    },

    // ---- Inputs and jobs ----
    listSources(projectId: string, videoId?: string): Promise<{ sources: SourceItem[] }> {
      return call("GET", `/api/projects/${enc(projectId)}/sources${buildQuery({ videoId })}`);
    },
    /** 422 `owner_cannot_access` when the project's owner cannot use it on ag-go. */
    addSource(projectId: string, input: AddSourceInput): Promise<{ source: SourceItem; prepare?: AssetState }> {
      return call("POST", `/api/projects/${enc(projectId)}/sources`, input);
    },
    removeSource(projectId: string, sourceId: string): Promise<void> {
      return call("DELETE", `/api/projects/${enc(projectId)}/sources/${enc(sourceId)}`);
    },
    /** A document, image or audio file into context/ (415 `docx_not_supported`, `video_from_ag_go`, `file_type`). */
    /** `reference`: a video to learn an edit style from (not footage), into context/references/, up to 300 MB. */
    uploadSource(projectId: string, file: File, videoId?: string, opts: { reference?: boolean } = {}): Promise<{ source: SourceItem; file: SavedFile }> {
      const form = new FormData();
      form.append("file", file);
      if (videoId) form.append("videoId", videoId);
      if (opts.reference) form.append("reference", "1");
      return call("POST", `/api/projects/${enc(projectId)}/sources/upload`, form);
    },
    /** Videos of the project's ag-go projects the person can see, with where each stands here. */
    searchFootage(projectId: string, q: FootageQuery = {}): Promise<{ items: FootageItem[]; nextCursor: string | null; total: number }> {
      return call("GET", `/api/projects/${enc(projectId)}/footage${footageQueryString(q)}`);
    },
    getFootageFacets(projectId: string, f: FootageFilters = {}): Promise<FootageFacets> {
      return call("GET", `/api/projects/${enc(projectId)}/footage/facets${footageQueryString(f)}`);
    },
    prepareInputs(projectId: string, assetIds: string[], again?: boolean): Promise<{ assets: Record<string, AssetState> }> {
      return call("POST", `/api/projects/${enc(projectId)}/prepare`, { assetIds, ...(again ? { again } : {}) });
    },
    listJobs(projectId: string, opts: { active?: boolean; videoId?: string } = {}): Promise<{ jobs: JobView[] }> {
      return call("GET", `/api/projects/${enc(projectId)}/jobs${buildQuery({ active: opts.active ? "1" : undefined, videoId: opts.videoId })}`);
    },
    cancelJob(projectId: string, jobId: string): Promise<JobView> {
      return call("POST", `/api/projects/${enc(projectId)}/jobs/${enc(jobId)}/cancel`, {});
    },

    // ---- A video's media and the project's audio ----
    listRenders(videoId: string): Promise<{ renders: RenderView[]; jobs: JobView[]; thumbnails: string[] }> {
      return call("GET", `/api/videos/${enc(videoId)}/renders`);
    },
    /** One render's link (asks ag-go about its footage the first time); 404 when the job is not a finished render of the video. */
    renderLink(videoId: string, jobId: string): Promise<RenderLink> {
      return call("GET", `/api/videos/${enc(videoId)}/renders/${enc(jobId)}/link`);
    },
    /** 403 `role`: the final render and the Premiere export need a producer. */
    startRender(videoId: string, input: { kind: RenderKind; nodeId?: string; media?: "proxy" | "original" }): Promise<JobView> {
      return call("POST", `/api/videos/${enc(videoId)}/renders`, input);
    },
    getTimeline(videoId: string): Promise<{ latest: TimelineSummary | null; revisions: { revision: number; label: string | null; authorId: string; createdAt: string }[] }> {
      return call("GET", `/api/videos/${enc(videoId)}/timeline`);
    },
    fitTimeline(videoId: string): Promise<JobView> {
      return call("POST", `/api/videos/${enc(videoId)}/timeline/fit`, {});
    },
    getAudio(projectId: string): Promise<ProjectAudioView> {
      return call("GET", `/api/projects/${enc(projectId)}/audio`);
    },
    /** A workspace audio file as the project's voice sample (producer, with its origin) or music. */
    audioFromFile(projectId: string, kind: "voice" | "music", input: { path: string; origin?: VoiceOrigin; referenceText?: string | null }): Promise<ProjectAudioView> {
      return call("POST", `/api/projects/${enc(projectId)}/audio/${kind}/from-file`, input);
    },
    declineVoice(projectId: string): Promise<ProjectAudioView> {
      return call("POST", `/api/projects/${enc(projectId)}/audio/voice/decline`, {});
    },
    clearAudio(projectId: string, kind: "voice" | "music"): Promise<ProjectAudioView> {
      return call("DELETE", `/api/projects/${enc(projectId)}/audio/${kind}`);
    },

    // ---- Confirmation cards ----
    /** `youtubeBlocked`: YouTube blocks the Studio server now (a pending reference download would fail). */
    listActions(threadId: string): Promise<{ actions: ActionView[]; youtubeBlocked?: YoutubeBlock | null }> {
      return call("GET", `/api/threads/${enc(threadId)}/actions`);
    },
    /** 422 `role` (needs another role), `expired` (the timeline changed or a day passed); 409 `decided`. */
    confirmAction(projectId: string, actionId: string): Promise<ActionView> {
      return call("POST", `/api/projects/${enc(projectId)}/actions/${enc(actionId)}/confirm`, {});
    },
    rejectAction(projectId: string, actionId: string): Promise<ActionView> {
      return call("POST", `/api/projects/${enc(projectId)}/actions/${enc(actionId)}/reject`, {});
    },

    // ---- Research ----
    estimateResearch(projectId: string, crawl: CrawlInput): Promise<CrawlEstimate> {
      return call("POST", `/api/projects/${enc(projectId)}/research/estimate`, crawl);
    },
    runResearch(projectId: string, crawl: CrawlInput, threadId?: string): Promise<JobView> {
      return call("POST", `/api/projects/${enc(projectId)}/research`, { crawl, ...(threadId ? { threadId } : {}) });
    },
    listResearch(projectId: string): Promise<{ files: ResearchFile[] }> {
      return call("GET", `/api/projects/${enc(projectId)}/research`);
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
    /** What `versionId` changed against `base` (another version of the file; "none" = an empty file) or the version before it. */
    fileVersionDiff(projectId: string, versionId: string, base?: string | null): Promise<VersionDiff> {
      return call("GET", `/api/projects/${enc(projectId)}/files/versions/${enc(versionId)}/diff${buildQuery({ base: base ?? undefined })}`);
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
