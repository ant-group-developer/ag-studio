import type { Run, StageRun, StateStore } from "@harness/contracts";
import { eventFor } from "./planner.js";

type GraphNode = Pick<StageRun, "stage_key" | "depends_on" | "depends_on_optional">;

/** Transitive dependants of `stageKey` over required and optional edges (excluding itself). */
export function dependantsOf(stages: GraphNode[], stageKey: string): string[] {
  const out = new Set<string>();
  const frontier = [stageKey];
  while (frontier.length) {
    const k = frontier.pop()!;
    for (const s of stages) {
      if (out.has(s.stage_key) || s.stage_key === stageKey) continue;
      if (s.depends_on.includes(k) || s.depends_on_optional.includes(k)) { out.add(s.stage_key); frontier.push(s.stage_key); }
    }
  }
  return [...out];
}

/** A stage of `run` produced a new ACCEPTED artifact: earlier runs of the same variant lose that stage's and its dependants' artifacts. Must run inside a transaction. */
export function invalidateDownstream(p: { store: StateStore; run: Run; stageKey: string; now: string }): { stale: string[] } {
  if (!p.run.variant_id) return { stale: [] };
  const graph = p.store.listStageRuns(p.run.run_id);
  const affected = new Set([p.stageKey, ...dependantsOf(graph, p.stageKey)]);
  const stale: string[] = [];
  for (const other of p.store.listRuns({ variant_id: p.run.variant_id })) {
    if (other.run_id === p.run.run_id) continue;
    for (const s of p.store.listStageRuns(other.run_id)) {
      if (!affected.has(s.stage_key)) continue;
      for (const a of p.store.listArtifacts({ stage_run_id: s.stage_run_id, status: "ACCEPTED" })) {
        p.store.transition("artifact", a.artifact_id, "ACCEPTED", "STALE", eventFor(other, s, null, "artifact.stale", "info", { artifact_id: a.artifact_id, superseded_by_run: p.run.run_id, stage_key: p.stageKey }));
        stale.push(a.artifact_id);
      }
    }
  }
  return { stale };
}
