/** Which Claude model each Studio skill uses (stages and chat replies). */
import type { StudioChatSkill, StudioSkill } from "@harness/contracts";

/** Per-skill model env keys. `STUDIO_CLAUDE_MODEL` overrides all. */
const SKILL_MODEL_ENVS: Record<StudioSkill | StudioChatSkill, string> = {
  "studio-intake": "STUDIO_CLAUDE_MODEL_INTAKE",
  "studio-timeline": "STUDIO_CLAUDE_MODEL_TIMELINE",
  "studio-plan-episodes": "STUDIO_CLAUDE_MODEL_PLAN_EPISODES",
  "studio-youtube-kit": "STUDIO_CLAUDE_MODEL_YOUTUBE_KIT",
  "studio-trend-report": "STUDIO_CLAUDE_MODEL_TREND_REPORT",
  "studio-rnd": "STUDIO_CLAUDE_MODEL_RND",
  "studio-branding": "STUDIO_CLAUDE_MODEL_BRANDING",
  "studio-source-survey": "STUDIO_CLAUDE_MODEL_SOURCE_SURVEY",
  "studio-edit-plan": "STUDIO_CLAUDE_MODEL_EDIT_PLAN",
};
/** The R&D decides the whole series once per production: Opus, like the episode plan. */
const SKILL_DEFAULTS: Record<StudioSkill | StudioChatSkill, string> = {
  "studio-intake": "claude-sonnet-5-5",
  "studio-timeline": "claude-sonnet-5-5",
  "studio-plan-episodes": "claude-opus-5-5",
  "studio-youtube-kit": "claude-sonnet-5-5",
  "studio-trend-report": "claude-sonnet-5-5",
  "studio-rnd": "claude-opus-5-5",
  "studio-branding": "claude-sonnet-5-5",
  // looks at dozens of contact sheets: Sonnet; the edit plan decides the rhythm of the cut: Opus
  "studio-source-survey": "claude-sonnet-5-5",
  "studio-edit-plan": "claude-opus-5-5",
};

/** The model of a skill (a chat reply uses the model of the skill it talks about). */
export function modelFor(skill: StudioSkill | StudioChatSkill, override?: string): string {
  if (override) return override;
  const envKey = SKILL_MODEL_ENVS[skill];
  const envVal = envKey ? process.env[envKey] : undefined;
  return envVal ?? SKILL_DEFAULTS[skill];
}
