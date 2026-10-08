/**
 * The Queue screen (mockup 12, plan phase 3): Claude calls running or waiting for a slot, and the farm jobs not done
 * yet, limited to the videos a person can see (team members; a Studio admin sees all). Farm jobs and machines come
 * from ag-farm's owner API (`listJobs`, `listNodes`): each job says which node runs it, and which one it is pinned to.
 */
import type { FarmOwnerClient } from "@ag-farm/owner-client";
import type { OwnerNodeView } from "@ag-farm/protocol";
import type { RenderMachine } from "@harness/contracts";
import { claudeUsage } from "./claude-slots.js";
import type { StudioEngineCore } from "./core.js";
import { machineOfRequirements, pinnedNodeOfRequirements } from "./render-choice.js";
import type { StudioDb } from "./studio-db.js";

/** `listNodes` is optional: a hub from before `GET /v1/owner/nodes` lists no machines. */
export type QueueFarm = Pick<FarmOwnerClient, "listJobs"> & Partial<Pick<FarmOwnerClient, "listNodes">>;

/** A job queued this long was taken by no node: maybe none fits its requirements (the farm does not say). */
export const QUEUE_STUCK_MINUTES = 10;
const ACTIVE = "queued,leased,paused";
const MAX_PAGES = 4;

interface Where {
  productionId: string; productionTitle: string; episodeId: string | null; episodeIdx: number | null; episodeTitle: string | null;
}
export interface QueueClaudeItem extends Where {
  source: "chat" | "stage";
  /** A reply waiting for a slot (`chat-wait:` row). */
  waiting: boolean;
  /** The step: the gate or stage the reply is about, or the stage running. */
  step: string;
  since: string | null;
}
export type QueueRenderKind = "final" | "preview" | "export_premiere" | "other";
export interface QueueRender extends Where {
  farmJobId: string; kind: QueueRenderKind;
  /** The type it was sent as; null when unknown (sent before phase 3). */
  machine: RenderMachine | null;
  status: string; progress: number | null; progressStage: string | null; attempt: number; createdAt: string;
  stuck: boolean;
  /** The node running it (a leased job); `name` null when the hub did not list it. */
  node: { id: string; name: string | null } | null;
  /** The node it was pinned to, if any. */
  pinned: { id: string; name: string | null } | null;
}
export interface StudioQueue {
  claude: { running: number; waiting: number; max: number; items: QueueClaudeItem[]; hidden: number };
  renders: QueueRender[];
  /** Jobs of videos the person cannot see. */
  hiddenRenders: number;
  /** The farm's machines this Studio can use; null when the hub does not list them. */
  machines: OwnerNodeView[] | null;
  farm: { ok: true } | { ok: false; error: string };
}

const KINDS: Record<string, QueueRenderKind> = {
  "studio.render_final": "final", "studio.render_preview": "preview", "studio.export_premiere": "export_premiere",
};

export async function studioQueue(
  core: StudioEngineCore, db: StudioDb, farm: QueueFarm,
  who: { userId: string; isAdmin: boolean; now: string; claudeMax: number },
): Promise<StudioQueue> {
  const visible = new Set(db.all<{ id: string }>(
    who.isAdmin ? "SELECT id FROM productions" : "SELECT p.id FROM productions p JOIN team_members tm ON tm.team_id = p.team_id AND tm.user_id = ?",
    who.isAdmin ? [] : [who.userId]).map((r) => r.id));
  const where = whereOf(db);
  const claude = claudeItems(core, db, where, visible, who.now);
  const usage = claudeUsage(db, who.now);

  let jobs: Awaited<ReturnType<QueueFarm["listJobs"]>>["jobs"] = [];
  let farmState: StudioQueue["farm"] = { ok: true };
  try {
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await farm.listJobs({ status: ACTIVE, limit: 500, ...(after ? { after } : {}) });
      jobs = jobs.concat(res.jobs);
      if (!res.next_cursor) break;
      after = res.next_cursor;
    }
  } catch (e) {
    farmState = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  let machines: OwnerNodeView[] | null = null;
  if (farmState.ok && farm.listNodes) {
    try { machines = (await farm.listNodes()).nodes; } catch { machines = null; }
  }
  const nodeRef = (id: string | null) => (id ? { id, name: machines?.find((m) => m.id === id)?.name ?? null } : null);

  const renders: QueueRender[] = [];
  let hiddenRenders = 0;
  for (const j of jobs) {
    const row = db.get<{ production_id: string; episode_id: string | null; job_type: string; requirements: string | null }>(
      "SELECT production_id, episode_id, job_type, requirements FROM studio_farm_jobs WHERE farm_job_id = ?", [j.id]);
    if (!row) continue; // a job of this owner key that Studio did not send (another environment): not ours to show
    if (!visible.has(row.production_id)) { hiddenRenders += 1; continue; }
    renders.push({
      farmJobId: j.id, kind: KINDS[row.job_type] ?? "other", ...where(row.production_id, row.episode_id),
      machine: machineOfRequirements(row.requirements),
      status: j.status, progress: j.progress_percent ?? null, progressStage: j.progress_stage ?? null, attempt: j.attempt_count,
      createdAt: j.created_at,
      stuck: j.status === "queued" && Date.parse(who.now) - Date.parse(j.created_at) > QUEUE_STUCK_MINUTES * 60_000,
      node: nodeRef(j.node_id ?? null), pinned: nodeRef(pinnedNodeOfRequirements(row.requirements)),
    });
  }
  return {
    claude: { ...usage, max: who.claudeMax, items: claude.items, hidden: claude.hidden },
    renders, hiddenRenders, machines, farm: farmState,
  };
}

/** Titles of a production and episode, memoised for one call. */
function whereOf(db: StudioDb): (productionId: string, episodeId: string | null) => Where {
  const prods = new Map<string, string>();
  const eps = new Map<string, { idx: number; title: string } | null>();
  return (productionId, episodeId) => {
    if (!prods.has(productionId)) prods.set(productionId, db.get<{ title: string }>("SELECT title FROM productions WHERE id = ?", [productionId])?.title ?? "");
    if (episodeId && !eps.has(episodeId)) eps.set(episodeId, db.get<{ idx: number; title: string }>("SELECT idx, title FROM episodes WHERE id = ?", [episodeId]) ?? null);
    const ep = episodeId ? eps.get(episodeId) ?? null : null;
    return { productionId, productionTitle: prods.get(productionId)!, episodeId: ep ? episodeId : null, episodeIdx: ep?.idx ?? null, episodeTitle: ep?.title ?? null };
  };
}

function claudeItems(
  core: StudioEngineCore, db: StudioDb, where: ReturnType<typeof whereOf>, visible: Set<string>, now: string,
): { items: QueueClaudeItem[]; hidden: number } {
  const rows = db.all<{ stage_run_id: string; attempt_id: string; owner: string; resources: string }>(
    "SELECT stage_run_id, attempt_id, owner, resources FROM lease WHERE expires_at >= ? ORDER BY rowid", [now]);
  const items: QueueClaudeItem[] = [];
  let hidden = 0;
  for (const r of rows) {
    if (!(JSON.parse(r.resources) as string[]).includes("claude")) continue;
    const chat = /^chat(-wait)?:(.+)$/.exec(r.owner);
    let item: QueueClaudeItem | null = null;
    if (chat) {
      const turn = db.get<{ production_id: string; episode_id: string | null; stage_key: string; updated_at: string }>(
        "SELECT production_id, episode_id, stage_key, updated_at FROM stage_chat_turns WHERE id = ?", [chat[2]!]);
      if (turn) item = { source: "chat", waiting: !!chat[1], ...where(turn.production_id, turn.episode_id), step: turn.stage_key, since: turn.updated_at };
    } else {
      const stage = core.store.getStageRun(r.stage_run_id);
      const prod = stage ? productionOfRun(db, stage.run_id) : null;
      if (stage && prod) {
        item = { source: "stage", waiting: false, ...where(prod.productionId, prod.episodeId), step: stage.stage_key, since: core.store.getAttempt(r.attempt_id)?.started_at ?? null };
      }
    }
    if (item && visible.has(item.productionId)) items.push(item);
    else hidden += 1;
  }
  return { items, hidden };
}

function productionOfRun(db: StudioDb, runId: string): { productionId: string; episodeId: string | null } | null {
  const ep = db.get<{ id: string; production_id: string }>("SELECT id, production_id FROM episodes WHERE run_id = ?", [runId]);
  if (ep) return { productionId: ep.production_id, episodeId: ep.id };
  const p = db.get<{ id: string }>("SELECT id FROM productions WHERE run_id = ?", [runId]);
  return p ? { productionId: p.id, episodeId: null } : null;
}

/**
 * `listJobs` answered from memory for `ttlMs` per query: every open Queue screen and header chip polls, and they
 * should not each reach the farm. A failure is not kept.
 */
export function cachedQueueFarm(farm: QueueFarm, ttlMs: number, now: () => number = Date.now): QueueFarm {
  const hits = new Map<string, { at: number; value: Promise<Awaited<ReturnType<QueueFarm["listJobs"]>>> }>();
  let nodes: { at: number; value: Promise<Awaited<ReturnType<NonNullable<QueueFarm["listNodes"]>>>> } | null = null;
  const listNodes = farm.listNodes?.bind(farm);
  return {
    ...(listNodes ? {
      listNodes() {
        if (nodes && now() - nodes.at <= ttlMs) return nodes.value;
        const value = listNodes();
        const entry = { at: now(), value };
        nodes = entry;
        value.catch(() => { if (nodes === entry) nodes = null; });
        return value;
      },
    } : {}),
    listJobs(query) {
      const key = JSON.stringify(query ?? {});
      const hit = hits.get(key);
      if (hit && now() - hit.at <= ttlMs) return hit.value;
      const value = farm.listJobs(query);
      hits.set(key, { at: now(), value });
      value.catch(() => { if (hits.get(key)?.value === value) hits.delete(key); });
      return value;
    },
  };
}
