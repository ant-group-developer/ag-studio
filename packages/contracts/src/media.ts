import { z } from "zod";
import { mediaInfoSchema, schemaVersion } from "./common.js";

export const watchFrameSchema = z.object({
  t: z.number().min(0),
  file: z.string().min(1),
  kind: z.enum(["scene", "interval"]),
}).strict();

export const watchTranscriptSchema = z.object({
  segments: z.array(z.object({ start: z.number().min(0), end: z.number().min(0), text: z.string() }).strict()),
}).strict();

export const watchVideoSchema = z.object({
  label: z.string().min(1),
  source_path: z.string().min(1),
  duration_seconds: z.number().min(0),
  media: mediaInfoSchema.nullable(),
  frames: z.array(watchFrameSchema),
  sheets: z.array(z.string()),
  transcript: watchTranscriptSchema.nullable(),
  transcript_error: z.string().optional(),
}).strict();

/** `watch/index.json` a "watch" stage produces: per-video frame/sheet/transcript summary for an agent to review. */
export const WatchIndexSchema = z.object({
  schema_version: schemaVersion("watch"),
  mode: z.enum(["samples", "source", "episode"]),
  videos: z.array(watchVideoSchema),
}).strict();

export type WatchFrame = z.infer<typeof watchFrameSchema>;
export type WatchTranscript = z.infer<typeof watchTranscriptSchema>;
export type WatchVideo = z.infer<typeof watchVideoSchema>;
export type WatchIndex = z.infer<typeof WatchIndexSchema>;
