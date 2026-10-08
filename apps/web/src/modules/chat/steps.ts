import type { StepDocKind } from "../../api/studio-client";

/**
 * The steps a person sees in the chat UI (mockup: "1 · Nghiên cứu · 2 · R&D …"), from the workflow stage keys.
 * A step groups the stages that serve it: the Claude stage, its gate, the script that saves what was approved.
 */
export type PlanStep = "intake" | "research" | "style" | "rnd" | "branding" | "plan" | "episodes";
export type EpisodeStep = "draft" | "footage" | "survey" | "editPlan" | "timeline" | "kit" | "render" | "export";
export type ChatStep = PlanStep | EpisodeStep;

/** The steps of a series once it started (intake comes before, on its own). */
export const PLAN_STEPS: PlanStep[] = ["research", "rnd", "branding", "plan", "episodes"];
/** Series plan 3.2.0 on: the edit style learned from reference videos, beside the research. */
export const PLAN_STEPS_WITH_STYLE: PlanStep[] = ["research", "style", "rnd", "branding", "plan", "episodes"];

/** The plan run learns an edit style (`ag-studio-series-plan` 3.2.0 or later). */
export function planHasStyle(workflow: string | null | undefined): boolean {
  const [id, version] = (workflow ?? "").split("@");
  if (id !== "ag-studio-series-plan" || !version) return false;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 2);
}

/** The row of steps a series shows, by the release its plan run follows. */
export function planStepsFor(workflow: string | null | undefined): PlanStep[] {
  return planHasStyle(workflow) ? PLAN_STEPS_WITH_STYLE : PLAN_STEPS;
}
export const EPISODE_STEPS: EpisodeStep[] = ["draft", "timeline", "kit", "render", "export"];
/** A shot-cut episode (mockup screens 8–9): footage made ready, scenes chosen, the edit planned, then as before. */
export const CUT_EPISODE_STEPS: EpisodeStep[] = ["footage", "survey", "editPlan", "timeline", "kit", "render"];

const CUT_WORKFLOW_ID = "ag-studio-episode-cut";

/** The episode runs `ag-studio-episode-cut` (its detail's `workflow`, "id@version"). */
export function isCutWorkflow(workflow: string | null | undefined): boolean {
  return !!workflow && workflow.split("@")[0] === CUT_WORKFLOW_ID;
}

/** The row of steps an episode shows, by the workflow its run follows (none yet: the whole-video steps). */
export function episodeStepsFor(workflow: string | null | undefined): EpisodeStep[] {
  return isCutWorkflow(workflow) ? CUT_EPISODE_STEPS : EPISODE_STEPS;
}

const CUT_STAGE_STEP: Record<string, EpisodeStep> = {
  "episode-intake": "footage", "fetch-proxies": "footage", "media-index": "footage", transcribe: "footage", "watch-source": "footage",
  "source-survey": "survey", "approve-survey": "survey",
  "plan-edit": "editPlan", "approve-edit-plan": "editPlan", tts: "editPlan", "fit-timeline": "editPlan",
  "approve-timeline": "timeline", timeline: "timeline",
  "youtube-kit": "kit", "approve-youtube-kit": "kit",
  "freeze-timeline": "render", "render-final": "render", thumbnails: "render", export: "render",
};

const STAGE_STEP: Record<string, ChatStep> = {
  intake: "intake",
  research: "research", catalog: "research", "trend-report": "research", "approve-trend-report": "research",
  "research-api": "research", "research-web": "research",
  "pick-references": "style", "watch-references": "style", "analyze-style": "style", "approve-style": "style", "apply-style": "style",
  rnd: "rnd", "approve-rnd": "rnd", "apply-rnd": "rnd",
  branding: "branding", "approve-branding": "branding", "apply-branding": "branding",
  brief: "plan", "plan-episodes": "plan", "approve-plan": "plan",
  "spawn-episodes": "episodes",
  "episode-intake": "draft", "build-timeline": "draft",
  "approve-timeline": "timeline", timeline: "timeline",
  "youtube-kit": "kit", "approve-youtube-kit": "kit",
  "freeze-timeline": "render", "render-final": "render", thumbnails: "render",
  export: "export",
};

/** The stage a step's "Chạy lại từ bước…" runs from: the one that writes it anew (its Claude stage, or the build). */
const PLAN_RESUME: Partial<Record<ChatStep, string>> = { research: "research", rnd: "rnd", branding: "branding", plan: "plan-episodes" };
/** Plan 3.2.0: the research starts at the API again (the web fills what it leaves), the style at picking references. */
const PLAN_RESUME_V32: Partial<Record<ChatStep, string>> = { ...PLAN_RESUME, research: "research-api", style: "pick-references" };
const EPISODE_RESUME: Partial<Record<ChatStep, string>> = { draft: "build-timeline", kit: "youtube-kit" };
const CUT_RESUME: Partial<Record<ChatStep, string>> = { survey: "source-survey", editPlan: "plan-edit", timeline: "fit-timeline", kit: "youtube-kit" };
export function resumeStageOf(step: ChatStep, o: { episode: boolean; workflow?: string | null | undefined }): string | null {
  if (!o.episode && planHasStyle(o.workflow)) return PLAN_RESUME_V32[step] ?? null;
  const map = !o.episode ? PLAN_RESUME : isCutWorkflow(o.workflow) ? CUT_RESUME : EPISODE_RESUME;
  return map[step] ?? null;
}

/** The step a stage key belongs to (null for a key the UI does not know); a shot-cut episode groups its own way. */
export function stepOf(stageKey: string | null | undefined, workflow?: string | null): ChatStep | null {
  if (!stageKey) return null;
  return (isCutWorkflow(workflow) ? CUT_STAGE_STEP[stageKey] : undefined) ?? STAGE_STEP[stageKey] ?? null;
}

/** i18n key of a step's name. */
export const stepLabelKey = (step: ChatStep) => `chat.steps.${step}` as const;

/** Where a step sits in its row of chips (0-based), -1 when it is not in that row. */
export function stepPosition(step: ChatStep | null, row: readonly ChatStep[]): number {
  return step ? row.indexOf(step) : -1;
}

/**
 * What a step shows when looked at again (plan 2026-10-07 step history): its document, the episode's timeline, or the
 * files it made. Steps not listed have nothing of their own to show (intake, episodes, draft, footage).
 */
export type StepShows = StepDocKind | "timeline" | "outputs";
export const STEP_SHOWS: Partial<Record<ChatStep, StepShows>> = {
  research: "trend_report", style: "style", rnd: "rnd", branding: "branding", plan: "series_plan",
  survey: "survey", editPlan: "edit_plan", timeline: "timeline", kit: "youtube_kit", render: "outputs", export: "outputs",
};
