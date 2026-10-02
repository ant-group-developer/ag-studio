/**
 * The production's R&D and branding after approval: read them, and let a person edit them in place. An edit is
 * checked like the gate checks it and only reaches later AI steps (the next episode runs, a re-plan from `brief`);
 * nothing already made changes.
 */
import { isTerminal, validateBranding, validateRnd, type StudioProblem } from "@harness/core";
import type { StudioBranding, StudioRnd } from "@harness/contracts";
import type { StudioEngineCore } from "./core.js";
import { StudioRunError } from "./run-control.js";
import {
  getProduction, productionBranding, productionChannels, productionHints, productionRnd, saveProductionDocument, type StudioDb,
} from "./studio-db.js";

export type ProductionDocKind = "rnd" | "branding";
const GATE: Record<ProductionDocKind, { gate: string; apply: string }> = {
  rnd: { gate: "approve-rnd", apply: "apply-rnd" },
  branding: { gate: "approve-branding", apply: "apply-branding" },
};

export interface ProductionDocView<T> { document: T | null; updatedAt: string | null; updatedBy: string | null }

export function productionDocument(db: StudioDb, productionId: string, kind: "rnd"): ProductionDocView<StudioRnd>;
export function productionDocument(db: StudioDb, productionId: string, kind: "branding"): ProductionDocView<StudioBranding>;
export function productionDocument(db: StudioDb, productionId: string, kind: ProductionDocKind): ProductionDocView<StudioRnd | StudioBranding> {
  const p = getProduction(db, productionId);
  if (!p) throw new StudioRunError("not_found", `production ${productionId} not found`);
  return kind === "rnd"
    ? { document: productionRnd(p), updatedAt: p.rnd_updated_at, updatedBy: p.rnd_updated_by }
    : { document: productionBranding(p), updatedAt: p.branding_updated_at, updatedBy: p.branding_updated_by };
}

/**
 * Replace the production's R&D or branding with a person's edit. Refused (409) before the first approval, while
 * the plan run waits at that gate (approve there instead), and in the moment between the approval and its apply
 * stage (the apply would overwrite the edit); refused (422 with `problems`) when the check fails. Warnings (e.g.
 * leaving a hint) do not block: a person may decide differently.
 */
export function editProductionDocument(
  core: StudioEngineCore, db: StudioDb, productionId: string, kind: ProductionDocKind, raw: unknown, by: string,
): { document: StudioRnd | StudioBranding; before: StudioRnd | StudioBranding; warnings: StudioProblem[] } {
  const p = getProduction(db, productionId);
  if (!p) throw new StudioRunError("not_found", `production ${productionId} not found`);
  const before = kind === "rnd" ? productionRnd(p) : productionBranding(p);
  if (!before) {
    throw new StudioRunError("conflict", `${kind === "rnd" ? "R&D" : "branding"} chưa được duyệt lần nào: duyệt ở bước của nó trước`, { code: "not_approved_yet" });
  }
  if (p.run_id) {
    const run = core.store.getRun(p.run_id);
    const stages = core.store.listStageRuns(p.run_id);
    const gate = stages.find((s) => s.stage_key === GATE[kind].gate);
    const apply = stages.find((s) => s.stage_key === GATE[kind].apply);
    if (gate?.state === "WAITING_HUMAN") {
      throw new StudioRunError("conflict", "kế hoạch đang chờ duyệt bước này: sửa và duyệt ở đó", { code: "gate_waiting", gate: GATE[kind].gate });
    }
    if (run && !isTerminal("run", run.state) && gate?.state === "SUCCEEDED" && apply && apply.state !== "SUCCEEDED") {
      throw new StudioRunError("conflict", "bản vừa duyệt đang được áp vào production, thử lại sau vài giây", { code: "apply_pending" });
    }
  }
  const v = kind === "rnd"
    ? validateRnd(raw, { seed: { channels: productionChannels(p), hints: productionHints(p) } })
    : validateBranding(raw);
  if (!v.ok || !v.value) throw new StudioRunError("rejected", `${kind} không hợp lệ`, { problems: v.problems, warnings: v.warnings });
  saveProductionDocument(db, productionId, kind, v.value, by);
  return { document: v.value, before, warnings: v.warnings };
}
