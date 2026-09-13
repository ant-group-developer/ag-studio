import { HarnessError, type Run, type StateStore } from "@harness/contracts";
import { isTerminal } from "../state/transitions.js";
import { eventFor, type Planner } from "./planner.js";

/** Total `total_cost_usd` spent across every run of `run`'s variant (including `run` itself); a run with no variant is just its own spend. */
export function variantSpent(store: StateStore, run: Run): number {
  if (!run.variant_id) return run.total_cost_usd;
  return store.listRuns({ variant_id: run.variant_id }).reduce((sum, r) => sum + r.total_cost_usd, 0);
}

export interface BudgetGate { blocked: boolean; spent: number; budget: number | null }

export function budgetBlocks(store: StateStore, run: Run): BudgetGate {
  const spent = variantSpent(store, run);
  if (run.budget_usd === undefined) return { blocked: false, spent, budget: null };
  return { blocked: spent >= run.budget_usd, spent, budget: run.budget_usd };
}

/** Raises a run's budget above its variant's current spend and re-advances the planner so any gated stage can release. */
export function raiseBudget(store: StateStore, planner: Planner, runId: string, budgetUsd: number): Run {
  return store.transaction(() => {
    const run = store.getRun(runId);
    if (!run) throw new HarnessError("NOT_FOUND", `run not found: ${runId}`, { runId });
    if (isTerminal("run", run.state)) throw new HarnessError("INVALID_TRANSITION", `run is ${run.state}; plan a new run instead`, { runId, state: run.state });
    const spent = variantSpent(store, run);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= spent) throw new HarnessError("CONFIG_INVALID", `budget must be greater than spent ($${spent}): ${budgetUsd}`, { runId, spent, budgetUsd });
    const from = run.budget_usd;
    store.updateRun({ ...run, budget_usd: budgetUsd });
    store.appendEvent(eventFor(run, null, null, "run.budget_raised", "info", { from: from ?? null, to: budgetUsd, spent }));
    planner.advance(runId);
    return store.getRun(runId)!;
  });
}
