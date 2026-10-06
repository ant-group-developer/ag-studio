import { z } from "zod";
import { AssetHintsSchema, NARRATION_VOICES, studioVersion } from "./studio.js";

/**
 * Documents of the shot-cut episode workflow (`ag-studio-episode-cut@1.0.0`, spec local-chat §3.3, ADR-0001 items
 * 151–160). An episode is cut from the videos its plan picked: Studio fetches their 720p proxies, finds the shots,
 * listens for speech, shows Claude contact sheets (scene selection), Claude plans the edit, the farm reads the
 * narration, and the fitted plan becomes a timeline v4.
 */

/** `s<source index>-<shot index>`, e.g. `s014-003` (harness `shotId`). */
export const ShotIdSchema = z.string().regex(/^s\d{3}-\d{3}$/);
export const SourceIdSchema = z.string().regex(/^src_[0-9A-HJKMNP-TV-Z]{26}$/);

/**
 * `sources.json` (`cut_sources`, written by `episode-intake` of a shot-cut episode): the videos the episode is cut
 * from, in plan order. `index` is the source number in every shot id; `source_id` is the stable id the media
 * pipeline and the composition use for the asset.
 */
export const CutSourcesSchema = z.object({
  schema_version: studioVersion("cut-sources"),
  production_id: z.string().min(1),
  episode_id: z.string().min(1),
  language: z.string().min(2).max(10),
  narration: z.enum(NARRATION_VOICES),
  sources: z.array(z.object({
    index: z.number().int().min(0).max(999),
    asset_id: z.string().min(1),
    source_id: SourceIdSchema,
    title: z.string(),
    duration_s: z.number().positive(),
    has_speech: z.boolean().nullable(),
    hints: AssetHintsSchema.nullable(),
  }).strict()).min(1).max(60),
}).strict();
export type CutSources = z.infer<typeof CutSourcesSchema>;

/**
 * `proxies/proxies.json` inside the `proxy_set` directory (`fetch-proxies`): one 720p file per source, named
 * `<source_id>.mp4`, as ag-go served it (`resolve purpose=preview`: the scan worker's proxy for a person allowed to see
 * originals, else a preview variant, possibly watermarked). Only for looking at the footage; the final render
 * downloads the originals itself.
 */
export const CutProxySetSchema = z.object({
  schema_version: studioVersion("cut-proxies"),
  proxies: z.array(z.object({
    index: z.number().int().min(0),
    asset_id: z.string().min(1),
    source_id: SourceIdSchema,
    file: z.string().regex(/^src_[0-9A-HJKMNP-TV-Z]{26}\.mp4$/),
    source_kind: z.enum(["original", "proxy", "preview"]),
    watermarked: z.boolean(),
    bytes: z.number().int().min(0),
  }).strict()),
}).strict();
export type CutProxySet = z.infer<typeof CutProxySetSchema>;

/** Contact sheets: shots per sheet (4 × 4) and the width of every frame. */
export const CUT_SHEET_COLS = 4;
export const CUT_SHEET_SHOTS = 16;
export const CUT_FRAME_WIDTH = 480;

/**
 * `watch/watch.json` inside the `watch` directory (`watch-source`): one frame per shot (the middle of the shot,
 * `frames/<shot_id>.jpg`) and, per source, contact sheets of those frames in shot order, `CUT_SHEET_COLS` across,
 * left to right then top to bottom (`sheets/<sheet>.jpg`). `shots[k]` of a sheet is its k-th tile. The survey
 * agent reads the sheets and opens single frames; the web shows each shot's frame from the Studio bucket
 * (`bucket_key`).
 */
export const CutWatchSchema = z.object({
  schema_version: studioVersion("cut-watch"),
  frame_width: z.number().int().positive(),
  sheet_cols: z.number().int().positive(),
  sources: z.array(z.object({
    source_id: SourceIdSchema,
    index: z.number().int().min(0),
    shots: z.array(z.object({
      shot_id: ShotIdSchema,
      t: z.number().min(0),
      frame: z.string().regex(/^frames\/s\d{3}-\d{3}\.jpg$/),
      bucket_key: z.string().min(1),
    }).strict()),
    sheets: z.array(z.object({
      file: z.string().regex(/^sheets\/s\d{3}-\d{2}\.jpg$/),
      shots: z.array(ShotIdSchema).min(1).max(CUT_SHEET_SHOTS),
    }).strict()),
  }).strict()),
}).strict();
export type CutWatch = z.infer<typeof CutWatchSchema>;
