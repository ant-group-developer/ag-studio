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
