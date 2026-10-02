/**
 * The brief every step after the R&D reads (`brief.json`, `studio.brief/v2`): the production's own fields, with the
 * approved R&D's direction where there is one. The R&D was written within what the person typed (its numbers are
 * held to the hints) and then approved or edited by a person, so it is the latest decision and wins; a production
 * planned before the R&D step has no R&D and keeps what was typed.
 */
import {
  HarnessError, MAX_RESEARCH_KEYWORDS, StudioBriefSchema,
  type StudioBrief, type StudioHints, type StudioRnd,
} from "@harness/contracts";

export type BriefBase = Omit<StudioBrief, "schema_version" | "description" | "goal" | "audience" | "tone" | "notes" | "episode_target_seconds" | "max_episodes">;

export function effectiveBrief(base: BriefBase, hints: StudioHints, rnd: StudioRnd | null): StudioBrief {
  const d = rnd?.direction ?? null;
  const target = d?.episode_target_seconds ?? hints.episode_target_seconds;
  const max = d?.max_episodes ?? hints.max_episodes;
  if (target === null || max === null) {
    throw new HarnessError("CONFIG_INVALID", "production chưa có R&D được duyệt và chưa đặt thời lượng tập / số tập tối đa", {
      production_id: base.production_id,
    });
  }
  const seen = new Set<string>();
  const keywords = [...base.keywords, ...(d?.keywords ?? [])].filter((k) => {
    const key = k.trim().toLocaleLowerCase("vi");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_RESEARCH_KEYWORDS);
  return StudioBriefSchema.parse({
    schema_version: "studio.brief/v2",
    ...base,
    description: d?.description.trim() || hints.description.trim() || base.title,
    goal: d?.goal ?? hints.goal,
    audience: d?.audience ?? hints.audience,
    tone: d?.tone ?? hints.tone,
    notes: d?.notes ?? hints.notes,
    episode_target_seconds: target,
    max_episodes: max,
    keywords,
  });
}
