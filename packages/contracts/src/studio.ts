import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * AG Studio production documents: a production is a SERIES of episodes cut from whole analysed videos.
 *
 * Two workflows write these files:
 * - `ag-studio-series-plan@1.0.0` (one run per production): brief -> research -> trend report -> catalog ->
 *   series plan (Claude) -> approved plan -> one episode record + one episode run per planned episode.
 * - `ag-studio-episode@1.0.0` (one run per episode): episode -> timeline -> YouTube kit (Claude) -> final render
 *   with thumbnails -> export (video, thumbnails, `youtube.json`, one zip to upload by hand).
 *
 * Claude only ever sees text: the catalog is what the scan worker wrote about each WHOLE video, never pictures.
 * A clip always plays its whole video (user decision: no trimming), so the unit everywhere is the asset.
 */
export function studioVersion<N extends string, V extends number = 1>(name: N, version: V = 1 as V) {
  return z.literal(`studio.${name}/v${version}` as const);
}

export const STUDIO_ASPECTS = ["16:9", "9:16"] as const;
export type StudioAspect = (typeof STUDIO_ASPECTS)[number];

/** A logical input the render worker asks Studio's `/farm/sign` for, e.g. `library:music/calm.mp3`. */
export const LibraryInputSchema = z.string().regex(/^library:[A-Za-z0-9._\-/]+$/, "expected library:<path>");
/** A key relative to `productions/<id>/` in the Studio bucket, e.g. `exports/<run>/video.mp4`. */
export const ProductionKeySchema = z.string().regex(/^[A-Za-z0-9._\-]+(\/[A-Za-z0-9._\-]+)*$/, "expected a relative key").refine(
  (v) => !v.split("/").some((s) => s === ".." || s === "."), "no . or .. segments",
);

export const StudioCanvasSchema = z.object({
  width: z.number().int().min(160).max(7680),
  height: z.number().int().min(160).max(7680),
}).strict();
export type StudioCanvas = z.infer<typeof StudioCanvasSchema>;

export const StudioMusicSchema = z.object({
  track: LibraryInputSchema,
  gain_db: z.number().min(-40).max(0),
  ducking: z.boolean(),
}).strict();
export type StudioMusic = z.infer<typeof StudioMusicSchema>;

/** Soft target: an episode may differ from `episode_target_seconds` by this fraction (a warning, never a block). */
export const EPISODE_DURATION_TOLERANCE = 0.2;
export const MAX_EPISODES_LIMIT = 30;
export const MAX_RESEARCH_CHANNELS = 20;
export const MAX_RESEARCH_KEYWORDS = 20;

const shortText = (max: number) => z.string().max(max);

// ---------------------------------------------------------------------------
// Series plan run
// ---------------------------------------------------------------------------

/** `brief.json` (`intake` of the plan run; copied into every episode run): the series, frozen for the run. */
export const StudioBriefSchema = z.object({
  schema_version: studioVersion("brief", 2),
  production_id: z.string().min(1),
  run_id: z.string().min(1),
  /** Background stages act as this user towards ag-go. */
  owner_user_id: z.string().min(1),
  title: z.string().min(1).max(200),
  /** What the series is about (the production's description / topic). */
  description: z.string().min(1).max(4000),
  goal: shortText(1000),
  audience: shortText(1000),
  tone: shortText(500),
  notes: shortText(4000),
  folder_ids: z.array(z.string().min(1)).min(1).max(50),
  /** Soft target per episode (±20%). */
  episode_target_seconds: z.number().min(10).max(3600),
  /** Upper bound for Claude's proposal; Claude picks the number of episodes (1..max). */
  max_episodes: z.number().int().min(1).max(MAX_EPISODES_LIMIT),
  aspect: z.enum(STUDIO_ASPECTS),
  canvas: StudioCanvasSchema,
  fps: z.union([z.literal(25), z.literal(30)]),
  language: z.string().min(2).max(10),
  music: StudioMusicSchema.nullable(),
  /** Competitor channels as the user typed them (links, @handles or channel ids). */
  youtube_channels: z.array(z.string().min(1).max(300)).max(MAX_RESEARCH_CHANNELS),
  keywords: z.array(z.string().min(1).max(100)).max(MAX_RESEARCH_KEYWORDS),
}).strict();
export type StudioBrief = z.infer<typeof StudioBriefSchema>;

/** One YouTube video seen during research (YouTube Data API v3, normalised). */
export const ResearchVideoSchema = z.object({
  video_id: z.string().min(1),
  channel_id: z.string().min(1),
  channel_title: z.string(),
  title: z.string(),
  published_at: z.string(),
  duration_s: z.number().min(0),
  views: z.number().int().min(0),
  likes: z.number().int().min(0).nullable(),
  comments: z.number().int().min(0).nullable(),
  tags: z.array(z.string()),
  /** views / days since publishing (at least one day). */
  views_per_day: z.number().min(0),
  /** At least twice the median views/day of its channel (or of its keyword's results). */
  outlier: z.boolean(),
}).strict();
export type ResearchVideo = z.infer<typeof ResearchVideoSchema>;

const termCount = z.object({ term: z.string(), count: z.number().int().min(0) }).strict();

/** `research.json` (`research`): what YouTube says about the competitor channels and the keywords. */
export const StudioResearchSchema = z.object({
  schema_version: studioVersion("research"),
  production_id: z.string().min(1),
  /** null = nothing was fetched (no channels/keywords, or no YouTube API key configured). */
  fetched_at: z.string().nullable(),
  /** YouTube Data API quota units this research spent (search.list = 100, the others 1). */
  quota_units: z.number().int().min(0),
  /** Why nothing was fetched, when nothing was. */
  skipped_reason: z.string().nullable(),
  channels: z.array(z.object({
    input: z.string(),
    channel_id: z.string().nullable(),
    title: z.string().nullable(),
    subscribers: z.number().int().min(0).nullable(),
    error: z.string().nullable(),
    videos: z.array(ResearchVideoSchema),
    stats: z.object({
      median_views_per_day: z.number().min(0),
      uploads_per_week: z.number().min(0),
      shorts_ratio: z.number().min(0).max(1),
      median_duration_s: z.number().min(0),
    }).strict().nullable(),
  }).strict()),
  keywords: z.array(z.object({
    keyword: z.string(),
    error: z.string().nullable(),
    videos: z.array(ResearchVideoSchema),
  }).strict()),
  insights: z.object({
    top_title_terms: z.array(termCount),
    top_tags: z.array(termCount),
    duration_buckets: z.array(z.object({ bucket: z.string(), count: z.number().int().min(0) }).strict()),
    frequent_channels: z.array(z.object({ channel_id: z.string(), title: z.string(), count: z.number().int().min(0) }).strict()),
  }).strict(),
}).strict();
export type StudioResearch = z.infer<typeof StudioResearchSchema>;

/** `trend-report.json` (`trend-report`, Claude; `skipped` without calling Claude when research found nothing). */
export const TrendReportSchema = z.object({
  schema_version: studioVersion("trend-report"),
  skipped: z.boolean(),
  summary: z.string().max(3000),
  working_angles: z.array(z.string().max(300)).max(15),
  title_patterns: z.array(z.string().max(300)).max(15),
  hook_patterns: z.array(z.string().max(300)).max(15),
  thumbnail_patterns: z.array(z.string().max(300)).max(15),
  recommended_duration_s: z.number().min(0).max(7200).nullable(),
  posting_schedule: z.string().max(500),
  recommendations: z.array(z.string().max(500)).max(15),
}).strict();
export type TrendReport = z.infer<typeof TrendReportSchema>;

/** One analysed video as text (ag-go `/footage/catalog` `FootageVideo`, normalised). */
export const CatalogAssetSchema = z.object({
  asset_id: z.string().min(1),
  name: z.string(),
  title_vi: z.string(),
  summary_vi: z.string(),
  duration_s: z.number().min(0),
  orientation: z.string().nullable(),
  genre: z.string(),
  topics: z.array(z.string()),
  subjects: z.array(z.string()),
  places: z.array(z.string()),
  actions: z.array(z.string()),
  keywords_vi: z.array(z.string()),
  tags: z.array(z.string()),
  mood: z.string(),
  setting: z.string(),
  time_of_day: z.string(),
  people_count: z.string(),
  shot_variety: z.array(z.string()),
  has_speech: z.boolean().nullable(),
  quality: z.number().nullable(),
  usable: z.boolean(),
  approved: z.boolean(),
  project_names: z.array(z.string()),
}).strict();
export type CatalogAsset = z.infer<typeof CatalogAssetSchema>;

/** `catalog.json` (`catalog`): exactly the text Claude read. */
export const StudioCatalogSchema = z.object({
  schema_version: studioVersion("catalog", 2),
  production_id: z.string().min(1),
  folder_ids: z.array(z.string()),
  /** Videos ag-go returned before the pre-filter. */
  total_available: z.number().int().min(0),
  truncated: z.boolean(),
  assets: z.array(CatalogAssetSchema),
}).strict();
export type StudioCatalog = z.infer<typeof StudioCatalogSchema>;

const reasonedAsset = z.object({ asset_id: z.string().min(1), reason: z.string().min(1).max(300) }).strict();

export const TEXT_KINDS = ["title", "callout", "lower_third"] as const;
export const TEXT_POSITIONS_V2 = ["top_left", "top_center", "top_right", "center", "bottom_left", "bottom_center", "bottom_right"] as const;
export type TextKind = (typeof TEXT_KINDS)[number];
export type StudioTextPosition = (typeof TEXT_POSITIONS_V2)[number];

/** One planned episode (inside the series plan). Items play in order; each item is one whole video. */
export const PlannedEpisodeSchema = z.object({
  idx: z.number().int().min(1).max(MAX_EPISODES_LIMIT),
  title: z.string().min(1).max(100),
  /** What the first ~5 seconds promise the viewer. */
  hook: z.string().min(1).max(300),
  logline: z.string().min(1).max(600),
  target_seconds: z.number().min(10).max(3600),
  items: z.array(z.object({
    asset_id: z.string().min(1),
    reason: z.string().min(1).max(300),
    /** Starts a new chapter (YouTube chapter + on-screen section title); null = continues the current one. */
    section_title: z.string().min(1).max(100).nullable(),
  }).strict()).min(1).max(60),
  /** Videos the editor offers as swaps for this episode. */
  alternates: z.array(reasonedAsset).max(10),
  /** On-screen texts; `at_item` is the index in `items` whose start the text appears at. */
  texts_suggested: z.array(z.object({
    kind: z.enum(TEXT_KINDS),
    text: z.string().min(1).max(64),
    at_item: z.number().int().min(0),
  }).strict()).max(10),
}).strict();
export type PlannedEpisode = z.infer<typeof PlannedEpisodeSchema>;

/** `series-plan.json` (`plan-episodes`, Claude; edited and approved at `approve-plan`). */
export const SeriesPlanSchema = z.object({
  schema_version: studioVersion("series-plan"),
  series_title: z.string().min(1).max(200),
  /** Why this many episodes and this split (shown to the person approving). */
  rationale: z.string().min(1).max(2000),
  episodes: z.array(PlannedEpisodeSchema).min(1).max(MAX_EPISODES_LIMIT),
}).strict();
export type SeriesPlan = z.infer<typeof SeriesPlanSchema>;

/** `episodes.json` (`spawn-episodes`): the episode records and runs the approved plan became. */
export const SpawnedEpisodesSchema = z.object({
  schema_version: studioVersion("episodes"),
  production_id: z.string().min(1),
  episodes: z.array(z.object({ episode_id: z.string().min(1), idx: z.number().int().min(1), run_id: z.string().min(1) }).strict()).min(1),
}).strict();
export type SpawnedEpisodes = z.infer<typeof SpawnedEpisodesSchema>;

// ---------------------------------------------------------------------------
// Episode run
// ---------------------------------------------------------------------------

/** What an episode run knows about a video it may use (snapshot of the catalog entry). */
export const EpisodeAssetSchema = z.object({
  title: z.string(),
  summary_vi: z.string(),
  duration_s: z.number().positive(),
  orientation: z.string().nullable(),
}).strict();
export type EpisodeAsset = z.infer<typeof EpisodeAssetSchema>;

/** `episode.json` (`episode-intake`): the approved plan of this episode plus every video it refers to. */
export const StudioEpisodeSchema = PlannedEpisodeSchema.extend({
  schema_version: studioVersion("episode"),
  production_id: z.string().min(1),
  episode_id: z.string().min(1),
  /** Every asset of `items` and `alternates`. */
  assets: z.record(z.string(), EpisodeAssetSchema),
}).strict();
export type StudioEpisode = z.infer<typeof StudioEpisodeSchema>;

/**
 * `timeline.json` (Timeline v3): what the editor edits and the renderer plays. Clips play back to back in array
 * order, each for its whole video; texts sit at absolute times. Only facts are stored: positions come from
 * `layoutTimeline` (core), shared by the web editor, the API and the stages.
 */
export const TimelineV3Schema = z.object({
  schema_version: studioVersion("timeline", 3),
  production_id: z.string().min(1),
  episode_id: z.string().min(1),
  canvas: StudioCanvasSchema,
  fps: z.union([z.literal(25), z.literal(30)]),
  language: z.string().min(2).max(10),
  /** V1, in play order. The same video may appear only once per episode. */
  clips: z.array(z.object({
    clip_id: z.string().regex(/^C\d{3,4}$/),
    asset_id: z.string().min(1),
    section_title: z.string().min(1).max(100).nullable(),
  }).strict()),
  /** T. `start` is seconds from the start of the episode. */
  texts: z.array(z.object({
    text_id: z.string().regex(/^T\d{3}$/),
    kind: z.enum(TEXT_KINDS),
    text: z.string().min(1).max(64),
    start: z.number().min(0),
    duration: z.number().min(0.5).max(20),
    position: z.enum(TEXT_POSITIONS_V2),
  }).strict()),
  /** A2. */
  music: StudioMusicSchema.nullable(),
  /** A1: the videos' own sound (on or off; the composition has no gain for it). */
  source_audio: z.object({ muted: z.boolean() }).strict(),
  /** Every video the clips or the alternates refer to. */
  assets: z.record(z.string(), EpisodeAssetSchema),
  /** Editor "Phương án thay thế" for the episode. */
  alternates: z.array(reasonedAsset),
}).strict();
export type TimelineV3 = z.infer<typeof TimelineV3Schema>;
export type TimelineClip = TimelineV3["clips"][number];
export type TimelineText = TimelineV3["texts"][number];

export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;
export const YOUTUBE_TAGS_MAX_CHARS = 500;
/** Room kept in the description for the chapter list the export appends. */
export const YOUTUBE_DESCRIPTION_BODY_MAX = 4000;

/** `youtube-kit.json` (`youtube-kit`, Claude): the words and thumbnail ideas for publishing one episode. */
export const YoutubeKitSchema = z.object({
  schema_version: studioVersion("youtube-kit"),
  titles: z.array(z.string().min(1).max(YOUTUBE_TITLE_MAX)).length(3),
  /** Without chapters: the export appends them from the final timeline. */
  description: z.string().min(1).max(YOUTUBE_DESCRIPTION_BODY_MAX),
  tags: z.array(z.string().min(1).max(100)).max(40),
  /** YouTube only links letters, digits and `_` after `#` (`#Phở_Hà_Nội`, not `#Phở-Hà-Nội` or `#(Tập1)`). */
  hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]+$/u, "one #word of letters, digits or _")).max(15),
  /** Three thumbnails: a frame of this video (taken from its middle in the final render) with this text on it. */
  thumbnails: z.array(z.object({ asset_id: z.string().min(1), text: z.string().min(1).max(40) }).strict()).length(3),
  playlist: z.string().max(150),
}).strict();
export type YoutubeKit = z.infer<typeof YoutubeKitSchema>;

export const YoutubeChapterSchema = z.object({ start_s: z.number().min(0), title: z.string().min(1).max(100) }).strict();
export type YoutubeChapter = z.infer<typeof YoutubeChapterSchema>;

/** `youtube.json` (`export`): what to paste into YouTube Studio for one episode. */
export const StudioYoutubeSchema = z.object({
  schema_version: studioVersion("youtube"),
  production_id: z.string().min(1),
  episode_id: z.string().min(1),
  title: z.string().min(1).max(YOUTUBE_TITLE_MAX),
  alt_titles: z.array(z.string().min(1).max(YOUTUBE_TITLE_MAX)),
  /** Body + chapter list, ready to paste. */
  description: z.string().min(1).max(YOUTUBE_DESCRIPTION_MAX),
  /** Empty when the episode cannot meet YouTube's chapter rules (first at 0:00, at least 3, each at least 10 s). */
  chapters: z.array(YoutubeChapterSchema),
  tags: z.array(z.string()),
  hashtags: z.array(z.string()),
  playlist: z.string(),
  /** Bucket key of the chosen thumbnail. */
  thumbnail_key: z.string().nullable(),
}).strict();
export type StudioYoutube = z.infer<typeof StudioYoutubeSchema>;

/** `export.json` (`export`): where the deliverables of one episode landed in the Studio bucket. */
export const StudioExportSchema = z.object({
  schema_version: studioVersion("export", 2),
  production_id: z.string().min(1),
  episode_id: z.string().min(1),
  run_id: z.string().min(1),
  duration_seconds: z.number().min(0),
  files: z.array(z.object({
    kind: z.enum(["mp4", "thumbnail", "youtube", "timeline", "pack"]),
    key: z.string().min(1),
    size_bytes: z.number().int().min(0),
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict()).min(1),
  watermarked: z.boolean(),
}).strict();
export type StudioExport = z.infer<typeof StudioExportSchema>;

/** Output schema per Studio skill: what Claude must return, and what the stage writes to disk. */
export const STUDIO_SKILL_OUTPUTS = {
  "studio-trend-report": TrendReportSchema,
  "studio-plan-episodes": SeriesPlanSchema,
  "studio-youtube-kit": YoutubeKitSchema,
} as const;
export type StudioSkill = keyof typeof STUDIO_SKILL_OUTPUTS;

const UNSUPPORTED_KEYWORDS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
  "default", "$schema",
]);

function stripForClaude(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripForClaude);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, stripForClaude(s)]));
      continue;
    }
    out[k] = stripForClaude(v);
  }
  if (out.type === "object") {
    // Structured outputs require every object closed; `z.record` has no fixed properties and is not used in
    // any Claude-facing schema, so closing is always right here.
    out.additionalProperties = false;
    if (out.properties && !out.required) out.required = Object.keys(out.properties as object);
  }
  return out;
}

/**
 * JSON Schema handed to `claude -p --json-schema`. Structured outputs reject numeric/string/array
 * constraints, so they are stripped here and enforced after the fact by the Zod schema plus the stage's
 * checker (one repair round, see `StudioAgentExecutor`).
 */
export function claudeOutputJsonSchema(skill: StudioSkill): Record<string, unknown> {
  const raw = zodToJsonSchema(STUDIO_SKILL_OUTPUTS[skill], { $refStrategy: "none", target: "jsonSchema7" });
  return stripForClaude(raw) as Record<string, unknown>;
}
