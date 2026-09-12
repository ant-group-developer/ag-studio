import { z } from "zod";
import { idSchema } from "./ids.js";
import { checksumSchema, jsonObjectSchema, revisionSchema, schemaVersion, secretRefSchema, semverSchema, timestampSchema } from "./common.js";

// ---- state enums (blueprint §9 + spec B.5) ----
export const RUN_STATES = ["DRAFT", "READY", "RUNNING", "WAITING", "CANCEL_REQUESTED", "CANCELLED", "SUCCEEDED", "FAILED"] as const;
export const STAGE_RUN_STATES = ["PENDING", "READY", "CLAIMED", "RUNNING", "VERIFYING", "WAITING_EXTERNAL", "NEEDS_RECONCILIATION", "WAITING_HUMAN", "CANCEL_REQUESTED", "CANCELLED", "SUCCEEDED", "FAILED"] as const;
export const ATTEMPT_STATES = ["CLAIMED", "RUNNING", "SUCCEEDED", "FAILED", "ABANDONED", "CANCELLED"] as const;
export const ARTIFACT_STATUSES = ["PROVISIONAL", "ACCEPTED", "REJECTED", "STALE", "ARCHIVED"] as const;
export const EXTERNAL_OPERATION_STATUSES = ["INTENT_RECORDED", "DISPATCHED", "NEEDS_RECONCILIATION", "CONFIRMED", "FAILED"] as const;
export const PUBLICATION_STATES = ["DRAFT", "READY", "SCHEDULED", "UPLOADING", "PROCESSING", "PUBLISHED", "NEEDS_RECONCILIATION", "FAILED"] as const;
export const FAILURE_KINDS = ["transient", "result", "contract", "unknown", "abandoned", "deferred"] as const;
export const SEVERITIES = ["debug", "info", "warn", "error"] as const;

export const workflowRefSchema = z.object({ id: z.string().min(1), version: semverSchema, digest: checksumSchema }).strict();
export const profileRefSchema = z.object({ id: z.string().min(1), revision: revisionSchema }).strict();
export const retryPolicySchema = z.object({
  max_attempts: z.number().int().min(1),
  backoff_seconds: z.array(z.number().int().min(0)),
  retry_on: z.array(z.enum(FAILURE_KINDS)),
}).strict();
export const executorRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("script"), script: z.string().min(1) }).strict(),
  z.object({ type: z.literal("agent"), skill: z.string().min(1), brief: z.string().default("") }).strict(),
  z.object({ type: z.literal("gate"), brief: z.string().default("") }).strict(),
]);

// ---- control plane entities ----
export const RunSchema = z.object({
  schema_version: schemaVersion("run"),
  run_id: idSchema("run"),
  project_id: z.string().min(1),
  portfolio_id: z.string().min(1),
  workflow_release: workflowRefSchema,
  profile_snapshot: profileRefSchema,
  source_id: idSchema("source_item").optional(),
  content_id: idSchema("content_item").optional(),
  variant_id: idSchema("content_variant").optional(),
  state: z.enum(RUN_STATES),
  effective_config_snapshot: jsonObjectSchema,
  effective_config_digest: checksumSchema,
  total_cost_usd: z.number().min(0),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const StageRunSchema = z.object({
  schema_version: schemaVersion("stage-run"),
  stage_run_id: idSchema("stage_run"),
  run_id: idSchema("run"),
  stage_key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  executor: executorRefSchema,
  depends_on: z.array(z.string()),
  depends_on_optional: z.array(z.string()).default([]),
  requires_resources: z.array(z.string()).default([]),
  required_capabilities: z.array(z.string()),
  required_checks: z.array(z.string()),
  retry: retryPolicySchema,
  stage_config: jsonObjectSchema,
  state: z.enum(STAGE_RUN_STATES),
  attempt_count: z.number().int().min(0),
  result_failures: z.number().int().min(0),
  ready_at: timestampSchema.optional(),
  not_before: timestampSchema.optional(),
  last_failure_kind: z.enum(FAILURE_KINDS).optional(),
  cache_key: checksumSchema.optional(),
  reused_artifact_ids: z.array(idSchema("artifact")).optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const AttemptSchema = z.object({
  schema_version: schemaVersion("attempt"),
  attempt_id: idSchema("attempt"),
  stage_run_id: idSchema("stage_run"),
  run_id: idSchema("run"),
  lease_owner: z.string().min(1),
  fencing_token: z.number().int().min(1),
  state: z.enum(ATTEMPT_STATES),
  workspace_uri: z.string().optional(),
  started_at: timestampSchema,
  finished_at: timestampSchema.optional(),
  failure_kind: z.enum(FAILURE_KINDS).optional(),
  error_summary: z.string().optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const ArtifactSchema = z.object({
  schema_version: schemaVersion("artifact"),
  artifact_id: idSchema("artifact"),
  run_id: idSchema("run"),
  stage_run_id: idSchema("stage_run"),
  attempt_id: idSchema("attempt"),
  type: z.string().min(1),
  status: z.enum(ARTIFACT_STATUSES),
  uri: z.string().min(1),
  checksum: checksumSchema,
  size_bytes: z.number().int().min(0),
  mime_type: z.string().min(1),
  lineage: z.object({ input_artifacts: z.array(idSchema("artifact")), source_items: z.array(z.string()) }).strict(),
  reproducibility: z.object({
    workflow_release: z.string(),
    production_profile: z.string(),
    channel_config_revision: z.number().int().nullable(),
    executor_version: z.string(),
    model_parameters_digest: checksumSchema.nullable(),
  }).strict(),
  checks: z.array(idSchema("check_result")),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const ExternalOperationSchema = z.object({
  schema_version: schemaVersion("external-operation"),
  operation_id: idSchema("external_operation"),
  run_id: idSchema("run"),
  stage_run_id: idSchema("stage_run"),
  attempt_id: idSchema("attempt"),
  provider: z.string().min(1),
  kind: z.string().min(1),
  target: z.string().min(1),
  idempotency_key: checksumSchema,
  status: z.enum(EXTERNAL_OPERATION_STATUSES),
  provider_ref: z.string().nullable(),
  receipt: jsonObjectSchema.nullable(),
  cost_usd: z.number().min(0),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const CheckResultSchema = z.object({
  schema_version: schemaVersion("check-result"),
  check_result_id: idSchema("check_result"),
  check_id: z.string().min(1),
  checker_version: z.string().min(1),
  attempt_id: idSchema("attempt"),
  artifact_id: idSchema("artifact").nullable(),
  verdict: z.enum(["pass", "fail", "skip"]),
  evidence: jsonObjectSchema,
  created_at: timestampSchema,
}).strict();

export const EventSchema = z.object({
  schema_version: schemaVersion("event"),
  event_id: idSchema("event"),
  occurred_at: timestampSchema,
  run_id: idSchema("run").nullable(),
  stage_run_id: idSchema("stage_run").nullable(),
  attempt_id: idSchema("attempt").nullable(),
  project_id: z.string().nullable(),
  portfolio_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  content_id: z.string().nullable(),
  variant_id: z.string().nullable(),
  workflow_release: z.string().nullable(),
  severity: z.enum(SEVERITIES),
  event_type: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  payload: jsonObjectSchema,
}).strict();

export const LeaseSchema = z.object({
  stage_run_id: idSchema("stage_run"),
  attempt_id: idSchema("attempt"),
  owner: z.string().min(1),
  expires_at: timestampSchema,
  fencing_token: z.number().int().min(1),
  resources: z.array(z.string()).default([]),
}).strict();

// ---- domain entities frozen now, tables added in later sub-projects ----
export const ProjectSchema = z.object({
  schema_version: schemaVersion("project"), project_id: z.string().min(1), template_release: z.string().min(1),
  runtime: z.enum(["claude", "codex"]), data_root: z.string().min(1), created_at: timestampSchema,
}).strict();
export const PortfolioSchema = z.object({
  schema_version: schemaVersion("portfolio"), portfolio_id: z.string().min(1), project_id: z.string().min(1), display_name: z.string(),
}).strict();
export const ChannelSchema = z.object({
  schema_version: schemaVersion("channel"), channel_id: z.string().min(1), portfolio_id: z.string().min(1),
  account_ref: secretRefSchema, expected_channel_id: z.string().min(1), config_revision: revisionSchema,
}).strict();
export const mediaInfoSchema = z.object({
  width: z.number().int().min(1), height: z.number().int().min(1), fps: z.number().positive().nullable(), has_audio: z.boolean(),
}).strict();
export const SourceItemSchema = z.object({
  schema_version: schemaVersion("source-item"), source_id: idSchema("source_item"),
  uri: z.string().min(1), original_uri: z.string().min(1), checksum: checksumSchema, collection: z.string().regex(/^[a-z][a-z0-9-]*$/).default("main"),
  mime_type: z.string().min(1), size_bytes: z.number().int().min(0), media: mediaInfoSchema.nullable(),
  rights_status: z.enum(["unknown", "cleared", "restricted"]), language: z.string().nullable(), duration_seconds: z.number().nullable(), ingested_at: timestampSchema,
}).strict();
export const ContentItemSchema = z.object({
  schema_version: schemaVersion("content-item"), content_id: idSchema("content_item"), source_ids: z.array(idSchema("source_item")),
  revision: revisionSchema, title: z.string(), created_at: timestampSchema,
}).strict();
export const ProductionProfileRefSchema = z.object({
  schema_version: schemaVersion("production-profile-ref"), profile_id: z.enum(["cartoon", "avatar", "footage"]), profile_revision: revisionSchema,
}).strict();
export const ContentVariantSchema = z.object({
  schema_version: schemaVersion("content-variant"), variant_id: idSchema("content_variant"), content_id: idSchema("content_item"),
  profile_id: z.string().min(1), profile_revision: revisionSchema, options: jsonObjectSchema.default({}), options_digest: checksumSchema, created_at: timestampSchema,
}).strict();
export const DistributionPlanSchema = z.object({
  schema_version: schemaVersion("distribution-plan"), plan_id: z.string().min(1), revision: revisionSchema,
  entries: z.array(z.object({ variant_id: idSchema("content_variant"), channel_id: z.string(), publish_slot: timestampSchema.nullable() }).strict()),
}).strict();
export const ChannelPackageSchema = z.object({
  schema_version: schemaVersion("channel-package"), package_id: idSchema("channel_package"), channel_id: z.string().min(1),
  variant_id: idSchema("content_variant"), manifest_digest: checksumSchema, video_artifact_id: idSchema("artifact"),
  thumbnail_artifact_id: idSchema("artifact"), metadata_revision: revisionSchema, channel_config_revision: revisionSchema, created_at: timestampSchema,
}).strict();
export const PublicationJobSchema = z.object({
  schema_version: schemaVersion("publication-job"), publication_job_id: idSchema("publication_job"), package_id: idSchema("channel_package"),
  idempotency_key: checksumSchema, state: z.enum(PUBLICATION_STATES), youtube_video_id: z.string().nullable(), receipt: jsonObjectSchema.nullable(),
  created_at: timestampSchema, updated_at: timestampSchema,
}).strict();
export const WorkflowReleaseSchema = z.object({
  schema_version: schemaVersion("workflow-release"), workflow_id: z.string().min(1), version: semverSchema, digest: checksumSchema, released_at: timestampSchema,
}).strict();
export const IncidentSchema = z.object({
  schema_version: schemaVersion("incident"), incident_id: idSchema("incident"), severity: z.enum(["low", "medium", "high", "critical"]),
  run_id: idSchema("run").nullable(), status: z.enum(["open", "investigating", "resolved"]), summary: z.string(), created_at: timestampSchema,
}).strict();

export type Run = z.infer<typeof RunSchema>;
export type StageRun = z.infer<typeof StageRunSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ExternalOperation = z.infer<typeof ExternalOperationSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type Event = z.infer<typeof EventSchema>;
export type Lease = z.infer<typeof LeaseSchema>;
export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export type ExecutorRef = z.infer<typeof executorRefSchema>;
export type FailureKind = (typeof FAILURE_KINDS)[number];
export type RunState = (typeof RUN_STATES)[number];
export type StageRunState = (typeof STAGE_RUN_STATES)[number];
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];
export type ExternalOperationStatus = (typeof EXTERNAL_OPERATION_STATUSES)[number];
export type SourceItem = z.infer<typeof SourceItemSchema>;
export type ContentItem = z.infer<typeof ContentItemSchema>;
export type ContentVariant = z.infer<typeof ContentVariantSchema>;
export type MediaInfo = z.infer<typeof mediaInfoSchema>;
