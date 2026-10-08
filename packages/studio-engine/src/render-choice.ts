/**
 * Which kind of farm machine renders an episode's final cut (spec local-chat §3.4, migration 0021). The choice is
 * kept per run and stage; the worker turns it into the job's ag-farm `requirements` when it submits
 * (`requirementsFor` of `FarmExecutor`). No row means `{}`, as before phase 3.
 */
import { isDeepStrictEqual } from "node:util";
import type { FarmOwnerClient } from "@ag-farm/owner-client";
import { RENDER_MACHINES, renderRequirements, RenderMachineSchema, type RenderMachine } from "@harness/contracts";
import { StudioRunError } from "./run-control.js";
import { episodeForRun, getEpisode, type StudioDb } from "./studio-db.js";

/** How the chat names a machine type ("Render bản cuối trên …"). */
export const RENDER_MACHINE_LABELS: Record<RenderMachine, string> = {
  any: "bất kỳ máy nào", nvenc: "máy có NVENC", gpu: "máy có GPU",
};

/** A farm node a render is pinned to (ag-farm `GET /v1/owner/nodes`); the name is for showing it. */
export interface RenderNode { id: string; name: string }

export function setRenderChoice(db: StudioDb, p: {
  runId: string; stageKey: string; machine: RenderMachine; by: string; now: string;
  /** The run's episode, when the episode does not point at that run (yet, or any more). */
  episodeId?: string;
  /** Only this node may take the job; none (or null): any node of the machine type. */
  node?: RenderNode | null;
}): void {
  const machine = RenderMachineSchema.parse(p.machine);
  const ep = p.episodeId ? getEpisode(db, p.episodeId) : episodeForRun(db, p.runId);
  if (!ep) throw new StudioRunError("not_found", `no episode for run ${p.runId}: a render choice belongs to an episode`);
  db.run(
    `INSERT INTO studio_render_choices (run_id, stage_key, production_id, episode_id, machine, node_id, node_name, chosen_by, chosen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, stage_key) DO UPDATE SET machine = excluded.machine, node_id = excluded.node_id, node_name = excluded.node_name,
       chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at`,
    [p.runId, p.stageKey, ep.production_id, ep.id, machine, p.node?.id ?? null, p.node?.name ?? null, p.by, p.now],
  );
}

export function renderChoiceFor(db: StudioDb, runId: string, stageKey: string): RenderMachine | null {
  const r = db.get<{ machine: string }>("SELECT machine FROM studio_render_choices WHERE run_id = ? AND stage_key = ?", [runId, stageKey]);
  const parsed = RenderMachineSchema.safeParse(r?.machine);
  return parsed.success ? parsed.data : null;
}

/** A node someone picked for a final render, as the farm lists it now: it must exist and take final renders. */
export async function resolveRenderNode(farm: Pick<FarmOwnerClient, "listNodes">, nodeId: string): Promise<RenderNode> {
  const { nodes } = await farm.listNodes();
  const n = nodes.find((x) => x.id === nodeId);
  if (!n || !n.kinds.includes("studio.render_final")) {
    throw new StudioRunError("invalid", "máy này không có trên farm hoặc không nhận render bản cuối", { code: "unknown_node", node_id: nodeId });
  }
  return { id: n.id, name: n.name };
}

/** The node a run's stage is pinned to, or null. */
export function renderNodeFor(db: StudioDb, runId: string, stageKey: string): RenderNode | null {
  const r = db.get<{ node_id: string | null; node_name: string | null }>(
    "SELECT node_id, node_name FROM studio_render_choices WHERE run_id = ? AND stage_key = ?", [runId, stageKey]);
  return r?.node_id ? { id: r.node_id, name: r.node_name ?? r.node_id } : null;
}

/** The ag-farm `requirements` of a run's stage: its machine type, plus `node_id` when pinned; none chosen: undefined. */
export function renderChoiceRequirements(db: StudioDb, runId: string, stageKey: string): Record<string, unknown> | undefined {
  const machine = renderChoiceFor(db, runId, stageKey);
  if (!machine) return undefined;
  const node = renderNodeFor(db, runId, stageKey);
  return { ...renderRequirements(machine), ...(node ? { node_id: node.id } : {}) };
}

/** How the chat names where a render goes: the node when pinned, else the machine type. */
export function renderTargetLabel(machine: RenderMachine, node: RenderNode | null | undefined): string {
  return node ? `máy ${node.name}` : RENDER_MACHINE_LABELS[machine];
}

/** What the picker starts on: the production's latest choice, else any machine. */
export function defaultRenderMachine(db: StudioDb, productionId: string): RenderMachine {
  const r = db.get<{ machine: string }>(
    "SELECT machine FROM studio_render_choices WHERE production_id = ? ORDER BY chosen_at DESC LIMIT 1", [productionId]);
  const parsed = RenderMachineSchema.safeParse(r?.machine);
  return parsed.success ? parsed.data : "any";
}

/** The type a farm job was sent as, from `studio_farm_jobs.requirements` (null: before phase 3, or not one of ours). */
export function machineOfRequirements(json: string | null): RenderMachine | null {
  if (json === null) return null;
  let req: unknown;
  try { req = JSON.parse(json); } catch { return null; }
  if (!req || typeof req !== "object") return null;
  const { node_id: _pin, ...rest } = req as Record<string, unknown>;
  return RENDER_MACHINES.find((m) => isDeepStrictEqual(renderRequirements(m), rest)) ?? null;
}

/** The node a farm job was pinned to, from `studio_farm_jobs.requirements`. */
export function pinnedNodeOfRequirements(json: string | null): string | null {
  if (json === null) return null;
  try { const v = (JSON.parse(json) as { node_id?: unknown }).node_id; return typeof v === "string" ? v : null; } catch { return null; }
}
