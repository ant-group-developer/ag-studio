import { z } from "zod";
import { idSchema } from "./ids.js";
import { checksumSchema, mediaInfoSchema, revisionSchema, schemaVersion, timestampSchema } from "./common.js";

const durationTuple = z.tuple([z.number().min(0), z.number().min(0)]);

export const libraryBriefSchema = z.object({
  request_id: idSchema("content_request").optional(),
  topic: z.string().min(1),
  style_id: idSchema("edit_style"),
  style_revision: revisionSchema,
  target_duration_seconds: durationTuple.optional(),
  voice: z.enum(["none", "tts", "original"]).default("none"),
  language: z.string().min(1).default("vi"),
}).strict();

export const EditStyleSchema = z.object({
  schema_version: schemaVersion("edit-style"),
  style_id: idSchema("edit_style"),
  revision: revisionSchema,
  name: z.string().min(1),
  status: z.enum(["draft", "active", "retired"]),
  learned_from: z.array(z.object({ label: z.string().min(1), url: z.string().optional(), notes: z.string().default("") }).strict()).default([]),
  params: z.object({
    cut_rhythm: z.enum(["fast", "medium", "slow"]),
    shot_seconds: durationTuple,
    transitions: z.array(z.string()).default([]),
    text_overlay: z.object({ style: z.string(), density: z.enum(["none", "low", "medium", "high"]) }).strict(),
    subtitles: z.enum(["burn-in", "karaoke", "none"]),
    music: z.object({ mood: z.string(), ducking: z.boolean() }).strict(),
    opening: z.object({ seconds: z.number().min(0), structure: z.string() }).strict(),
    aspect_ratio: z.string().regex(/^\d+:\d+$/),
    pace_notes: z.string().default(""),
  }).strict(),
  evidence: z.array(z.object({ path: z.string().min(1), note: z.string().default("") }).strict()).default([]),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const ContentRequestSchema = z.object({
  schema_version: schemaVersion("content-request"),
  request_id: idSchema("content_request"),
  requested_by: z.object({ portfolio_id: z.string().min(1), channel_id: z.string().min(1).optional() }).strict(),
  topic: z.string().min(1),
  style_id: idSchema("edit_style").optional(),
  style_revision: revisionSchema.optional(),
  target_duration_seconds: durationTuple.optional(),
  voice: z.enum(["none", "tts", "original"]).default("none"),
  language: z.string().min(1).default("vi"),
  // Pinned to 1: `intake` claims a request once and `fulfillRequest` closes it on the first item, so a
  // request asking for more than one item would wedge at `claimed` forever (no re-claim mechanism yet).
  // Kept as a field (rather than dropped) so the contract still says what one request buys.
  count: z.literal(1).default(1),
  due_at: timestampSchema.optional(),
  status: z.enum(["open", "claimed", "fulfilled", "rejected"]),
  claimed_by_run: z.object({ project_id: z.string().min(1), run_id: idSchema("run") }).strict().optional(),
  item_ids: z.array(idSchema("library_item")).default([]),
  notes: z.string().default(""),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const libraryFileSchema = z.object({
  path: z.string().min(1),
  checksum: checksumSchema,
  size_bytes: z.number().int().min(0),
  mime_type: z.string().min(1),
}).strict();

export const LibraryItemSchema = z.object({
  schema_version: schemaVersion("library-item"),
  item_id: idSchema("library_item"),
  status: z.enum(["pending_review", "approved", "rejected", "withdrawn"]),
  title_hint: z.string().default(""),
  summary: z.string().default(""),
  style: z.object({ style_id: idSchema("edit_style"), revision: revisionSchema }).strict(),
  request_id: idSchema("content_request").optional(),
  duration_seconds: z.number().min(0),
  media: mediaInfoSchema.nullable(),
  files: z.array(libraryFileSchema).min(1),
  lineage: z.object({
    project_id: z.string().min(1),
    run_id: idSchema("run"),
    content_id: idSchema("content_item"),
    source_ids: z.array(idSchema("source_item")),
  }).strict(),
  review: z.object({ by: z.string().optional(), note: z.string().default(""), at: timestampSchema.optional() }).strict().default({ note: "" }),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const LibraryClaimSchema = z.object({
  schema_version: schemaVersion("library-claim"),
  item_id: idSchema("library_item"),
  channel_id: z.string().min(1),
  portfolio_id: z.string().min(1),
  claimed_at: timestampSchema,
  note: z.string().default(""),
}).strict();

export type LibraryBrief = z.infer<typeof libraryBriefSchema>;
export type EditStyle = z.infer<typeof EditStyleSchema>;
export type ContentRequest = z.infer<typeof ContentRequestSchema>;
export type LibraryFile = z.infer<typeof libraryFileSchema>;
export type LibraryItem = z.infer<typeof LibraryItemSchema>;
export type LibraryClaim = z.infer<typeof LibraryClaimSchema>;
