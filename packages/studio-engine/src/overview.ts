/**
 * The left column and the home page of the chat UI (mockup screens 1–2): every video a person can see, its step,
 * and which group it is in — waiting for you, needs attention, running, done — with its episodes underneath.
 * One light query per production (no signed URLs, no farm calls).
 */
import { isTerminal } from "@harness/core";
import type { StudioEngineCore } from "./core.js";
import { episodeState, type EpisodeStatus } from "./run-control.js";
import { listEpisodes, type StudioDb } from "./studio-db.js";

export type OverviewGroup = "waiting_you" | "needs_attention" | "running" | "done";

export interface OverviewEpisode { id: string; idx: number; title: string; status: EpisodeStatus; step: string | null; group: OverviewGroup }
export interface OverviewItem {
  id: string; teamId: string; title: string; updatedAt: string;
  /** Stage the production is at (`intake` before its run; null once everything is done). */
  step: string | null;
  group: OverviewGroup;
  episodes: OverviewEpisode[];
}

const EPISODE_GROUP: Record<EpisodeStatus, OverviewGroup> = {
  waiting_approval: "waiting_you", failed: "needs_attention", producing: "running", planned: "running", ready: "done", cancelled: "done",
};

/** Most urgent first: what waits for the person, then problems, then work in progress, then done. */
const GROUP_ORDER: OverviewGroup[] = ["waiting_you", "needs_attention", "running", "done"];

function planState(core: StudioEngineCore, runId: string | null): { step: string | null; group: OverviewGroup | null } {
  if (!runId) return { step: "intake", group: "waiting_you" };
  const run = core.store.getRun(runId);
  if (!run) return { step: null, group: "needs_attention" };
  const stages = core.store.listStageRuns(runId);
  const gate = stages.find((s) => s.state === "WAITING_HUMAN" && s.executor.type === "gate");
  const failed = stages.find((s) => s.state === "FAILED" || (s.state === "WAITING_HUMAN" && s.executor.type !== "gate"));
  if (run.state === "CANCELLED" || run.state === "CANCEL_REQUESTED") return { step: null, group: "done" };
  if (failed || run.state === "FAILED") return { step: failed?.stage_key ?? null, group: "needs_attention" };
  if (gate && !isTerminal("run", run.state)) return { step: gate.stage_key, group: "waiting_you" };
  if (!isTerminal("run", run.state)) return { step: stages.find((s) => s.state !== "SUCCEEDED" && s.state !== "PENDING")?.stage_key ?? null, group: "running" };
  return { step: null, group: null }; // plan done: the episodes decide
}

export function studioOverview(core: StudioEngineCore, db: StudioDb, who: { userId: string; isAdmin: boolean }): OverviewItem[] {
  const rows = db.all<{ id: string; team_id: string; title: string; run_id: string | null; updated_at: string }>(
    who.isAdmin
      ? "SELECT id, team_id, title, run_id, updated_at FROM productions WHERE status <> 'archived' ORDER BY updated_at DESC"
      : `SELECT p.id, p.team_id, p.title, p.run_id, p.updated_at FROM productions p
           JOIN team_members tm ON tm.team_id = p.team_id AND tm.user_id = ?
          WHERE p.status <> 'archived' ORDER BY p.updated_at DESC`,
    who.isAdmin ? [] : [who.userId],
  );
  const items = rows.map((p): OverviewItem => {
    const episodes = listEpisodes(db, p.id).map((e): OverviewEpisode => {
      const st = episodeState(core, db, e);
      return { id: e.id, idx: e.idx, title: e.title, status: st.status, step: st.current_stage, group: EPISODE_GROUP[st.status] };
    });
    const plan = planState(core, p.run_id);
    const fromEpisodes = GROUP_ORDER.find((g) => episodes.some((e) => e.group === g)) ?? "done";
    return { id: p.id, teamId: p.team_id, title: p.title, updatedAt: p.updated_at, step: plan.step, group: plan.group ?? fromEpisodes, episodes };
  });
  return items.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}
