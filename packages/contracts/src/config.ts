import { z } from "zod";
import { jsonObjectSchema, revisionSchema, schemaVersion, secretRefSchema, semverSchema } from "./common.js";
import { executorRefSchema, retryPolicySchema } from "./entities.js";

export const DEFAULT_RETRY = { max_attempts: 3, backoff_seconds: [10, 60, 300], retry_on: ["transient", "abandoned"] as const };

export const stageDefinitionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  executor: executorRefSchema,
  depends_on: z.array(z.string()).default([]),
  required_capabilities: z.array(z.string()).default([]),
  required_checks: z.array(z.string()).default([]),
  retry: retryPolicySchema.default({ ...DEFAULT_RETRY, retry_on: [...DEFAULT_RETRY.retry_on] }),
  outputs: z.array(z.object({ type: z.string().min(1), mime_type: z.string().min(1) }).strict()).default([]),
  config: jsonObjectSchema.default({}),
}).strict();

export const WorkflowDefinitionSchema = z.object({
  schema_version: schemaVersion("workflow"),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: semverSchema,
  defaults: jsonObjectSchema.default({}),
  stages: z.array(stageDefinitionSchema).min(1),
}).strict().superRefine((wf, ctx) => {
  const keys = new Set(wf.stages.map((s) => s.key));
  if (keys.size !== wf.stages.length) ctx.addIssue({ code: "custom", message: "duplicate stage key" });
  for (const s of wf.stages) for (const d of s.depends_on) {
    if (!keys.has(d)) ctx.addIssue({ code: "custom", message: `stage ${s.key} depends on unknown stage ${d}` });
    if (d === s.key) ctx.addIssue({ code: "custom", message: `stage ${s.key} depends on itself` });
  }
  // cycle detection: DFS with colouring over depends_on edges
  const deps = new Map(wf.stages.map((s) => [s.key, s.depends_on]));
  const colour = new Map<string, 1 | 2>();
  const visit = (k: string, path: string[]): void => {
    if (colour.get(k) === 2) return;
    if (colour.get(k) === 1) { ctx.addIssue({ code: "custom", message: `dependency cycle: ${[...path, k].join(" -> ")}` }); return; }
    colour.set(k, 1);
    for (const d of deps.get(k) ?? []) if (keys.has(d)) visit(d, [...path, k]);
    colour.set(k, 2);
  };
  for (const s of wf.stages) visit(s.key, []);
});

export const ProductionProfileSchema = z.object({
  schema_version: schemaVersion("production-profile"),
  profile_id: z.enum(["cartoon", "avatar", "footage"]),
  revision: revisionSchema,
  status: z.enum(["active", "draft", "retired"]),
  workflow_release: z.string().regex(/^[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/),
  overrides: jsonObjectSchema.default({}),
  verification: z.object({ required_checks: z.array(z.string()).default([]) }).strict().default({ required_checks: [] }),
  limits: z.object({ max_cost_usd_per_variant: z.number().min(0).default(5), max_concurrency: z.number().int().min(1).default(1) }).strict().default({ max_cost_usd_per_variant: 5, max_concurrency: 1 }),
}).strict();

export const ChannelConfigSchema = z.object({
  schema_version: schemaVersion("channel-config"),
  channel_id: z.string().min(1),
  config_revision: revisionSchema,
  display_name: z.string(),
  portfolio_id: z.string().min(1),
  youtube: z.object({ account_ref: secretRefSchema, expected_channel_id: z.string().min(1) }).strict(),
  publication: z.object({
    timezone: z.string(), visibility: z.enum(["private", "unlisted", "public"]), allowed_profiles: z.array(z.string()),
    max_daily_uploads: z.number().int().min(0), require_human_approval_for_public: z.boolean(),
  }).strict(),
  overrides: jsonObjectSchema.default({}),
}).strict();

export const ProjectConfigSchema = z.object({
  schema_version: schemaVersion("project-config"),
  project_id: z.string().min(1),
  template_release: z.string().min(1),
  runtime: z.enum(["claude", "codex"]),
  data_root: z.string().min(1),
  portfolios: z.array(z.object({ portfolio_id: z.string().min(1), display_name: z.string() }).strict()).min(1),
}).strict();

export const HarnessConfigSchema = z.object({
  schema_version: schemaVersion("config"),
  lease_seconds: z.number().int().min(5).default(90),
  heartbeat_seconds: z.number().int().min(1).default(30),
  poll_seconds: z.number().int().min(1).default(2),
  default_deadline_seconds: z.number().int().min(1).default(3600),
  default_max_cost_usd: z.number().min(0).default(5),
  retention: z.object({ workspace_days: z.number().int().min(0).default(7) }).strict().default({ workspace_days: 7 }),
  allowed_override_keys: z.array(z.string()).default(["lease_seconds", "default_deadline_seconds", "default_max_cost_usd"]),
}).strict();

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type StageDefinition = z.infer<typeof stageDefinitionSchema>;
export type ProductionProfile = z.infer<typeof ProductionProfileSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
