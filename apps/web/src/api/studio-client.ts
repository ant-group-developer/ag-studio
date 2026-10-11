import { useAuthToken } from "../auth/use-auth-token";
import type { Activity } from "./workspace-client";

import { buildQuery, request, StudioHttpError } from "./http";

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

export interface Team {
  id: string;
  name: string;
  role: TeamRole | null;
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
    /** A blank name goes back to "Claude". */
    setAssistantName(assistantName: string): Promise<ClaudeUsage> {
      return request(getAccessToken, "PUT", "/api/studio/settings", { assistantName });
    },
    /** The team's music library: active tracks (a Studio admin also gets the retired ones). */
    listMusic(): Promise<{ tracks: MusicTrackView[] }> {
      return request(getAccessToken, "GET", "/api/studio/music");
    },
    /** Studio admin: upload a track to the library (the same file again updates it). */
    addMusic(input: MusicTrackInput): Promise<MusicTrackView> {
      const form = new FormData();
      form.append("displayName", input.displayName);
      form.append("moods", input.moods.join(","));
      form.append("origin", input.origin);
      form.append("originNote", input.originNote);
      form.append("loopOk", String(input.loopOk));
      form.append("file", input.file);
      return request(getAccessToken, "POST", "/api/studio/music", form);
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

/** Something running in a project, with the project it belongs to (the Queue lists many projects). */
export interface QueueItem extends Activity { projectId: string; projectName: string; teamId: string }
export interface StudioQueueView {
  claude: ClaudeUsage;
  items: QueueItem[];
  /** Things running in projects the caller cannot see. */
  hidden: number;
  /** The farm's machines; null when the farm could not be read. */
  machines: FarmNode[] | null;
  farm: { ok: true } | { ok: false; error: string };
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
