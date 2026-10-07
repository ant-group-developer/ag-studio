/**
 * How each document of a step reads in the result column (spec local-chat §2.3): the fields shown, in order, and
 * how each one reads. The same spec drives the highlight of what changed since the previous version.
 */
export type FieldKind = "text" | "list" | "chips" | "number" | "seconds" | "pairs" | "palette" | "episodes";

export interface FieldSpec {
  /** Dotted path in the document. */
  path: string;
  /** i18n key of the label (under `chat.fields`). */
  label: string;
  kind: FieldKind;
  /** `pairs`: the keys of each item's title and text. */
  pair?: [string, string];
}

export type DocKind = "trend_report" | "rnd" | "branding" | "series_plan" | "youtube_kit" | "intake";

export const DOC_SPECS: Record<DocKind, FieldSpec[]> = {
  intake: [
    { path: "title", label: "title", kind: "text" },
    { path: "folder_ids", label: "footage", kind: "chips" },
    { path: "channels", label: "channels", kind: "pairs", pair: ["url", "role"] },
    { path: "keywords", label: "keywords", kind: "chips" },
    { path: "aspect", label: "aspect", kind: "text" },
    { path: "language", label: "language", kind: "text" },
    { path: "hints.episode_target_seconds", label: "episodeLength", kind: "seconds" },
    { path: "hints.max_episodes", label: "episodeCount", kind: "number" },
    { path: "hints.tone", label: "tone", kind: "text" },
    { path: "hints.audience", label: "audience", kind: "text" },
    { path: "hints.notes", label: "notes", kind: "text" },
  ],
  trend_report: [
    { path: "summary", label: "summary", kind: "text" },
    { path: "working_angles", label: "workingAngles", kind: "list" },
    { path: "title_patterns", label: "titlePatterns", kind: "list" },
    { path: "hook_patterns", label: "hookPatterns", kind: "list" },
    { path: "thumbnail_patterns", label: "thumbnailPatterns", kind: "list" },
    { path: "recommended_duration_s", label: "recommendedDuration", kind: "seconds" },
    { path: "posting_schedule", label: "postingSchedule", kind: "text" },
    { path: "recommendations", label: "recommendations", kind: "list" },
  ],
  rnd: [
    { path: "summary", label: "summary", kind: "text" },
    { path: "direction.goal", label: "goal", kind: "text" },
    { path: "direction.audience", label: "audience", kind: "text" },
    { path: "direction.tone", label: "tone", kind: "text" },
    { path: "direction.max_episodes", label: "episodeCount", kind: "number" },
    { path: "direction.episode_target_seconds", label: "episodeLength", kind: "seconds" },
    { path: "direction.description", label: "seriesIdea", kind: "text" },
    { path: "direction.positioning", label: "positioning", kind: "text" },
    { path: "direction.content_pillars", label: "pillars", kind: "pairs", pair: ["name", "description"] },
    { path: "direction.episode_ideas", label: "episodeIdeas", kind: "pairs", pair: ["title", "angle"] },
    { path: "direction.keywords", label: "keywords", kind: "chips" },
    { path: "market.opportunities", label: "opportunities", kind: "list" },
    { path: "market.risks", label: "risks", kind: "list" },
    { path: "footage_fit.summary", label: "footageFit", kind: "text" },
    { path: "own_channels.assessment", label: "ownChannels", kind: "text" },
    { path: "direction.notes", label: "notes", kind: "text" },
  ],
  branding: [
    { path: "series_name", label: "seriesName", kind: "text" },
    { path: "tagline", label: "tagline", kind: "text" },
    { path: "positioning", label: "positioning", kind: "text" },
    { path: "voice.personality", label: "voice", kind: "chips" },
    { path: "titles.formulas", label: "titleFormulas", kind: "list" },
    { path: "titles.examples", label: "titleExamples", kind: "list" },
    { path: "thumbnail.concept", label: "thumbnail", kind: "text" },
    { path: "thumbnail.palette", label: "palette", kind: "palette" },
    { path: "on_screen_text.style", label: "onScreenText", kind: "text" },
    { path: "description.opening", label: "descriptionOpening", kind: "text" },
    { path: "description.hashtags", label: "hashtags", kind: "chips" },
    { path: "music_mood", label: "music", kind: "chips" },
  ],
  series_plan: [
    { path: "series_title", label: "seriesName", kind: "text" },
    { path: "rationale", label: "rationale", kind: "text" },
    { path: "episodes", label: "episodes", kind: "episodes" },
  ],
  youtube_kit: [
    { path: "titles", label: "titles", kind: "list" },
    { path: "description", label: "description", kind: "text" },
    { path: "tags", label: "tags", kind: "chips" },
    { path: "hashtags", label: "hashtags", kind: "chips" },
    { path: "thumbnails", label: "thumbnailIdeas", kind: "pairs", pair: ["text", "asset_id"] },
    { path: "playlist", label: "playlist", kind: "text" },
  ],
};

/** The document a step shows, by its stage key (gates and the Claude stages before them). */
export function docKindOf(stageKey: string): DocKind | null {
  switch (stageKey) {
    case "intake": return "intake";
    case "trend-report": case "approve-trend-report": return "trend_report";
    case "rnd": case "approve-rnd": return "rnd";
    case "branding": case "approve-branding": return "branding";
    case "plan-episodes": case "approve-plan": return "series_plan";
    case "youtube-kit": case "approve-youtube-kit": return "youtube_kit";
    default: return null;
  }
}

export function valueAt(doc: unknown, path: string): unknown {
  let node = doc;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}
