/**
 * A shot-cut episode as the API shows and steers it (plan phase 5, G): its scene selection shot by shot (with the
 * frame of each shot in the Studio bucket), and running it again from one of its two own gates.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTerminal } from "@harness/core";
import { CutWatchSchema, StudioSurveySchema, type StudioSurvey } from "@harness/contracts";
import type { StudioEngineCore } from "./core.js";
import { currentProposal } from "./chat-db.js";
import type { SurveyProposal } from "./chat-context.js";
import { EPISODE_CUT_WORKFLOW, readStageDocument, resumeEpisodeRunFrom, stageArtifactPath, StudioRunError } from "./run-control.js";
import { getEpisode, type EpisodeRecord, type StudioDb } from "./studio-db.js";

/** The gates a shot-cut episode can be run again from ("Chạy lại từ chọn cảnh…", "… từ kế hoạch dựng…"). */
export const EPISODE_RERUN_GATES = ["approve-survey", "approve-edit-plan"] as const;
export type EpisodeRerunGate = (typeof EPISODE_RERUN_GATES)[number];

const SURVEY_STAGE = "source-survey";
const SURVEY_GATE = "approve-survey";
const WATCH_STAGE = "watch-source";
/** Stage states of a run that is not doing anything. */
const IDLE: readonly string[] = ["SUCCEEDED", "PENDING", "WAITING_HUMAN", "FAILED", "CANCELLED"];

function cutRun(core: StudioEngineCore, ep: EpisodeRecord) {
  const run = ep.run_id ? core.store.getRun(ep.run_id) : undefined;
  if (!run || `${run.workflow_release.id}@${run.workflow_release.version}` !== EPISODE_CUT_WORKFLOW) {
    throw new StudioRunError("invalid", "tập này không cắt theo shot", { code: "not_cut" });
  }
  return run;
}

export interface EpisodeShot {
  source_id: string; shot_id: string; in: number; out: number; score: number; tags: string[]; usable: boolean; note: string;
  speech: StudioSurvey["shots"][number]["speech"];
  /** Studio bucket key of the shot's middle frame (null before the frames are made). */
  frame_key: string | null;
  /** Differs from Claude's selection (usable, score or note): the person or the chat changed it. */
  changed: boolean;
}

export interface EpisodeShots {
  /** `waiting`: at the gate (the version on show, chat edits included); `approved`: as approved; `pending`: not there yet. */
  state: "pending" | "waiting" | "approved";
  /** The chat turn of the version on show while waiting (null = Claude's own), as the approve call wants it. */
  turnId: string | null;
  shots: EpisodeShot[];
}

/** The scene selection of a shot-cut episode now: at its gate, as approved, or not yet made. */
export function episodeShots(core: StudioEngineCore, db: StudioDb, episodeId: string): EpisodeShots {
  const ep = getEpisode(db, episodeId);
  if (!ep) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  const run = cutRun(core, ep);
  const stages = core.store.listStageRuns(run.run_id);
  const gate = stages.find((s) => s.stage_key === SURVEY_GATE);
  const survey = stages.find((s) => s.stage_key === SURVEY_STAGE);
  if (!gate || !survey || survey.state !== "SUCCEEDED") return { state: "pending", turnId: null, shots: [] };
  const draft = StudioSurveySchema.parse(readStageDocument(core, run.run_id, SURVEY_STAGE, "survey.json"));

  let state: EpisodeShots["state"];
  let shown: StudioSurvey;
  let turnId: string | null = null;
  if (gate.state === "SUCCEEDED") {
    state = "approved";
    shown = StudioSurveySchema.parse(readStageDocument(core, run.run_id, SURVEY_GATE, "survey.json"));
  } else if (gate.state === "WAITING_HUMAN" && !isTerminal("run", run.state)) {
    state = "waiting";
    const proposal = currentProposal(db, { productionId: ep.production_id, episodeId: ep.id, runId: run.run_id, stageKey: SURVEY_GATE, scope: "gate" });
    shown = proposal ? (proposal.proposal as SurveyProposal).survey : draft;
    turnId = proposal?.id ?? null;
  } else {
    return { state: "pending", turnId: null, shots: [] };
  }

  const frames = new Map<string, string>();
  const watchDir = stageArtifactPath(core, run.run_id, WATCH_STAGE, "watch");
  if (watchDir && existsSync(join(watchDir, "watch.json"))) {
    const watch = CutWatchSchema.parse(JSON.parse(readFileSync(join(watchDir, "watch.json"), "utf8")));
    for (const s of watch.sources) for (const x of s.shots) frames.set(x.shot_id, x.bucket_key);
  }
  const before = new Map(draft.shots.map((r) => [r.shot_id, r]));
  return {
    state, turnId,
    shots: shown.shots.map((r) => {
      const b = before.get(r.shot_id);
      return {
        source_id: r.source_id, shot_id: r.shot_id, in: r.in, out: r.out, score: r.score, tags: r.tags, usable: r.usable, note: r.note, speech: r.speech,
        frame_key: frames.get(r.shot_id) ?? null,
        changed: !b || b.usable !== r.usable || b.score !== r.score || b.note !== r.note,
      };
    }),
  };
}

/**
 * Runs a shot-cut episode again from its scene selection or its edit plan gate: a new run reusing every stage
 * before the gate (the proxies, shots and frames are not made again), waiting at that gate with Claude's document.
 * Only when the run has ended, or is waiting at a later gate (that run is cancelled first); never while a stage
 * is working, and never from a gate the run has not passed.
 */
export function rerunEpisodeFrom(core: StudioEngineCore, db: StudioDb, episodeId: string, gate: EpisodeRerunGate): { runId: string; reused: string[] } {
  if (!(EPISODE_RERUN_GATES as readonly string[]).includes(gate)) {
    throw new StudioRunError("invalid", `không chạy lại được từ ${gate}`, { code: "bad_stage", allowed: EPISODE_RERUN_GATES });
  }
  const ep = getEpisode(db, episodeId);
  if (!ep) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  const run = cutRun(core, ep);
  const stages = core.store.listStageRuns(run.run_id);
  const at = stages.find((s) => s.stage_key === gate);
  if (at?.state !== "SUCCEEDED") {
    throw new StudioRunError("conflict", "tập chưa qua bước này", { code: "gate_not_passed", stage: gate, state: at?.state ?? null });
  }
  if (!isTerminal("run", run.state)) {
    // waiting at a later gate, or on a failed stage to be retried: nothing is working, the run can go
    const busy = stages.find((s) => !IDLE.includes(s.state));
    if (busy) {
      throw new StudioRunError("conflict", "tập đang được sản xuất; chờ tới bước duyệt sau rồi chạy lại", { code: "episode_running", stage: busy?.stage_key ?? null });
    }
    core.planner.cancel(run.run_id);
  }
  return resumeEpisodeRunFrom(core, db, ep.id, gate);
}
