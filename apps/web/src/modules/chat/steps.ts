/**
 * The steps a person sees in the chat UI (mockup: "1 · Nghiên cứu · 2 · R&D …"), from the workflow stage keys.
 * A step groups the stages that serve it: the Claude stage, its gate, the script that saves what was approved.
 */
export type PlanStep = "intake" | "research" | "rnd" | "branding" | "plan" | "episodes";
export type EpisodeStep = "draft" | "footage" | "survey" | "editPlan" | "timeline" | "kit" | "render" | "export";
export type ChatStep = PlanStep | EpisodeStep;

/** The steps of a series once it started (intake comes before, on its own). */
export const PLAN_STEPS: PlanStep[] = ["research", "rnd", "branding", "plan", "episodes"];
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
