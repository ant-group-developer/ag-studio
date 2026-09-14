import { z } from "zod";
import { checksumSchema, schemaVersion, timestampSchema } from "./common.js";
import { idSchema } from "./ids.js";

export const HypothesisSchema = z.object({
  schema_version: schemaVersion("hypothesis"),
  hypothesis_id: idSchema("hypothesis"),
  basis: z.array(z.object({
    kind: z.enum(["market", "channel", "manual"]),
    note: z.string().min(1),
    evidence_ref: z.string().optional(),
  }).strict()).min(1),
  chosen: z.object({
    title: z.string().min(1),
    thumbnail_candidate: z.string().min(1),
    overlay_text: z.array(z.string()).max(3).default([]),
    angle: z.string().default(""),
  }).strict(),
  rejected: z.array(z.object({
    title: z.string().min(1),
    angle: z.string().default(""),
    why: z.string().min(1),
  }).strict()).min(1),
  expected: z.object({
    metric: z.enum(["ctr", "views_72h", "avg_view_pct"]),
    target: z.number().positive(),
    horizon_hours: z.number().int().min(24),
  }).strict(),
  status: z.enum(["open", "supported", "refuted", "void"]).default("open"),
  created_at: timestampSchema,
}).strict();

export const packageMetadataSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  tags: z.array(z.string().min(1)).default([]),
  playlists: z.array(z.string()).default([]),
  hashtags: z.array(z.string().regex(/^#\S+$/)).default([]),
  pinned_comment: z.string().default(""),
  category_id: z.string().optional(),
  language: z.string().min(1).default("en"),
}).strict();

export const ChannelPackageDraftSchema = z.object({
  schema_version: schemaVersion("channel-package-draft"),
  metadata: packageMetadataSchema,
  hypothesis: HypothesisSchema,
}).strict();

export const PackageReceiptSchema = z.object({
  schema_version: schemaVersion("package-receipt"),
  package_id: idSchema("channel_package"),
  publication_job_id: idSchema("publication_job"),
  channel_id: z.string().min(1),
  episode_no: z.number().int().min(1),
  episode_dir: z.string().min(1),
  manifest_path: z.string().min(1),
  video_checksum: checksumSchema,
  thumbnail_checksum: checksumSchema,
  manifest_digest: checksumSchema,
}).strict();

export const UploadReceiptSchema = z.object({
  schema_version: schemaVersion("upload-receipt"),
  publication_job_id: idSchema("publication_job"),
  video_id: z.string().min(1),
  operation_id: idSchema("external_operation"),
  state: z.string().min(1),
}).strict();

export const ScheduleReceiptSchema = z.object({
  schema_version: schemaVersion("schedule-receipt"),
  publication_job_id: idSchema("publication_job"),
  video_id: z.string().min(1),
  scheduled_at: timestampSchema,
}).strict();

export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type PackageMetadata = z.infer<typeof packageMetadataSchema>;
export type ChannelPackageDraft = z.infer<typeof ChannelPackageDraftSchema>;
export type PackageReceipt = z.infer<typeof PackageReceiptSchema>;
export type UploadReceipt = z.infer<typeof UploadReceiptSchema>;
export type ScheduleReceipt = z.infer<typeof ScheduleReceiptSchema>;
