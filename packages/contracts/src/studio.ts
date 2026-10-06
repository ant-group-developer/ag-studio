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
    /** `own`: a channel of the team (its current results); `reference`: one to learn from. Older documents: reference. */
    role: z.enum(["own", "reference"]).default("reference"),
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

/**
 * How an episode is edited (spec local-chat §3.3): `whole` plays whole videos back to back (timeline v3), `cut`
 * cuts it shot by shot from longer footage, with narration (`ag-studio-episode-cut`, timeline v4).
 */
export const EDIT_STYLES = ["whole", "cut"] as const;
export type StudioEditStyle = (typeof EDIT_STYLES)[number];
/** `tts`: lines read over the picture; `original`: the footage's own speech; `none`: picture, music, ambience. */
export const NARRATION_VOICES = ["none", "tts", "original"] as const;
export type NarrationVoice = (typeof NARRATION_VOICES)[number];

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
  /**
   * Absent = `whole` (plans written before shot-cut episodes existed). For `cut`, `items` are the videos the
   * episode is cut from, in story order, not clips.
   */
  edit_style: z.enum(EDIT_STYLES).optional(),
  /** Shot-cut episodes only; absent = `tts`. */
  narration: z.enum(NARRATION_VOICES).optional(),
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
// Research first (ag-studio-series-plan@2.0.0): seed -> research -> R&D (approved) -> branding (approved) -> brief
// ---------------------------------------------------------------------------

export const CHANNEL_ROLES = ["own", "reference"] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];
export const ChannelRefSchema = z.object({ url: z.string().min(1).max(300), role: z.enum(CHANNEL_ROLES) }).strict();
export type ChannelRef = z.infer<typeof ChannelRefSchema>;

/** What the person filled in beyond the minimum. The R&D keeps a value given here; empty / null = the AI proposes. */
export const StudioHintsSchema = z.object({
  description: shortText(4000),
  goal: shortText(1000),
  audience: shortText(1000),
  tone: shortText(500),
  notes: shortText(4000),
  episode_target_seconds: z.number().min(10).max(3600).nullable(),
  max_episodes: z.number().int().min(1).max(MAX_EPISODES_LIMIT).nullable(),
}).strict();
export type StudioHints = z.infer<typeof StudioHintsSchema>;

/** `seed.json` (`intake` of plan v2): footage, channels, keywords and hints as the person gave them, frozen for the run. */
export const StudioSeedSchema = z.object({
  schema_version: studioVersion("seed"),
  production_id: z.string().min(1),
  run_id: z.string().min(1),
  /** Background stages act as this user towards ag-go. */
  owner_user_id: z.string().min(1),
  title: z.string().min(1).max(200),
  folder_ids: z.array(z.string().min(1)).min(1).max(50),
  /** The team's own channels and the reference channels, each as typed (link, @handle or channel id). */
  channels: z.array(ChannelRefSchema).max(MAX_RESEARCH_CHANNELS),
  keywords: z.array(z.string().min(1).max(100)).max(MAX_RESEARCH_KEYWORDS),
  aspect: z.enum(STUDIO_ASPECTS),
  canvas: StudioCanvasSchema,
  fps: z.union([z.literal(25), z.literal(30)]),
  language: z.string().min(2).max(10),
  music: StudioMusicSchema.nullable(),
  hints: StudioHintsSchema,
}).strict();
export type StudioSeed = z.infer<typeof StudioSeedSchema>;

const textList = (maxItems: number, maxChars: number) => z.array(z.string().min(1).max(maxChars)).max(maxItems);
/** YouTube only links letters, digits and `_` after `#` (`#Phở_Hà_Nội`, not `#Phở-Hà-Nội` or `#(Tập1)`). */
export const HashtagSchema = z.string().regex(/^#[\p{L}\p{N}_]+$/u, "one #word of letters, digits or _");

/**
 * `rnd.json` (`rnd`, Claude; edited and approved at `approve-rnd`, then the production's R&D): the market, the
 * team's own channels, what the footage supports, and the direction of the series. `direction` fills what the
 * person left out (description, goal, audience, tone, episode length and count); every later AI step reads it.
 */
export const StudioRndSchema = z.object({
  schema_version: studioVersion("rnd"),
  /** The R&D in a few sentences: what to make, for whom, and why it can work. */
  summary: z.string().min(1).max(3000),
  market: z.object({
    opportunities: textList(10, 500),
    gaps: textList(10, 500),
    risks: textList(10, 500),
    competitors: z.array(z.object({
      channel: z.string().min(1).max(200),
      strengths: z.string().max(500),
      weaknesses: z.string().max(500),
    }).strict()).max(10),
  }).strict(),
  /** The team's own channels as research saw them; null when the person named none. */
  own_channels: z.object({
    assessment: z.string().min(1).max(2000),
    strengths: textList(8, 300),
    weaknesses: textList(8, 300),
    recommendations: textList(8, 500),
  }).strict().nullable(),
  /** What the footage folders hold and the directions they can carry. */
  footage_fit: z.object({
    summary: z.string().min(1).max(2000),
    strong_themes: textList(10, 200),
    gaps: textList(10, 300),
  }).strict(),
  direction: z.object({
    description: z.string().min(1).max(4000),
    goal: z.string().min(1).max(1000),
    audience: z.string().min(1).max(1000),
    tone: z.string().min(1).max(500),
    positioning: z.string().min(1).max(1000),
    content_pillars: z.array(z.object({ name: z.string().min(1).max(100), description: z.string().min(1).max(500) }).strict()).min(1).max(8),
    episode_target_seconds: z.number().min(10).max(3600),
    max_episodes: z.number().int().min(1).max(MAX_EPISODES_LIMIT),
    posting_schedule: z.string().max(500),
    /** SEO keywords for titles, descriptions and tags (not the research keywords). */
    keywords: z.array(z.string().min(1).max(100)).max(20),
    episode_ideas: z.array(z.object({ title: z.string().min(1).max(150), angle: z.string().min(1).max(500) }).strict()).max(15),
    notes: z.string().max(4000),
  }).strict(),
}).strict();
export type StudioRnd = z.infer<typeof StudioRndSchema>;

/** Where the words of a thumbnail sit (Studio draws them; the AI image of a later phase leaves room there). */
export const THUMBNAIL_TEXT_POSITIONS = ["top", "center", "bottom", "left", "right"] as const;
export type ThumbnailTextPosition = (typeof THUMBNAIL_TEXT_POSITIONS)[number];
export const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "#RRGGBB");

/**
 * `branding.json` (`branding`, Claude from the approved R&D; edited and approved at `approve-branding`, then the
 * production's branding): how the series sounds and looks, written so an AI step can follow it — title formulas,
 * voice, description opening and CTA, series hashtags, thumbnail style (words, case, colours, where the text sits).
 */
export const StudioBrandingSchema = z.object({
  schema_version: studioVersion("branding"),
  series_name: z.string().min(1).max(100),
  tagline: z.string().max(200),
  positioning: z.string().min(1).max(1000),
  voice: z.object({
    personality: textList(6, 100),
    do: textList(10, 300),
    dont: textList(10, 300),
    signature_phrases: textList(10, 200),
    banned_words: textList(20, 100),
  }).strict(),
  titles: z.object({
    formulas: z.array(z.string().min(1).max(200)).min(1).max(8),
    rules: textList(10, 300),
    examples: textList(10, 100),
    max_chars: z.number().int().min(20).max(100),
  }).strict(),
  description: z.object({
    opening: z.string().max(500),
    cta: z.string().max(300),
    hashtags: z.array(HashtagSchema).max(5),
  }).strict(),
  thumbnail: z.object({
    concept: z.string().min(1).max(500),
    text_rules: textList(8, 300),
    max_words: z.number().int().min(1).max(8),
    text_case: z.enum(["upper", "sentence"]),
    palette: z.object({ text: HexColorSchema, outline: HexColorSchema, accent: HexColorSchema }).strict(),
    position: z.enum(THUMBNAIL_TEXT_POSITIONS),
    emotion: z.string().max(200),
    do: textList(8, 300),
    dont: textList(8, 300),
  }).strict(),
  on_screen_text: z.object({
    style: z.string().max(500),
    max_chars: z.number().int().min(10).max(64),
    rules: textList(8, 300),
  }).strict(),
  music_mood: textList(5, 100),
}).strict();
export type StudioBranding = z.infer<typeof StudioBrandingSchema>;

// ---------------------------------------------------------------------------
// Thumbnails (ag-studio-episode@1.2.0): clean frames of the final video, words drawn by Studio
// ---------------------------------------------------------------------------

/** YouTube's thumbnail size for each frame (and the 2 MB limit it puts on the file). */
export const THUMBNAIL_SIZES = { "16:9": { width: 1280, height: 720 }, "9:16": { width: 720, height: 1280 } } as const;
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
export const THUMBNAIL_TEXT_SIZES = ["s", "m", "l"] as const;
export type ThumbnailTextSize = (typeof THUMBNAIL_TEXT_SIZES)[number];

/** How the words of a thumbnail look: position, size preset, colours, an optional band behind them, case. */
export const ThumbnailStyleSchema = z.object({
  position: z.enum(THUMBNAIL_TEXT_POSITIONS),
  size: z.enum(THUMBNAIL_TEXT_SIZES),
  text_color: HexColorSchema,
  outline_color: HexColorSchema,
  /** A band in this colour behind the words; null = outlined words only. */
  box_color: HexColorSchema.nullable(),
  uppercase: z.boolean(),
}).strict();
export type ThumbnailStyle = z.infer<typeof ThumbnailStyleSchema>;

/** At most this many words on a thumbnail, in at most this many lines. */
export const THUMBNAIL_TEXT_MAX = 60;

/**
 * `thumbnails.json` (`thumbnails` of an episode run): the clean candidate frames cut from the final video (files in
 * the `thumbnails/` directory output) and the 3 suggestions of the YouTube kit drawn on them.
 */
export const StudioThumbnailsSchema = z.object({
  schema_version: studioVersion("thumbnails"),
  production_id: z.string().min(1),
  episode_id: z.string().min(1),
  run_id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frames: z.array(z.object({
    file: z.string().min(1),
    t_s: z.number().min(0),
    clip_id: z.string().nullable(),
    asset_id: z.string().nullable(),
  }).strict()),
  suggestions: z.array(z.object({
    file: z.string().min(1),
    /** The clean frame it was drawn on. */
    frame: z.string().min(1),
    t_s: z.number().min(0),
    asset_id: z.string().nullable(),
    text: z.string().min(1).max(THUMBNAIL_TEXT_MAX),
    style: ThumbnailStyleSchema,
  }).strict()),
}).strict();
export type StudioThumbnails = z.infer<typeof StudioThumbnailsSchema>;

// ---------------------------------------------------------------------------
// Episode run
// ---------------------------------------------------------------------------

/** What ag-go's AI description says about a whole video, kept as a hint (ag-go has nothing per shot). */
export const AssetHintsSchema = z.object({
  subjects: z.array(z.string()),
  places: z.array(z.string()),
  mood: z.string(),
  setting: z.string(),
  time_of_day: z.string(),
  people_count: z.string(),
  shot_variety: z.array(z.string()),
  /** ag-go's speech hint (from the silence ratio, not a transcript); `null` when unknown. */
  has_speech: z.boolean().nullable(),
}).strict();
export type AssetHints = z.infer<typeof AssetHintsSchema>;

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
  /** Shot-cut episodes: ag-go's AI description of each video, a hint for scene selection (absent before phase 5). */
  asset_hints: z.record(z.string(), AssetHintsSchema).optional(),
}).strict();
export type StudioEpisode = z.infer<typeof StudioEpisodeSchema>;

/** One text on the picture (T). `start` is seconds from the start of the episode. Same in v3 and v4. */
export const TimelineTextSchema = z.object({
  text_id: z.string().regex(/^T\d{3}$/),
  kind: z.enum(TEXT_KINDS),
  text: z.string().min(1).max(64),
  start: z.number().min(0),
  duration: z.number().min(0.5).max(20),
  position: z.enum(TEXT_POSITIONS_V2),
}).strict();

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
  texts: z.array(TimelineTextSchema),
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

/**
 * `timeline.json` (Timeline v4, spec local-chat §3.3, ADR-0001 item 151): v3 plus what the shot-cut edit style
 * needs. Both edit styles use it: `whole` (each clip plays its whole video, as v3) and `cut` (clips are shots
 * trimmed out of longer footage, with narration).
 *
 * - A clip plays `[in, out)` seconds of its asset (`out: null` = to the end of the asset), so its length is
 *   `(out ?? assets[asset_id].duration_s) - in`. Clips play back to back in array order.
 * - `transition_out` never moves a clip: a dissolve takes a tail of `seconds` from the SAME asset after `out`
 *   (ADR item 118). Without that tail, or when the next clip is shorter than `2 × seconds`, the composition
 *   downgrades it to a cut and says so in `transitions.downgraded`. The last clip always cuts.
 * - `line_id` marks the clip a narration line STARTS on; a line is anchored by at most one clip and plays from
 *   `clip.start + narration.lead_seconds` for `audio.duration_s`. `audio.words[]` are seconds from the start
 *   of the line. The WAV lives in the Studio voice store under `audio.key` (sha256 of what was read).
 *
 * Contract for the exports (phases 4 and 6): they read the `harness.composition/v1` that
 * `timelineToComposition` (core) builds from this, where `segments[].in/out` are seconds in the SOURCE file,
 * `transition_out` has `tail_available` resolved, `narration[].wav` is the input `stage:voice/<line_id>.wav`
 * with `start/end` on the episode axis, and `captions.cues` / `text_events` carry absolute times.
 *
 * A v3 document reads as v4 through `upgradeTimelineV3` (`in: 0`, `out: null`, cuts, no narration, no captions);
 * an episode whose timeline was v3 keeps being stored as v3 (`downgradeTimelineV4`), never rewritten.
 */
export const TIMELINE_TRANSITIONS = ["cut", "dissolve", "dip_black"] as const;
export type TimelineTransitionKind = (typeof TIMELINE_TRANSITIONS)[number];
export const CAPTION_MODES = ["none", "burn-in", "karaoke"] as const;
export type CaptionMode = (typeof CAPTION_MODES)[number];
/** Narration starts this long after the start of the clip it is anchored on (harness `fitEdl` lead-in). */
export const DEFAULT_NARRATION_LEAD_SECONDS = 0.3;

export const TimelineClipV4Schema = z.object({
  clip_id: z.string().regex(/^C\d{3,4}$/),
  asset_id: z.string().min(1),
  section_title: z.string().min(1).max(100).nullable(),
  /** Seconds into the asset. */
  in: z.number().min(0),
  /** Seconds into the asset; `null` = to the end of the asset. */
  out: z.number().positive().nullable(),
  /** The shot of the scene selection this clip was cut from (`s<source>-<shot>`). */
  shot_id: z.string().regex(/^s\d{3}-\d{3}$/).nullable(),
  /** The narration line that starts on this clip. */
  line_id: z.string().regex(/^L\d{3}$/).nullable(),
  transition_out: z.object({
    kind: z.enum(TIMELINE_TRANSITIONS),
    seconds: z.number().min(0).max(1),
  }).strict(),
}).strict().refine((c) => c.out === null || c.out > c.in, { message: "out must be after in", path: ["out"] });

export const NarrationWordSchema = z.object({
  word: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
}).strict();

export const TimelineNarrationLineSchema = z.object({
  line_id: z.string().regex(/^L\d{3}$/),
  text: z.string().min(1).max(1200),
  /** `null` until the line has been read (TTS). */
  audio: z.object({
    key: z.string().regex(/^[0-9a-f]{64}$/),
    duration_s: z.number().positive(),
    words: z.array(NarrationWordSchema),
  }).strict().nullable(),
}).strict();

export const TimelineV4Schema = z.object({
  schema_version: studioVersion("timeline", 4),
  production_id: z.string().min(1),
  episode_id: z.string().min(1),
  canvas: StudioCanvasSchema,
  fps: z.union([z.literal(25), z.literal(30)]),
  language: z.string().min(2).max(10),
  edit_style: z.enum(EDIT_STYLES),
  /** V1, in play order. */
  clips: z.array(TimelineClipV4Schema),
  texts: z.array(TimelineTextSchema),
  narration: z.object({
    /** `tts`: read lines over the picture (source sound off); `original`: the footage's own speech; `none`. */
    voice: z.enum(NARRATION_VOICES),
    lead_seconds: z.number().min(0).max(2),
    lines: z.array(TimelineNarrationLineSchema),
  }).strict(),
  /** Burnt-in subtitles from the narration's words. */
  captions: z.object({ mode: z.enum(CAPTION_MODES) }).strict(),
  music: StudioMusicSchema.nullable(),
  source_audio: z.object({ muted: z.boolean() }).strict(),
  assets: z.record(z.string(), EpisodeAssetSchema),
  alternates: z.array(reasonedAsset),
}).strict();
export type TimelineV4 = z.infer<typeof TimelineV4Schema>;
export type TimelineClipV4 = TimelineV4["clips"][number];
export type TimelineNarrationLine = TimelineV4["narration"]["lines"][number];

/** A v4 timeline asked to be written as v3 holds something v3 cannot (trim, transition, narration, captions). */
export class TimelineVersionError extends Error {
  readonly code = "not_v3" as const;
  constructor(message: string) {
    super(message);
    this.name = "TimelineVersionError";
  }
}

export function upgradeTimelineV3(t: TimelineV3): TimelineV4 {
  return {
    schema_version: "studio.timeline/v4",
    production_id: t.production_id,
    episode_id: t.episode_id,
    canvas: t.canvas,
    fps: t.fps,
    language: t.language,
    edit_style: "whole",
    clips: t.clips.map((c) => ({
      clip_id: c.clip_id, asset_id: c.asset_id, section_title: c.section_title,
      in: 0, out: null, shot_id: null, line_id: null, transition_out: { kind: "cut", seconds: 0 },
    })),
    texts: t.texts,
    narration: { voice: "none", lead_seconds: DEFAULT_NARRATION_LEAD_SECONDS, lines: [] },
    captions: { mode: "none" },
    music: t.music,
    source_audio: t.source_audio,
    assets: t.assets,
    alternates: t.alternates,
  };
}

/** The v3 document a v4 timeline stands for; throws `TimelineVersionError` when that would lose anything. */
export function downgradeTimelineV4(t: TimelineV4): TimelineV3 {
  const lost: string[] = [];
  if (t.edit_style !== "whole") lost.push("edit_style");
  for (const c of t.clips) {
    if (c.in !== 0 || c.out !== null) lost.push(`${c.clip_id} trim`);
    if (c.shot_id !== null) lost.push(`${c.clip_id} shot_id`);
    if (c.line_id !== null) lost.push(`${c.clip_id} line_id`);
    if (c.transition_out.kind !== "cut" || c.transition_out.seconds !== 0) lost.push(`${c.clip_id} transition`);
  }
  const n = t.narration;
  if (n.voice !== "none" || n.lines.length > 0 || n.lead_seconds !== DEFAULT_NARRATION_LEAD_SECONDS) lost.push("narration");
  if (t.captions.mode !== "none") lost.push("captions");
  if (lost.length > 0) throw new TimelineVersionError(`a v3 timeline cannot hold: ${lost.join(", ")}`);
  return {
    schema_version: "studio.timeline/v3",
    production_id: t.production_id,
    episode_id: t.episode_id,
    canvas: t.canvas,
    fps: t.fps,
    language: t.language,
    clips: t.clips.map((c) => ({ clip_id: c.clip_id, asset_id: c.asset_id, section_title: c.section_title })),
    texts: t.texts,
    music: t.music,
    source_audio: t.source_audio,
    assets: t.assets,
    alternates: t.alternates,
  };
}

/** 3 or 4 by `schema_version`, `null` for anything else (no parsing). */
export function timelineVersion(raw: unknown): 3 | 4 | null {
  const v = raw && typeof raw === "object" ? (raw as { schema_version?: unknown }).schema_version : undefined;
  return v === "studio.timeline/v3" ? 3 : v === "studio.timeline/v4" ? 4 : null;
}

/** A timeline as stored: either version, kept as it is (edits return the version they were given). */
export const StoredTimelineSchema = z.union([TimelineV4Schema, TimelineV3Schema]);
export type StoredTimeline = TimelineV3 | TimelineV4;

/**
 * `timeline` in the version `version` (the version an episode's timeline was first stored in): a v3 episode keeps
 * v3 — a v4 document is written down to v3 when nothing is lost, else `TimelineVersionError`.
 */
export function timelineAsVersion(t: StoredTimeline, version: 3 | 4): StoredTimeline {
  if (version === 4) return t.schema_version === "studio.timeline/v4" ? t : upgradeTimelineV3(t);
  return t.schema_version === "studio.timeline/v3" ? t : downgradeTimelineV4(t);
}

/** Either version, read as v4. */
export const AnyTimelineSchema = z.union([TimelineV4Schema, TimelineV3Schema.transform(upgradeTimelineV3)]);

/** Parses a stored timeline of either version and returns it as v4 (throws the zod error otherwise). */
export function readTimeline(raw: unknown): TimelineV4 {
  return AnyTimelineSchema.parse(raw);
}

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
  hashtags: z.array(HashtagSchema).max(15),
  /** Three thumbnails: a frame of this video (taken from its middle in the final render) with this text on it. */
  thumbnails: z.array(z.object({ asset_id: z.string().min(1), text: z.string().min(1).max(40) }).strict()).length(3),
  playlist: z.string().max(150),
}).strict();
export type YoutubeKit = z.infer<typeof YoutubeKitSchema>;

/**
 * A kit stored by an earlier run or edit, read under today's rules: hashtags written before the letters, digits
 * and `_` rule are cleaned to it, so an episode produced earlier still opens, renders and exports. `null` when the
 * kit is still invalid.
 */
export function readStoredYoutubeKit(raw: unknown): YoutubeKit | null {
  const ok = YoutubeKitSchema.safeParse(raw);
  if (ok.success) return ok.data;
  const kit = raw as { hashtags?: unknown } | null;
  if (kit && Array.isArray(kit.hashtags)) {
    const hashtags = [...new Set(kit.hashtags.map((h) => `#${String(h).replace(/[^\p{L}\p{N}_]/gu, "")}`))]
      .filter((h) => h.length > 1)
      .slice(0, 15);
    const cleaned = YoutubeKitSchema.safeParse({ ...kit, hashtags });
    if (cleaned.success) return cleaned.data;
  }
  return null;
}

/** {@link readStoredYoutubeKit}, where a kit that still cannot be read is an error (with the schema's details). */
export function parseStoredYoutubeKit(raw: unknown): YoutubeKit {
  return readStoredYoutubeKit(raw) ?? YoutubeKitSchema.parse(raw);
}

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
  "studio-rnd": StudioRndSchema,
  "studio-branding": StudioBrandingSchema,
  "studio-plan-episodes": SeriesPlanSchema,
  "studio-youtube-kit": YoutubeKitSchema,
} as const;
export type StudioSkill = keyof typeof STUDIO_SKILL_OUTPUTS;

// ---------------------------------------------------------------------------
// Team skills ("quy chuẩn & skill" of a team): markdown the team writes, put into the team's Claude prompts
// ---------------------------------------------------------------------------

/** The AI steps a team skill can be limited to; a skill limited to none applies to every step. */
export const TEAM_SKILL_STEPS = ["intake", "trend-report", "rnd", "branding", "plan-episodes", "timeline", "youtube-kit"] as const;
export type TeamSkillStep = (typeof TEAM_SKILL_STEPS)[number];

/** Lengths in characters. `enabledTotal` bounds every enabled skill of a team together (prompt cost). */
export const TEAM_SKILL_LIMITS = { name: 100, purpose: 500, content: 20_000, enabledTotal: 60_000 } as const;

/** The step a Studio skill is, for picking the team skills that apply to it. */
export const STUDIO_SKILL_STEP: Record<StudioSkill, TeamSkillStep> = {
  "studio-trend-report": "trend-report",
  "studio-rnd": "rnd",
  "studio-branding": "branding",
  "studio-plan-episodes": "plan-episodes",
  "studio-youtube-kit": "youtube-kit",
};

/** A team skill as it goes into a prompt. */
export interface TeamGuide {
  name: string;
  purpose: string;
  /** Empty = every step. */
  applies_to: TeamSkillStep[];
  content: string;
}

/** The guides of `guides` that apply to `step`, in their order. */
export function teamGuidesForStep(guides: readonly TeamGuide[], step: TeamSkillStep): TeamGuide[] {
  return guides.filter((g) => g.applies_to.length === 0 || g.applies_to.includes(step));
}

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
    // Every property is required: a key optional on disk (absent in documents written before it existed, such as an
    // episode's `edit_style`) is one Claude always answers.
    if (out.properties) out.required = Object.keys(out.properties as object);
  }
  return out;
}

/**
 * JSON Schema handed to `claude -p --json-schema`. Structured outputs reject numeric/string/array
 * constraints, so they are stripped here and enforced after the fact by the Zod schema plus the stage's
 * checker (one repair round, see `StudioAgentExecutor`).
 */
export function claudeOutputJsonSchema(skill: StudioSkill): Record<string, unknown> {
  return claudeJsonSchemaFor(STUDIO_SKILL_OUTPUTS[skill]);
}

/** `claudeOutputJsonSchema` for any Zod schema (chat replies wrap a stage's schema). It must hold no `z.record`. */
export function claudeJsonSchemaFor(schema: z.ZodTypeAny): Record<string, unknown> {
  const raw = zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" });
  return stripForClaude(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Render machine (spec local-chat §3.4): which kind of farm machine renders a final cut, said with the job
// `requirements` ag-farm already has. Studio stores the type, never raw requirements, so no caller can send the farm
// a key it would refuse. Pinning one named machine would need a new ag-farm field: not done here.
// ---------------------------------------------------------------------------
export const RENDER_MACHINES = ["any", "nvenc", "gpu"] as const;
export const RenderMachineSchema = z.enum(RENDER_MACHINES);
export type RenderMachine = z.infer<typeof RenderMachineSchema>;

/** ag-farm `requirements` of a machine type: `{}` matches any node. A fresh object every call. */
export function renderRequirements(machine: RenderMachine): { nvenc?: boolean; gpu?: boolean } {
  switch (machine) {
    case "nvenc": return { nvenc: true };
    case "gpu": return { gpu: true };
    default: return {};
  }
}
