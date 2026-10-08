/**
 * The document of a step, read again and edited after the step was approved (plan 2026-10-07 step history): the
 * approved version (the gate's own output) or the version in use when someone edited it in place; an edit either
 * replaces the version in use (only steps that run later read it) or reopens the step — the run starts again from
 * that gate with the edit as the version on show, and the person approves it again.
 */
import { isTerminal, validateYoutubeKit, type StudioProblem } from "@harness/core";
import {
  EditPlanSchema, SeriesPlanSchema, StudioBrandingSchema, StudioRndSchema, StudioStyleSchema, StudioSurveySchema, TrendReportSchema, YoutubeKitSchema,
  type StudioSurvey,
} from "@harness/contracts";
import type { z } from "zod";
import { insertSystemTurn, insertUserTurn, type ChatScopeKey } from "./chat-db.js";
import type { SurveyProposal } from "./chat-context.js";
import type { StudioEngineCore } from "./core.js";
import { rerunEpisodeFrom } from "./cut-episode.js";
import { recordHumanEdit, type HumanEditKind } from "./llm-log.js";
import { editProductionDocument } from "./production-docs.js";
import {
  assertNoEpisodeProducing, readStageDocument, resumePlanRunFrom, stagesFrom, STUDIO_GATES, StudioRunError,
} from "./run-control.js";
import {
  getEpisode, getProduction, listEpisodes, productionBranding, productionRnd, productionStyle, saveTrendReport, type EpisodeRecord, type ProductionRecord,
  type StudioDb,
} from "./studio-db.js";

export const STEP_DOC_KINDS = ["trend_report", "rnd", "branding", "series_plan", "youtube_kit", "survey", "edit_plan", "style"] as const;
export type StepDocKind = (typeof STEP_DOC_KINDS)[number];

/** The gate each document is approved at. */
export const STEP_DOC_GATES: Record<StepDocKind, string> = {
  trend_report: "approve-trend-report", rnd: "approve-rnd", branding: "approve-branding", series_plan: "approve-plan",
  youtube_kit: "approve-youtube-kit", survey: "approve-survey", edit_plan: "approve-edit-plan", style: "approve-style",
};

const EPISODE_KINDS: ReadonlySet<StepDocKind> = new Set(["youtube_kit", "survey", "edit_plan"]);
const SCHEMAS: Record<StepDocKind, z.ZodTypeAny> = {
  trend_report: TrendReportSchema, rnd: StudioRndSchema, branding: StudioBrandingSchema, series_plan: SeriesPlanSchema,
  youtube_kit: YoutubeKitSchema, survey: StudioSurveySchema, edit_plan: EditPlanSchema, style: StudioStyleSchema,
};
const LABELS: Record<StepDocKind, string> = {
  trend_report: "nghiên cứu thị trường", rnd: "R&D", branding: "branding", series_plan: "kế hoạch tập",
  youtube_kit: "YouTube kit", survey: "chọn cảnh", edit_plan: "kế hoạch dựng", style: "phong cách dựng",
};
const EDIT_KINDS: Record<StepDocKind, HumanEditKind> = {
  trend_report: "trend_report", rnd: "rnd_edit", branding: "branding_edit", series_plan: "series_plan",
  youtube_kit: "youtube_kit", survey: "survey", edit_plan: "edit_plan", style: "style_edit",
};
/** Stages that do no work right now: a run made only of these can be cancelled and started again. */
const IDLE: readonly string[] = ["SUCCEEDED", "PENDING", "WAITING_HUMAN", "FAILED", "CANCELLED"];

export interface StepDocEdit {
  /** Saving replaces the version in use; the steps that run later read it, nothing made already changes. */
  inPlace: boolean;
  /** Why not (`only_reopen`: nothing reads a version in use of this document; `render_again`; `not_approved_yet`; …). */
  inPlaceCode: string | null;
  /** The step can be opened again: the run starts again from its gate with the edit on show. */
  reopen: boolean;
  reopenCode: string | null;
  /** Reopening makes the episodes again (the series plan runs `spawn-episodes` once more): every episode is replaced. */
  replacesEpisodes: boolean;
  /** Stage keys that run again when the step reopens, the gate first. */
  reruns: string[];
}

export interface StepDocView {
  kind: StepDocKind;
  gate: string;
  /** `waiting`: the gate waits now (edit it through the chat's manual edit); `approved`: passed. */
  state: "not_yet" | "waiting" | "approved";
  /** The version in use when there is one, else the approved one; null unless approved. */
  document: unknown;
  /** `document` is a version edited after the approval. */
  inUse: boolean;
  edit: StepDocEdit;
}

interface Where { p: ProductionRecord; ep: EpisodeRecord | null; runId: string | null }

function where(db: StudioDb, productionId: string, episodeId: string | null | undefined, kind: StepDocKind): Where {
  if (!(STEP_DOC_KINDS as readonly string[]).includes(kind)) throw new StudioRunError("invalid", `${kind} is not a step document`, { code: "bad_kind" });
  const p = getProduction(db, productionId);
  if (!p) throw new StudioRunError("not_found", `production ${productionId} not found`);
  if (!EPISODE_KINDS.has(kind)) {
    if (episodeId) throw new StudioRunError("invalid", `${kind} belongs to the series, not an episode`, { code: "bad_kind" });
    return { p, ep: null, runId: p.run_id };
  }
  if (!episodeId) throw new StudioRunError("invalid", `${kind} belongs to an episode`, { code: "bad_kind" });
  const ep = getEpisode(db, episodeId);
  if (!ep || ep.production_id !== productionId) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  return { p, ep, runId: ep.run_id };
}

function parsed(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** The version in use of a document, kept outside the run (edited in place, or written by the step after the gate). */
function inUseOf(w: Where, kind: StepDocKind): unknown {
  switch (kind) {
    case "rnd": return productionRnd(w.p);
    case "branding": return productionBranding(w.p);
    case "style": return productionStyle(w.p);
    case "trend_report": return parsed(w.p.trend_report);
    case "youtube_kit": return parsed(w.ep?.youtube ?? null);
    default: return null;
  }
}

/** Why the step cannot be reopened now (null: it can). Plan steps also wait for no episode to be producing. */
function reopenBlock(core: StudioEngineCore, db: StudioDb, w: Where, kind: StepDocKind): string | null {
  if (kind === "youtube_kit") return "render_again";
  if (!w.runId) return "not_approved_yet";
  const run = core.store.getRun(w.runId);
  const stages = core.store.listStageRuns(w.runId);
  if (!run || stages.find((s) => s.stage_key === STEP_DOC_GATES[kind])?.state !== "SUCCEEDED") return "not_approved_yet";
  if (!isTerminal("run", run.state) && stages.some((s) => !IDLE.includes(s.state))) return "running";
  if (!EPISODE_KINDS.has(kind)) {
    try { assertNoEpisodeProducing(core, db, w.p.id); } catch { return "episode_producing"; }
  }
  return null;
}

function inPlaceBlock(core: StudioEngineCore, w: Where, kind: StepDocKind): string | null {
  switch (kind) {
    case "rnd": case "branding": case "style": {
      if (!inUseOf(w, kind)) return "apply_pending";
      // the moment between the approval and the step that writes it in: that step would overwrite the edit
      const apply = w.runId ? core.store.listStageRuns(w.runId).find((s) => s.stage_key === `apply-${kind}`) : undefined;
      return apply && apply.state !== "SUCCEEDED" ? "apply_pending" : null;
    }
    // the episodes read the series' trend report once they are made; before that, the plan writes it from the gate
    case "trend_report": return w.p.trend_report ? null : "only_reopen";
    case "youtube_kit": return null;
    default: return "only_reopen";
  }
}

/** A step's document after (or before) its approval, and what editing it would do. */
export function stepDocument(core: StudioEngineCore, db: StudioDb, p: { productionId: string; episodeId?: string | null; kind: StepDocKind }): StepDocView {
  const w = where(db, p.productionId, p.episodeId, p.kind);
  const gate = STEP_DOC_GATES[p.kind];
  const none: StepDocEdit = { inPlace: false, inPlaceCode: "not_approved_yet", reopen: false, reopenCode: "not_approved_yet", replacesEpisodes: false, reruns: [] };
  const base = { kind: p.kind, gate, document: null, inUse: false };
  if (!w.runId) return { ...base, state: "not_yet", edit: none };
  const stages = core.store.listStageRuns(w.runId);
  const at = stages.find((s) => s.stage_key === gate);
  if (at?.state === "WAITING_HUMAN") return { ...base, state: "waiting", edit: { ...none, inPlaceCode: "at_gate", reopenCode: "at_gate" } };
  if (at?.state !== "SUCCEEDED") return { ...base, state: "not_yet", edit: none };
  let approved: unknown = null;
  try { approved = readStageDocument(core, w.runId, gate, STUDIO_GATES[gate]!); } catch { approved = null; }
  const inUse = inUseOf(w, p.kind);
  const document = inUse ?? approved;
  const inPlaceCode = inPlaceBlock(core, w, p.kind);
  const reopenCode = reopenBlock(core, db, w, p.kind);
  return {
    ...base, state: "approved", document,
    inUse: inUse !== null && approved !== null && JSON.stringify(inUse) !== JSON.stringify(approved),
    edit: {
      inPlace: inPlaceCode === null, inPlaceCode, reopen: reopenCode === null, reopenCode,
      replacesEpisodes: !EPISODE_KINDS.has(p.kind) && listEpisodes(db, w.p.id).length > 0,
      reruns: p.kind === "youtube_kit" ? [] : stagesFrom(stages, gate),
    },
  };
}

/** A plan step opened again: a run parked at a later gate with nothing working is cancelled, then resumed from `gate`. */
function reopenPlanFrom(core: StudioEngineCore, db: StudioDb, productionId: string, runId: string, gate: string): { runId: string } {
  const run = core.store.getRun(runId)!;
  if (!isTerminal("run", run.state)) core.planner.cancel(runId);
  return resumePlanRunFrom(core, db, productionId, gate);
}

export interface StepEditResult {
  /** `saved`: the version in use was replaced; `reopened`: the step waits again with the edit on show. */
  mode: "saved" | "reopened";
  /** The run that waits at the gate (reopened). */
  runId?: string;
  warnings: StudioProblem[];
}

/**
 * A person's edit of an approved step. `reopen` false replaces the version in use (refused where nothing would read
 * it); true starts the run again from the step's gate with the edit as the version on show, to approve again.
 * The document is checked against the step's schema here and by the gate's checks when it is approved again.
 */
export function editStepDocument(core: StudioEngineCore, db: StudioDb, p: {
  productionId: string; episodeId?: string | null; kind: StepDocKind; document: unknown; reopen: boolean; userId: string;
}): StepEditResult {
  const view = stepDocument(core, db, p);
  if (view.state === "waiting") throw new StudioRunError("conflict", "bước này đang chờ duyệt: sửa ở đó", { code: "at_gate" });
  if (view.state !== "approved") throw new StudioRunError("conflict", "bước này chưa được duyệt", { code: "not_approved_yet" });
  const check = SCHEMAS[p.kind].safeParse(p.document);
  if (!check.success) {
    throw new StudioRunError("rejected", "tài liệu không hợp lệ", {
      problems: check.error.issues.map((x) => ({ code: "schema", message: `${x.path.join(".")}: ${x.message}` })),
    });
  }
  const doc: unknown = check.data;
  const w = where(db, p.productionId, p.episodeId, p.kind);
  const now = core.clock.now();
  const gateKey = (runId: string): ChatScopeKey => ({ productionId: p.productionId, episodeId: p.episodeId ?? null, runId, stageKey: view.gate, scope: "gate" });
  const record = (before: unknown, after: unknown) => {
    try {
      recordHumanEdit(db, { userId: p.userId, productionId: p.productionId, episodeId: p.episodeId ?? null, kind: EDIT_KINDS[p.kind], before, after });
    } catch { /* the dataset never blocks an edit */ }
  };

  if (!p.reopen) {
    if (!view.edit.inPlace) {
      throw new StudioRunError("conflict", `${LABELS[p.kind]} đã duyệt chỉ đổi được bằng cách mở lại bước này`, { code: view.edit.inPlaceCode ?? "only_reopen" });
    }
    let warnings: StudioProblem[] = [];
    if (p.kind === "rnd" || p.kind === "branding" || p.kind === "style") {
      const r = editProductionDocument(core, db, p.productionId, p.kind, doc, p.userId);
      warnings = r.warnings;
    } else if (p.kind === "trend_report") {
      saveTrendReport(db, p.productionId, doc);
    } else {
      const v = validateYoutubeKit(doc, { episode: (parsed(w.ep!.plan) ?? {}) as Parameters<typeof validateYoutubeKit>[1]["episode"] });
      if (!v.ok) throw new StudioRunError("rejected", "YouTube kit không hợp lệ", { problems: v.problems, warnings: v.warnings });
      warnings = v.warnings;
      db.run("UPDATE episodes SET youtube = ?, updated_at = ? WHERE id = ?", [JSON.stringify(doc), now, w.ep!.id]);
    }
    record(view.document, doc);
    insertSystemTurn(db, gateKey(w.runId!), `Đã sửa tay ${LABELS[p.kind]} (bản đang dùng).`, now);
    return { mode: "saved", warnings };
  }

  if (!view.edit.reopen) throw new StudioRunError("conflict", `chưa mở lại được bước ${LABELS[p.kind]}`, { code: view.edit.reopenCode ?? "running" });
  const { runId } = EPISODE_KINDS.has(p.kind)
    ? rerunEpisodeFrom(core, db, w.ep!.id, view.gate as "approve-survey" | "approve-edit-plan")
    : reopenPlanFrom(core, db, p.productionId, w.runId!, view.gate);
  const key = gateKey(runId);
  const proposal = p.kind === "survey" ? ({ ops: [], survey: doc as StudioSurvey } satisfies SurveyProposal) : doc;
  insertUserTurn(db, key, { text: "Sửa tay", createdBy: p.userId, proposal, ask: false }, now);
  insertSystemTurn(db, key, `Đã mở lại bước ${LABELS[p.kind]} với bản bạn sửa; bấm Duyệt để chạy tiếp.`, now);
  return { mode: "reopened", runId, warnings: [] };
}
