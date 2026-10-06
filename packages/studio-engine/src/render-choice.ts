/**
 * Which kind of farm machine renders an episode's final cut (spec local-chat §3.4, migration 0021). The choice is
 * kept per run and stage; the worker turns it into the job's ag-farm `requirements` when it submits
 * (`requirementsFor` of `FarmExecutor`). No row means `{}`, as before phase 3.
 */
import { RenderMachineSchema, type RenderMachine } from "@harness/contracts";
import { StudioRunError } from "./run-control.js";
import { episodeForRun, getEpisode, type StudioDb } from "./studio-db.js";

/** How the chat names a machine type ("Render bản cuối trên …"). */
export const RENDER_MACHINE_LABELS: Record<RenderMachine, string> = {
  any: "bất kỳ máy nào", nvenc: "máy có NVENC", gpu: "máy có GPU",
};

export function setRenderChoice(db: StudioDb, p: {
  runId: string; stageKey: string; machine: RenderMachine; by: string; now: string;
  /** The run's episode, when the episode does not point at that run (yet, or any more). */
  episodeId?: string;
}): void {
  const machine = RenderMachineSchema.parse(p.machine);
  const ep = p.episodeId ? getEpisode(db, p.episodeId) : episodeForRun(db, p.runId);
  if (!ep) throw new StudioRunError("not_found", `no episode for run ${p.runId}: a render choice belongs to an episode`);
  db.run(
    `INSERT INTO studio_render_choices (run_id, stage_key, production_id, episode_id, machine, chosen_by, chosen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, stage_key) DO UPDATE SET machine = excluded.machine, chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at`,
    [p.runId, p.stageKey, ep.production_id, ep.id, machine, p.by, p.now],
  );
}

export function renderChoiceFor(db: StudioDb, runId: string, stageKey: string): RenderMachine | null {
  const r = db.get<{ machine: string }>("SELECT machine FROM studio_render_choices WHERE run_id = ? AND stage_key = ?", [runId, stageKey]);
  const parsed = RenderMachineSchema.safeParse(r?.machine);
  return parsed.success ? parsed.data : null;
}

/** What the picker starts on: the production's latest choice, else any machine. */
export function defaultRenderMachine(db: StudioDb, productionId: string): RenderMachine {
  const r = db.get<{ machine: string }>(
    "SELECT machine FROM studio_render_choices WHERE production_id = ? ORDER BY chosen_at DESC LIMIT 1", [productionId]);
  const parsed = RenderMachineSchema.safeParse(r?.machine);
  return parsed.success ? parsed.data : "any";
}
