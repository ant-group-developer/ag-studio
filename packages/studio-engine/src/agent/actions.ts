/**
 * Actions with a real effect that the agent proposes and a person confirms (spec 2026-10-10 agent-workspace §3.5,
 * ADR-0001 item 183): render the final video, export for Premiere, delete a video, run a large crawl, download
 * reference videos. The agent's `propose_action` makes a card in the chat; someone with the role the action needs
 * confirms or rejects it; confirmed, Studio queues the work (a background job, whose end the thread hears of).
 * Cards expire after 24 h, or when the video's timeline changed since (for actions on one revision of it).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CrawlRequestSchema } from "@harness/contracts";
import { StudioRunError } from "../errors.js";
import type { StudioDb } from "../studio-db.js";
import { archiveVideo, getVideo, latestVideoRevision } from "../workspace/project-db.js";
import { createJob, type JobKind } from "../workspace/jobs-db.js";
import { crawlTitle, queueResearch } from "../workspace/research.js";
import { postSystemMessage, type ActorRole } from "./threads-db.js";

export const ACTION_KINDS = ["render_final", "export_premiere", "delete_video", "crawl_large", "reference_download"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export type ActionStatus = "proposed" | "confirmed" | "rejected" | "expired" | "failed";

/** Who may confirm each action. */
export const ACTION_ROLE: Record<ActionKind, ActorRole> = {
  render_final: "producer", export_premiere: "producer", delete_video: "producer", crawl_large: "editor", reference_download: "editor",
};
const ORDER: ActorRole[] = ["viewer", "editor", "producer", "owner"];
export const atLeastRole = (role: ActorRole, need: ActorRole) => ORDER.indexOf(role) >= ORDER.indexOf(need);

export const ACTION_TTL_MS = 24 * 3600_000;

const VideoId = z.string().min(1);
/** What each action takes. */
export const ACTION_PARAMS = {
  render_final: z.object({ video_id: VideoId, revision: z.number().int().min(1).optional(), node_id: z.string().uuid().optional() }).strict(),
  export_premiere: z.object({ video_id: VideoId, revision: z.number().int().min(1).optional() }).strict(),
  delete_video: z.object({ video_id: VideoId }).strict(),
  crawl_large: z.object({ crawl: CrawlRequestSchema }).strict(),
  reference_download: z.object({
    video_ids: z.array(z.string().regex(/^[\w-]{11}$/)).min(1).max(5),
    /** What to learn from them (the style of the channel, a sequence, the pace…). */
    purpose: z.string().trim().min(1).max(300),
  }).strict(),
} as const satisfies Record<ActionKind, z.ZodTypeAny>;

export interface ActionRecord {
  id: string; project_id: string; video_id: string | null; thread_id: string; message_id: string | null; kind: ActionKind; title: string;
  summary: string; params: Record<string, unknown>; revision: number | null; status: ActionStatus; decided_by: string | null; decided_at: string | null;
  job_id: string | null; error: string | null; created_by: string; created_at: string; expires_at: string;
}

export interface ActionView {
  id: string; projectId: string; videoId: string | null; threadId: string; messageId: string | null; kind: ActionKind; title: string; summary: string;
  params: unknown; revision: number | null; status: ActionStatus; needs: ActorRole; decidedBy: string | null; decidedAt: string | null;
  jobId: string | null; error: string | null; createdAt: string; expiresAt: string;
}

export function actionView(a: ActionRecord): ActionView {
  return {
    id: a.id, projectId: a.project_id, videoId: a.video_id, threadId: a.thread_id, messageId: a.message_id, kind: a.kind, title: a.title,
    summary: a.summary, params: a.params, revision: a.revision, status: a.status, needs: ACTION_ROLE[a.kind],
    decidedBy: a.decided_by, decidedAt: a.decided_at, jobId: a.job_id, error: a.error, createdAt: a.created_at, expiresAt: a.expires_at,
  };
}

export async function getAction(db: StudioDb, id: string): Promise<ActionRecord | undefined> {
  return db.get<ActionRecord>("SELECT * FROM agent_actions WHERE id = ?", [id]);
}

/** Actions of a thread (or of a project), oldest first; with `open`, those still waiting for a person. */
export async function listActions(db: StudioDb, where: { threadId?: string; projectId?: string; open?: boolean }): Promise<ActionRecord[]> {
  const conds: string[] = [];
  const params: string[] = [];
  if (where.threadId) { conds.push("thread_id = ?"); params.push(where.threadId); }
  if (where.projectId) { conds.push("project_id = ?"); params.push(where.projectId); }
  if (where.open) conds.push("status = 'proposed'");
  return db.all<ActionRecord>(`SELECT * FROM agent_actions ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY created_at, id`, params);
}

async function videoOf(db: StudioDb, projectId: string, videoId: string) {
  const v = await getVideo(db, videoId);
  if (!v || v.project_id !== projectId || v.archived_at) throw new StudioRunError("invalid", `không có video ${videoId} trong dự án`, { code: "no_video" });
  return v;
}

/** A card for a person to confirm. Video actions are tied to the timeline revision they were proposed on. */
export async function proposeAction(db: StudioDb, p: {
  projectId: string; threadId: string; messageId: string | null; kind: ActionKind; title: string; summary: string; params: unknown; createdBy: string;
}, now = new Date().toISOString()): Promise<ActionRecord> {
  const parsed = ACTION_PARAMS[p.kind].safeParse(p.params);
  if (!parsed.success) {
    throw new StudioRunError("invalid", `tham số của ${p.kind} sai: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(gốc)"}: ${i.message}`).join("; ")}`, { code: "bad_params" });
  }
  const params = parsed.data as Record<string, unknown>;
  let videoId: string | null = null;
  let revision: number | null = null;
  if ("video_id" in params) {
    videoId = (await videoOf(db, p.projectId, params.video_id as string)).id;
    if (p.kind === "render_final" || p.kind === "export_premiere") {
      const latest = (await latestVideoRevision(db, videoId))?.revision ?? null;
      if (latest === null) throw new StudioRunError("invalid", "video chưa có timeline: dựng timeline trước", { code: "no_timeline" });
      revision = (params.revision as number | undefined) ?? latest;
      if (revision !== latest) throw new StudioRunError("invalid", `timeline đang ở bản ${latest}, không phải ${revision}`, { code: "stale_revision" });
      params.revision = revision;
    }
  }
  return (await db.get<ActionRecord>(
    `INSERT INTO agent_actions (id, project_id, video_id, thread_id, message_id, kind, title, summary, params, revision, status, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?) RETURNING *`,
    [randomUUID(), p.projectId, videoId, p.threadId, p.messageId, p.kind, p.title.trim().slice(0, 200), p.summary.trim().slice(0, 4000), JSON.stringify(params), revision,
      p.createdBy, now, new Date(Date.parse(now) + ACTION_TTL_MS).toISOString()],
  ))!;
}

/** A card past its time, or whose video's timeline moved on, cannot be confirmed any more. */
export async function actionExpired(db: StudioDb, a: ActionRecord, now: string): Promise<string | null> {
  if (Date.parse(now) > Date.parse(a.expires_at)) return "thẻ đã quá 24 giờ";
  if (a.revision !== null && a.video_id) {
    const latest = (await latestVideoRevision(db, a.video_id))?.revision ?? null;
    if (latest !== a.revision) return `timeline đã đổi (bản ${latest ?? "—"}, thẻ cho bản ${a.revision})`;
  }
  return null;
}

/** The job a confirmed action runs as, by kind (render and export handlers live with the renders). */
const JOB_OF: Partial<Record<ActionKind, JobKind>> = { render_final: "render_final", export_premiere: "export_premiere", reference_download: "style_watch" };

/**
 * A person confirms or rejects a card. Confirmed: the work is queued (its job tells the thread when it ends and lets
 * the agent go on), or done at once (delete a video). Either way the thread gets a line saying who decided.
 */
export async function decideAction(db: StudioDb, p: { actionId: string; decision: "confirm" | "reject"; userId: string; role: ActorRole }, now = new Date().toISOString()): Promise<ActionRecord> {
  const set = (status: ActionStatus, extra: { job_id?: string | null; error?: string | null } = {}) => db.run(
    "UPDATE agent_actions SET status = ?, decided_by = ?, decided_at = ?, job_id = ?, error = ? WHERE id = ? AND status = 'proposed'",
    [status, p.userId, now, extra.job_id ?? null, extra.error ?? null, p.actionId],
  );
  // the work runs in the decision's transaction: a card is decided once, and a failure leaves nothing half done
  let working = false;
  try {
    const out = await db.tx(async (): Promise<{ action: ActionRecord } | { expired: string }> => {
      const a = await getAction(db, p.actionId);
      if (!a) throw new StudioRunError("not_found", `không có thẻ ${p.actionId}`);
      if (a.status !== "proposed") throw new StudioRunError("conflict", "thẻ đã được quyết rồi", { code: "decided" });
      const need = ACTION_ROLE[a.kind];
      if (!atLeastRole(p.role, need)) throw new StudioRunError("rejected", `cần vai ${need} để quyết thẻ này`, { code: "role" });
      const tell = (text: string) => postSystemMessage(db, { threadId: a.thread_id, text, trigger: "action", continueAgent: false }, now);
      if (p.decision === "reject") {
        await set("rejected");
        await tell(`Người dùng đã **từ chối**: ${a.title}.`);
        return { action: (await getAction(db, a.id))! };
      }
      const expired = await actionExpired(db, a, now);
      if (expired) {
        await set("expired", { error: expired });
        return { expired };
      }
      working = true;
      const params = a.params;
      let jobId: string | null = null;
      if (a.kind === "delete_video") {
        await archiveVideo(db, params.video_id as string, now);
      } else if (a.kind === "crawl_large") {
        const crawl = CrawlRequestSchema.parse(params.crawl);
        jobId = (await queueResearch(db, { projectId: a.project_id, crawl, threadId: a.thread_id, continueAgent: true, createdBy: p.userId, actorRole: p.role }, now)).id;
      } else {
        const kind = JOB_OF[a.kind]!;
        jobId = (await createJob(db, {
          projectId: a.project_id, videoId: a.video_id, threadId: a.thread_id, kind, title: a.title, request: { ...params, action_id: a.id },
          continueAgent: true, createdBy: p.userId, actorRole: p.role,
        }, now)).id;
      }
      await set("confirmed", { job_id: jobId });
      await tell(`Người dùng đã **xác nhận**: ${a.title}.${jobId ? " Studio đang làm (xem thẻ việc nền)." : ""}`);
      return { action: (await getAction(db, a.id))! };
    });
    if ("expired" in out) throw new StudioRunError("invalid", `thẻ hết hiệu lực: ${out.expired}; nhờ agent đề xuất lại`, { code: "expired" });
    return out.action;
  } catch (e) {
    if (working) await set("failed", { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** The card's text for a crawl, when the agent gives none. */
export const crawlActionTitle = (crawl: unknown) => `Crawl lớn: ${crawlTitle(CrawlRequestSchema.parse(crawl))}`;
