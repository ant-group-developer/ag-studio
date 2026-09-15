import { z } from "zod";
import { schemaVersion, timestampSchema } from "./common.js";
import { idSchema } from "./ids.js";
import { HypothesisSchema } from "./distribution.js";
import { channelSeoSchema } from "./config.js";

/** One append-only snapshot of a published video's stats, collected from YouTube Studio (or imported from
 * the legacy `channel-metrics.jsonl`); never updated -- `learnChannelStandard` (later task) folds the whole
 * history for a channel into one `ChannelLearned` row. */
export const VideoMetricsSchema = z.object({
  schema_version: schemaVersion("video-metrics"),
  metric_id: idSchema("video_metrics"),
  publication_job_id: idSchema("publication_job"),
  channel_id: z.string().min(1),
  video_id: z.string().min(1),
  collected_at: timestampSchema,
  age_hours: z.number().min(0),
  source: z.enum(["studio", "manual"]),
  views: z.number().int().min(0),
  impressions: z.number().int().min(0).nullable(),
  ctr_pct: z.number().min(0).max(100).nullable(),
  avg_view_sec: z.number().min(0).nullable(),
  retention30_pct: z.number().min(0).max(100).nullable(),
}).strict();

/** Labels combined as `${number|plain}+${question|statement}+${long|short}` to name a title pattern. */
export const TITLE_PATTERN_LABELS = ["number", "plain", "question", "statement", "long", "short"] as const;

/** Aggregate outcome of one group of hypotheses sharing a value (an angle, a title pattern, an overlay-line
 * count): how many supported vs refuted the metric, and the resulting lift over the channel median. */
export const groupStatSchema = z.object({
  value: z.string(),
  supported: z.number().int().min(0),
  refuted: z.number().int().min(0),
  lift: z.number(),
}).strict();

const learnedStandardSchema = z.object({
  angle: z.string().optional(),
  title_pattern: z.string().optional(),
  overlay_lines: z.enum(["0", "1-2", "3"]).optional(),
}).strict();

export const ChannelLearnedSchema = z.object({
  schema_version: schemaVersion("channel-learned"),
  channel_id: z.string().min(1),
  updated_at: timestampSchema,
  sample_size: z.number().int().min(0),
  /** The channel's most common metric, i.e. the one most of its hypotheses target. */
  metric: z.enum(["ctr", "views_72h", "avg_view_pct"]).nullable(),
  medians: z.object({
    views_72h: z.number().nullable(),
    ctr_pct: z.number().nullable(),
    avg_view_pct: z.number().nullable(),
  }).strict(),
  winners: z.object({
    angles: z.array(groupStatSchema),
    title_patterns: z.array(groupStatSchema),
    overlay: z.array(groupStatSchema),
  }).strict(),
  standard: learnedStandardSchema.extend({ note: z.string().default("") }).strict(),
  history: z.array(z.object({ at: timestampSchema, standard: learnedStandardSchema }).strict()).max(20).default([]),
}).strict();

export const ChannelBriefSchema = z.object({
  schema_version: schemaVersion("channel-brief"),
  generated_at: timestampSchema,
  channel: z.object({
    channel_id: z.string().min(1),
    display_name: z.string().min(1),
    seo: channelSeoSchema,
    publication: z.object({ timezone: z.string().min(1), publish_times: z.array(z.string()) }).strict(),
  }).strict(),
  learned: ChannelLearnedSchema.nullable(),
  hypotheses: z.array(z.object({
    hypothesis_id: idSchema("hypothesis"),
    episode_no: z.number().int().min(1),
    chosen: z.object({
      title: z.string().min(1),
      angle: z.string().default(""),
      overlay_text: z.array(z.string()).max(3).default([]),
    }).strict(),
    expected: HypothesisSchema.shape.expected,
    status: z.enum(["open", "supported", "refuted", "void"]),
    metric_value: z.number().optional(),
  }).strict()).max(10),
  recent_metrics: z.array(z.object({
    episode_no: z.number().int().min(1),
    title: z.string().min(1),
    views: z.number().int().min(0),
    impressions: z.number().int().min(0).nullable(),
    ctr_pct: z.number().min(0).max(100).nullable(),
    avg_view_sec: z.number().min(0).nullable(),
    age_hours: z.number().min(0),
  }).strict()).max(10),
  open_requests: z.array(z.object({
    request_id: idSchema("content_request"),
    topic: z.string().min(1),
    status: z.enum(["open", "claimed"]),
  }).strict()),
  item: z.object({
    item_id: idSchema("library_item"),
    title_hint: z.string(),
    summary: z.string(),
    duration_seconds: z.number().min(0).nullable(),
  }).strict().nullable(),
}).strict();

export const TopicProposalSchema = z.object({
  schema_version: schemaVersion("topic-proposal"),
  topics: z.array(z.object({
    topic: z.string().min(8),
    angle: z.string().default(""),
    why: z.string().min(1),
    style_id: idSchema("edit_style").optional(),
    voice: z.enum(["none", "tts", "original"]).optional(),
    target_duration_seconds: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
    source_hint: z.object({ collection: z.string().regex(/^[a-z][a-z0-9-]*$/).optional() }).strict().optional(),
  }).strict()).min(1).max(10),
}).strict();

export const DemandSchema = z.object({
  schema_version: schemaVersion("demand"),
  channel_id: z.string().min(1),
  needed: z.number().int().min(0),
  slots: z.array(timestampSchema),
  covered: z.object({
    jobs: z.number().int().min(0),
    runs: z.number().int().min(0),
    items: z.number().int().min(0),
    requests: z.number().int().min(0),
  }).strict(),
  open_requests: z.number().int().min(0),
  max_open_requests: z.number().int().min(0),
}).strict();

/** `output/requests-receipt.json` written by the built-in `create-requests` stage (spec §4.2): every content
 * request id the `channel-planning` run's topics resolved to, whether newly created this attempt or already
 * existing from an earlier attempt of the same run (idempotent rerun). */
export const RequestsReceiptSchema = z.object({
  schema_version: schemaVersion("requests-receipt"),
  request_ids: z.array(idSchema("content_request")),
}).strict();

export type VideoMetrics = z.infer<typeof VideoMetricsSchema>;
export type ChannelLearned = z.infer<typeof ChannelLearnedSchema>;
export type ChannelBrief = z.infer<typeof ChannelBriefSchema>;
export type TopicProposal = z.infer<typeof TopicProposalSchema>;
export type Demand = z.infer<typeof DemandSchema>;
export type RequestsReceipt = z.infer<typeof RequestsReceiptSchema>;
