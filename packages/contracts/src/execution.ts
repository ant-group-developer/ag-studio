import { z } from "zod";
import { idSchema } from "./ids.js";
import { checksumSchema, jsonObjectSchema, schemaVersion, timestampSchema } from "./common.js";
import { profileRefSchema, workflowRefSchema } from "./entities.js";

export const stageInputSchema = z.object({
  artifact_id: idSchema("artifact"),
  checksum: checksumSchema,
  path: z.string().min(1),
  type: z.string().min(1),
  kind: z.enum(["file", "directory"]).default("file"),
}).strict();

export const StageRequestSchema = z.object({
  schema_version: schemaVersion("stage-request"),
  run_id: idSchema("run"),
  stage_run_id: idSchema("stage_run"),
  attempt_id: idSchema("attempt"),
  project_id: z.string().min(1),
  portfolio_id: z.string().min(1),
  stage_key: z.string().min(1),
  workflow: workflowRefSchema,
  profile_snapshot: profileRefSchema,
  inputs: z.array(stageInputSchema),
  workspace_uri: z.string().min(1),
  stage_config: jsonObjectSchema,
  options: jsonObjectSchema.default({}),
  source_items: z.array(z.object({ source_id: idSchema("source_item"), uri: z.string().min(1), checksum: checksumSchema, mime_type: z.string().min(1), duration_seconds: z.number().nullable() }).strict()).default([]),
  resources: z.array(z.string()).default([]),
  limits: z.object({ deadline_at: timestampSchema, max_cost_usd: z.number().min(0), max_attempts: z.number().int().min(1) }).strict(),
  capabilities: z.array(z.string()),
  fencing_token: z.number().int().min(1),
}).strict();

export const stageOutputSchema = z.object({
  path: z.string().min(1),
  type: z.string().min(1),
  checksum: checksumSchema,
  size_bytes: z.number().int().min(0),
  kind: z.enum(["file", "directory"]).default("file"),
}).strict();

export const stageErrorSchema = z.object({
  kind: z.enum(["transient", "result", "contract", "unknown"]),
  message: z.string(),
  details: jsonObjectSchema.default({}),
}).strict();

export const StageResultSchema = z.object({
  schema_version: schemaVersion("stage-result"),
  attempt_id: idSchema("attempt"),
  outcome: z.enum(["succeeded", "failed", "deferred", "unknown"]),
  outputs: z.array(stageOutputSchema),
  checks: z.array(z.object({ check_id: z.string(), verdict: z.enum(["pass", "fail", "skip"]), evidence: jsonObjectSchema.default({}) }).strict()).default([]),
  usage: z.object({ wall_seconds: z.number().min(0), cost_usd: z.number().min(0) }).strict().default({ wall_seconds: 0, cost_usd: 0 }),
  external_operations: z.array(idSchema("external_operation")).default([]),
  errors: z.array(stageErrorSchema).default([]),
}).strict();

export const ArtifactManifestSchema = z.object({
  schema_version: schemaVersion("artifact-manifest"),
  artifact_id: idSchema("artifact"),
  type: z.string().min(1),
  status: z.enum(["provisional", "accepted", "rejected", "stale", "archived"]),
  uri: z.string().min(1),
  checksum: checksumSchema,
  size_bytes: z.number().int().min(0),
  mime_type: z.string().min(1),
  created_by: z.object({ run_id: idSchema("run"), stage_run_id: idSchema("stage_run"), attempt_id: idSchema("attempt") }).strict(),
  lineage: z.object({ input_artifacts: z.array(idSchema("artifact")), source_items: z.array(z.string()) }).strict(),
  reproducibility: z.object({
    workflow_release: z.string(), production_profile: z.string(), channel_config_revision: z.number().int().nullable(),
    executor_version: z.string(), model_parameters_digest: checksumSchema.nullable(),
  }).strict(),
  checks: z.array(idSchema("check_result")),
}).strict();

export type StageRequest = z.infer<typeof StageRequestSchema>;
export type StageResult = z.infer<typeof StageResultSchema>;
export type StageOutput = z.infer<typeof stageOutputSchema>;
export type StageInput = z.infer<typeof stageInputSchema>;
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
