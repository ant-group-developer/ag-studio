import { z } from "zod";
import { STYLE_MAX_REFERENCES, StyleMeasuredSchema, studioVersion, YoutubeVideoIdSchema } from "./studio.js";

/**
 * Documents of the style step of the series plan (`ag-studio-series-plan@3.2.0`, ADR-0001 item 175): the reference
 * videos picked from the research, then what watching them found. The videos themselves are never an artifact: they
 * are downloaded, measured and deleted inside `watch-references`.
 */

/** `references.json` (`style_refs`, `pick-references`): the reference videos to learn from, and why each. */
export const StyleRefsSchema = z.object({
  schema_version: studioVersion("style-refs"),
  production_id: z.string().min(1),
  /** The length the picks were chosen near (the series' episode target, else the reference channels' median). */
  target_seconds: z.number().min(0).nullable(),
  /** Why nothing was picked (no reference channel, research skipped, nothing of a fitting length). */
  skipped_reason: z.string().nullable(),
  picks: z.array(z.object({
    video_id: YoutubeVideoIdSchema,
    url: z.string(),
    channel_id: z.string(),
    channel_title: z.string(),
    title: z.string(),
    duration_s: z.number().min(0),
    views: z.number().int().min(0),
    views_per_day: z.number().min(0),
    published_at: z.string(),
    reason: z.string(),
  }).strict()).max(STYLE_MAX_REFERENCES),
}).strict();
export type StyleRefs = z.infer<typeof StyleRefsSchema>;

export const STYLE_FRAME_KINDS = ["scene", "interval", "opening"] as const;

/**
 * `style-watch/watch.json` (`style_watch`, `watch-references`): per reference video (`R1`…), the scene changes found,
 * the frames kept (≤480 px, in the workspace and on the bucket under `key`) and contact sheets of them; `measured`
 * over all the videos watched. A video that could not be downloaded or read has its `error` and no frames.
 */
export const StyleWatchSchema = z.object({
  schema_version: studioVersion("style-watch"),
  production_id: z.string().min(1),
  skipped_reason: z.string().nullable(),
  measured: StyleMeasuredSchema.nullable(),
  videos: z.array(z.object({
    label: z.string().regex(/^R\d$/),
    video_id: YoutubeVideoIdSchema,
    title: z.string(),
    duration_s: z.number().min(0).nullable(),
    error: z.string().nullable(),
    measured: StyleMeasuredSchema.nullable(),
    /** Scene changes, in seconds from the start of the video. */
    cuts: z.array(z.number().min(0)),
    frames: z.array(z.object({
      t: z.number().min(0),
      /** Relative to the `style-watch` directory. */
      file: z.string(),
      kind: z.enum(STYLE_FRAME_KINDS),
      /** Bucket key of the frame, for the web. */
      key: z.string(),
    }).strict()),
    sheets: z.array(z.object({ file: z.string(), frames: z.array(z.number().min(0)) }).strict()),
  }).strict()),
}).strict();
export type StyleWatch = z.infer<typeof StyleWatchSchema>;
