/**
 * What is running in a project right now (spec 2026-10-10 agent-workspace §5): agent turns (with the tool they are
 * in) and, from phase 4, jobs. One shape for all, so the web shows who works, since when, how far, and a Stop.
 */
import type { AgentPhase } from "@harness/adapter-agent-cli";
import type { StudioDb } from "../studio-db.js";
import type { MessageRecord } from "./threads-db.js";
import type { JobKind, JobRecord } from "../workspace/jobs-db.js";

export interface Activity {
  id: string;
  kind: "agent_turn" | "tool_call" | "job";
  /** `waiting` (in line for a slot), `running`, `rate_limited` (waits until `notBefore`). */
  status: "waiting" | "running" | "rate_limited";
  /** Agent turns: what it does now; tool calls: the tool's name; jobs: the job kind. */
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
  /** Jobs: their kind (`prepare_asset`, `render_preview`…); otherwise null. */
  jobKind: JobKind | null;
}

type TurnRow = MessageRecord & { thread_title: string; video_id: string | null };

/**
 * What runs in the project: agent turns waiting, running or held by the plan's limit (each running tool call under
 * its turn), then background jobs in line or running (what they do now, how far, time left, the farm machine).
 */
export async function agentActivity(db: StudioDb, projectId: string): Promise<Activity[]> {
  const rows = await db.all<TurnRow>(
    `SELECT m.*, t.title AS thread_title, t.video_id AS video_id FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id
      WHERE t.project_id = ? AND m.role = 'assistant' AND m.status IN ('pending', 'running', 'rate_limited')
      ORDER BY m.created_at`,
    [projectId],
  );
  const out: Activity[] = [];
  for (const m of rows) {
    const phase: AgentPhase | null = m.phase ?? null;
    const status = m.status === "running" ? "running" : m.status === "rate_limited" ? "rate_limited" : "waiting";
    out.push({
      id: m.id, kind: "agent_turn", status, title: "agent", phase, detail: null, startedAt: m.status === "running" ? m.started_at : null,
      notBefore: m.not_before, progress: null, etaSeconds: null, node: null, cancellable: true, parentId: null,
      threadId: m.thread_id, threadTitle: m.thread_title, videoId: m.video_id, jobKind: null,
    });
    if (m.status !== "running" || !m.parts) continue;
    for (const p of m.parts) {
      if (p.kind !== "tool" || p.ended_at) continue;
      out.push({
        id: `${m.id}:${p.id}`, kind: "tool_call", status: "running", title: p.name, phase: null, detail: null, startedAt: p.started_at,
        notBefore: null, progress: null, etaSeconds: null, node: null, cancellable: false, parentId: m.id,
        threadId: m.thread_id, threadTitle: m.thread_title, videoId: m.video_id, jobKind: null,
      });
    }
  }
  const jobs = await db.all<JobRecord & { thread_title: string | null }>(
    `SELECT j.*, t.title AS thread_title FROM project_jobs j LEFT JOIN agent_threads t ON t.id = j.thread_id
      WHERE j.project_id = ? AND j.status IN ('queued', 'running') ORDER BY j.created_at`,
    [projectId],
  );
  for (const j of jobs) {
    out.push({
      id: j.id, kind: "job", status: j.status === "running" ? "running" : "waiting", title: j.title, phase: null, detail: j.phase,
      startedAt: j.status === "running" ? j.started_at : null, notBefore: null, progress: j.progress, etaSeconds: j.eta_seconds, node: j.node_id,
      cancellable: !j.cancel_requested, parentId: null, threadId: j.thread_id, threadTitle: j.thread_title, videoId: j.video_id, jobKind: j.kind,
    });
  }
  return out;
}

export interface StudioActivityItem extends Activity { projectId: string; projectName: string; teamId: string }

/**
 * The Queue screen: what runs in every project the person can see (their teams' projects; a Studio admin sees all),
 * oldest project activity first; what runs elsewhere is only counted.
 */
export async function studioActivity(db: StudioDb, who: { userId: string; isAdmin: boolean }): Promise<{ items: StudioActivityItem[]; hidden: number }> {
  const busy = await db.all<{ id: string; name: string; team_id: string; mine: boolean }>(
    `SELECT p.id, p.name, p.team_id, EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = p.team_id AND tm.user_id = ?) AS mine
       FROM projects p
      WHERE EXISTS (SELECT 1 FROM project_jobs j WHERE j.project_id = p.id AND j.status IN ('queued', 'running'))
         OR EXISTS (SELECT 1 FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id
                     WHERE t.project_id = p.id AND m.role = 'assistant' AND m.status IN ('pending', 'running', 'rate_limited'))
      ORDER BY p.created_at, p.id`,
    [who.userId],
  );
  const items: StudioActivityItem[] = [];
  let hidden = 0;
  for (const p of busy) {
    const activity = await agentActivity(db, p.id);
    if (!who.isAdmin && !p.mine) { hidden += activity.filter((a) => a.parentId === null).length; continue; }
    for (const a of activity) items.push({ ...a, projectId: p.id, projectName: p.name, teamId: p.team_id });
  }
  return { items, hidden };
}

/**
 * Changes whenever a thread, a turn, a video, a source, a job or a suggested lesson of the project changes (the web refetches on it). A
 * running job's heartbeat does not count: only what it shows (phase, progress, machine) and its status.
 */
export async function projectFingerprint(db: StudioDb, projectId: string): Promise<string> {
  const jobs = await db.get<{ a: string | null; f: string | null; s: number; l: string | null }>(
    `SELECT (SELECT string_agg(id || status || COALESCE(phase::text, '') || COALESCE(CAST(progress * 100 AS INTEGER)::text, '') || COALESCE(node_id, '') || cancel_requested::text, ',')
               FROM project_jobs WHERE project_id = ? AND status IN ('queued', 'running')) AS a,
            (SELECT MAX(finished_at) FROM project_jobs WHERE project_id = ?) AS f,
            (SELECT COUNT(*) FROM project_sources WHERE project_id = ?) AS s,
            (SELECT COUNT(*)::text || ':' || (COUNT(*) FILTER (WHERE status = 'proposed'))::text || ':' || COALESCE(MAX(created_at)::text, '') || ':' || COALESCE(MAX(decided_at)::text, '')
               FROM lesson_proposals WHERE project_id = ?) AS l`,
    [projectId, projectId, projectId, projectId],
  );
  return `${await projectRowsFingerprint(db, projectId)}|${jobs?.a ?? ""}|${jobs?.f ?? ""}|${jobs?.s ?? 0}|${jobs?.l ?? ""}`;
}

async function projectRowsFingerprint(db: StudioDb, projectId: string): Promise<string> {
  const r = await db.get<{ m: string | null; t: string | null; v: string | null; n: number }>(
    `SELECT (SELECT MAX(m.updated_at) FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id WHERE t.project_id = ?) AS m,
            (SELECT MAX(updated_at) FROM agent_threads WHERE project_id = ?) AS t,
            (SELECT MAX(updated_at) FROM videos WHERE project_id = ?) AS v,
            (SELECT COUNT(*) FROM agent_threads WHERE project_id = ?) AS n`,
    [projectId, projectId, projectId, projectId],
  );
  return `${r?.m ?? ""}|${r?.t ?? ""}|${r?.v ?? ""}|${r?.n ?? 0}`;
}
