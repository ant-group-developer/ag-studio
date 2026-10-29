import { useAuthToken } from "../auth/use-auth-token";
import type { Activity, YoutubeBlock } from "./workspace-client";

import { buildQuery, putToBucket, request, StudioHttpError, uploadType, type OnProgress, type UploadLink } from "./http";

export { StudioHttpError };

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

export type TeamRole = "owner" | "producer" | "editor" | "viewer";

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

/** A step of the getting started checklist, in the order the API gives them. */
export type OnboardingStepKey = "team" | "project" | "footage" | "video" | "chat" | "preview" | "final";

/** `GET /me/onboarding`: what the person has done in their teams, and where each step leads. */
export interface OnboardingProgress {
  steps: { key: OnboardingStepKey; done: boolean; count: number }[];
  done: number;
  total: number;
  links: { teamId: string | null; projectId: string | null; video: { projectId: string; videoId: string } | null };
}

/** The person's own UI prefs (`GET/PUT /me/prefs`). */
export interface UserPrefs {
  tourSeen: { projects: boolean; project: boolean };
  checklistHidden: boolean;
}

export interface UserPrefsPatch {
  tourSeen?: Partial<UserPrefs["tourSeen"]>;
  checklistHidden?: boolean;
}

export interface Team {
  id: string;
  name: string;
  role: TeamRole | null;
  /** Whether the caller is in the team (false only for a Studio admin, who sees every team). */
  isMember: boolean;
  memberCount: number;
  projectCount: number;
  createdAt: string;
}

/** A person as Account API knows them; fields are null when Account API has no match. */
export interface UserSummary {
  userId: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
}

export type AuditKind = "http" | "tool" | "turn" | "job";
export type AuditActorKind = "user" | "agent" | "studio";

/** One row of the activity log. */
export interface AuditItem {
  id: string;
  at: string;
  actorKind: AuditActorKind;
  actorId: string | null;
  actor: UserSummary | null;
  kind: AuditKind;
  action: string;
  outcome: "ok" | "error";
  method: string | null;
  route: string | null;
  statusCode: number | null;
  durationMs: number | null;
  team: { id: string; name: string | null } | null;
  project: { id: string; name: string | null } | null;
  video: { id: string; title: string | null } | null;
  threadId: string | null;
  messageId: string | null;
  jobId: string | null;
  target: string | null;
  summary: string | null;
  details: unknown;
  costUsd: number | null;
}

export interface AuditQuery {
  teamId?: string;
  projectId?: string;
  videoId?: string;
  threadId?: string;
  actorId?: string;
  actorKind?: AuditActorKind;
  kind?: AuditKind;
  outcome?: "ok" | "error";
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditPage { items: AuditItem[]; total: number; page: number; pageSize: number }

export type ClaudeStatsGroup = "team" | "project" | "video" | "user";
export interface ClaudeStatsQuery { from?: string; to?: string; groupBy?: ClaudeStatsGroup; teamId?: string; projectId?: string; tz?: number }
export interface ClaudeStatsMetrics {
  turns: number;
  threads: number;
  userMessages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  wallSeconds: number;
  failed: number;
  rateLimited: number;
}
export interface ClaudeStatsRow extends ClaudeStatsMetrics {
  /** `null` in a by-video view: the project's own chats. */
  key: string | null;
  label: string | null;
  teamId: string | null;
  projectId: string | null;
  user?: UserSummary | null;
}
export interface ClaudeStats {
  from: string;
  to: string;
  groupBy: ClaudeStatsGroup;
  totals: ClaudeStatsMetrics;
  rows: ClaudeStatsRow[];
  daily: { day: string; turns: number; costUsd: number; inputTokens: number; outputTokens: number }[];
}
export type ClaudeTurnOutcome = "accepted" | "failed" | "rate_limited";
export type ClaudeTurnSort = "at" | "cost" | "wall" | "tokens";
export interface ClaudeTurnsQuery {
  from?: string; to?: string; teamId?: string; projectId?: string;
  /** A video's turns; "": the project's own chats. */
  videoId?: string;
  userId?: string; threadId?: string; outcome?: ClaudeTurnOutcome; sortBy?: ClaudeTurnSort; sortOrder?: "asc" | "desc"; page?: number; pageSize?: number;
}
/** One agent turn behind the Claude stats (`GET /api/studio/stats/claude/turns`). */
export interface ClaudeTurn {
  id: string; at: string; teamId: string | null; projectId: string | null; projectName: string | null; videoId: string | null; videoTitle: string | null;
  threadId: string; threadTitle: string | null; messageId: string; userId: string | null; user: UserSummary | null; model: string; outcome: string;
  status: string | null; trigger: string | null; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
  costUsd: number; wallSeconds: number; numTurns: number | null; toolCount: number; prompt: string | null;
}
export interface ClaudeTurnPage { from: string; to: string; total: number; page: number; pageSize: number; items: ClaudeTurn[] }
/** One turn in full: what asked, the answer, each tool call, the files changed. */
export interface ClaudeTurnDetail extends ClaudeTurn {
  promptText: string | null; promptBy: string | null; promptUser: UserSummary | null; text: string | null; error: string | null; attempts: number | null;
  startedAt: string | null; finishedAt: string | null;
  tools: { id: string; name: string; input: unknown; result: string | null; isError: boolean; startedAt: string; endedAt: string | null }[];
  changed: string[];
}
/** The teams the log (and the Claude stats) can show this person; `all`: a Studio admin, Studio-wide rows too. */
export interface AuditScope { all: boolean; teams: { id: string; name: string }[] }

export interface TeamMember extends UserSummary {
  role: TeamRole;
  joinedAt: string;
}

/** One team as its page shows it: the caller's role (null for an admin who is not a member) and counts. */
export interface TeamDetail {
  id: string;
  name: string;
  role: TeamRole | null;
  isMember: boolean;
  memberCount: number;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The steps a team skill was written for (kept on the skill; the agent reads every skill a project turns on). */
export type TeamSkillStep = "intake" | "web-research" | "trend-report" | "style" | "rnd" | "branding" | "plan-episodes" | "source-survey" | "edit-plan" | "timeline" | "youtube-kit";

/** "Quy chuẩn & skill" of a team: markdown the agent follows in the projects that turn it on. */
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

// ---------------------------------------------------------------------------

export function createStudioClient(getAccessToken: () => Promise<string>) {
  return {
    // ---- Me ----
    getMe(): Promise<MeProfile> {
      return request<MeProfile>(getAccessToken, "GET", "/api/me");
    },
    getOnboarding(): Promise<OnboardingProgress> {
      return request<OnboardingProgress>(getAccessToken, "GET", "/api/me/onboarding");
    },
    getPrefs(): Promise<UserPrefs> {
      return request<UserPrefs>(getAccessToken, "GET", "/api/me/prefs");
    },
    updatePrefs(patch: UserPrefsPatch): Promise<UserPrefs> {
      return request<UserPrefs>(getAccessToken, "PUT", "/api/me/prefs", patch);
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

    // ---- Activity log (Studio admin: everything; team owner: their teams) ----
    getAuditScope(): Promise<AuditScope> {
      return request(getAccessToken, "GET", "/api/audit/scope");
    },
    listAudit(q: AuditQuery = {}): Promise<AuditPage> {
      return request(getAccessToken, "GET", `/api/audit${buildQuery({ ...q })}`);
    },
    listAuditActors(teamId?: string): Promise<{ actors: UserSummary[] }> {
      return request(getAccessToken, "GET", `/api/audit/actors${buildQuery({ teamId })}`);
    },

    /** Claude chat statistics over a period, grouped by team, project, video or person (same viewers as the log). */
    getClaudeStats(q: ClaudeStatsQuery): Promise<ClaudeStats> {
      return request(getAccessToken, "GET", `/api/studio/stats/claude${buildQuery({ ...q })}`);
    },
    listClaudeTurns(q: ClaudeTurnsQuery): Promise<ClaudeTurnPage> {
      return request(getAccessToken, "GET", `/api/studio/stats/claude/turns${buildQuery({ ...q })}`);
    },
    getClaudeTurn(turnId: string): Promise<ClaudeTurnDetail> {
      return request(getAccessToken, "GET", `/api/studio/stats/claude/turns/${encodeURIComponent(turnId)}`);
    },

    // ---- Studio-wide ----
    /** The Queue screen: what runs in the projects the caller can see, Claude slots, the farm's machines. */
    getQueue(): Promise<StudioQueueView> {
      return request(getAccessToken, "GET", "/api/studio/queue");
    },
    /** Farm machines a final render may be pinned to (empty: none listed). */
    listFarmNodes(): Promise<{ nodes: FarmNode[] }> {
      return request(getAccessToken, "GET", "/api/studio/farm/nodes");
    },
    getClaudeUsage(): Promise<ClaudeUsage> {
      return request(getAccessToken, "GET", "/api/studio/claude");
    },
    setClaudeMaxConcurrent(claudeMaxConcurrent: number): Promise<ClaudeUsage> {
      return request(getAccessToken, "PUT", "/api/studio/settings", { claudeMaxConcurrent });
    },
    /** Studio admin: the Claude accounts, the turns on each now; `canStoreTokens`: the server can keep a token. */
    listClaudeAccounts(): Promise<{ accounts: ClaudeAccount[]; canStoreTokens: boolean }> {
      return request(getAccessToken, "GET", "/api/studio/claude-accounts");
    },
    createClaudeAccount(input: { name: string; token: string; maxConcurrent?: number | null }): Promise<ClaudeAccount> {
      return request(getAccessToken, "POST", "/api/studio/claude-accounts", input);
    },
    updateClaudeAccount(id: string, patch: { name?: string; token?: string; maxConcurrent?: number | null; enabled?: boolean }): Promise<ClaudeAccount> {
      return request(getAccessToken, "PATCH", `/api/studio/claude-accounts/${encodeURIComponent(id)}`, patch);
    },
    deleteClaudeAccount(id: string): Promise<void> {
      return request(getAccessToken, "DELETE", `/api/studio/claude-accounts/${encodeURIComponent(id)}`);
    },
    /** A worker makes one tiny call on it; the list then says how it went. */
    checkClaudeAccount(id: string): Promise<ClaudeAccount> {
      return request(getAccessToken, "POST", `/api/studio/claude-accounts/${encodeURIComponent(id)}/check`);
    },
    /** Studio admin: the farm's pools of machines and how many machines each has (empty: none, or the farm out of reach). */
    listFarmPools(): Promise<{ pools: { pool: string; machines: number }[] }> {
      return request(getAccessToken, "GET", "/api/studio/farm/pools");
    },
    /** The team's Claude accounts and farm pool (owners read, a Studio admin sets). */
    getTeamResources(teamId: string): Promise<TeamResources> {
      return request(getAccessToken, "GET", `/api/teams/${encodeURIComponent(teamId)}/resources`);
    },
    setTeamResources(teamId: string, input: { claudeAccountIds?: string[]; farmPool?: string | null }): Promise<TeamResources> {
      return request(getAccessToken, "PUT", `/api/teams/${encodeURIComponent(teamId)}/resources`, input);
    },
    /** A blank name goes back to "Claude". */
    setAssistantName(assistantName: string): Promise<ClaudeUsage> {
      return request(getAccessToken, "PUT", "/api/studio/settings", { assistantName });
    },
    /** The team's music library: active tracks (a Studio admin also gets the retired ones). */
    listMusic(): Promise<{ tracks: MusicTrackView[] }> {
      return request(getAccessToken, "GET", "/api/studio/music");
    },
    /** Studio admin: upload a track to the library (the same file again updates it), straight to the bucket first. */
    async addMusic(input: MusicTrackInput, onProgress?: OnProgress): Promise<MusicTrackView> {
      const f = input.file;
      const link = await request<UploadLink>(getAccessToken, "POST", "/api/studio/music/uploads", { name: f.name, size: f.size, ...uploadType(f) });
      await putToBucket(link, f, onProgress);
      return request(getAccessToken, "POST", "/api/studio/music", {
        displayName: input.displayName, moods: input.moods, origin: input.origin, originNote: input.originNote, loopOk: input.loopOk,
        uploadKey: link.key, name: f.name,
      });
    },
    /** Studio admin: rename, retag, retire or bring back a track. */
    updateMusic(trackId: string, patch: { displayName?: string; moods?: string[]; active?: boolean }): Promise<MusicTrackView> {
      return request(getAccessToken, "PATCH", `/api/studio/music/${encodeURIComponent(trackId)}`, patch);
    },
  };
}

/** Plan 2026-10-08 task 29: a track of the team's music library. */
export const MUSIC_ORIGINS = ["own", "licensed", "royalty_free"] as const;
export type MusicOrigin = (typeof MUSIC_ORIGINS)[number];
export interface MusicTrackView {
  trackId: string;
  displayName: string;
  moods: string[];
  durationSeconds: number;
  loopOk: boolean;
  origin: MusicOrigin;
  originNote: string;
  active: boolean;
  /** What a timeline's music points at, e.g. `library:music/<sha>.m4a`. */
  track: string;
  listenUrl: string;
}
export interface MusicTrackInput {
  file: File;
  displayName: string;
  moods: string[];
  origin: MusicOrigin;
  originNote: string;
  loopOk: boolean;
}

/** `assistantName`: what the web calls the AI ("Claude" until a Studio admin names it). */
export interface ClaudeUsage { running: number; waiting: number; max: number; source: "settings" | "env"; assistantName?: string }

/** A Claude account (plan 2026-10-30): never its token, only the last 4 characters. */
export interface ClaudeAccount {
  id: string; name: string; isDefault: boolean; tokenHint: string | null; maxConcurrent: number | null; enabled: boolean;
  rateLimitedUntil: string | null; lastUsedAt: string | null; lastError: string | null; lastErrorAt: string | null;
  check: { requestedAt: string | null; at: string | null; status: "ok" | "rate_limited" | "failed" | null; error: string | null };
  teams: { id: string; name: string }[]; createdAt: string;
  /** Turns running on it now (the list only). */
  running?: number;
}
/** A Claude account on the Queue (admins only). */
export interface QueueClaudeAccount {
  id: string; name: string; isDefault: boolean; enabled: boolean; maxConcurrent: number | null; running: number;
  rateLimitedUntil: string | null; lastError: string | null; teams: { id: string; name: string }[];
}
export interface TeamResources { claudeAccounts: { id: string; name: string; enabled: boolean }[]; farmPool: string | null }

/** Something running in a project, with the project it belongs to (the Queue lists many projects). */
export interface QueueItem extends Activity { projectId: string; projectName: string; teamId: string }
export interface StudioQueueView {
  claude: ClaudeUsage;
  /** Each Claude account, for a Studio admin; null for others (older APIs: absent). */
  claudeAccounts?: QueueClaudeAccount[] | null;
  items: QueueItem[];
  /** Things running in projects the caller cannot see. */
  hidden: number;
  /** The farm's machines; null when the farm could not be read. */
  machines: FarmNode[] | null;
  farm: { ok: true } | { ok: false; error: string };
  /** YouTube refusing to let the Studio server download now; null when not (older APIs: absent). */
  youtube?: YoutubeBlock | null;
  /** The same for the farm's machines that fetch reference videos. */
  youtubeFarm?: YoutubeBlock | null;
  /** Machines online that fetch reference videos (`studio.reference_fetch`); null when the farm could not be read. */
  referenceFetchers?: string[] | null;
}

/** A machine of the farm (ag-farm `GET /v1/owner/nodes`). */
export interface FarmNode {
  id: string; name: string; online: boolean; kinds: string[];
  gpus: { name: string; vram_mb: number; nvenc: boolean }[]; running_jobs: number; last_seen_at: string | null;
}

export type StudioClient = ReturnType<typeof createStudioClient>;

export function useStudioClient(): StudioClient {
  const { getAccessToken } = useAuthToken();
  return createStudioClient(getAccessToken);
}
