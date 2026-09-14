import { z } from "zod";
import { expectedOutputSchema, jsonObjectSchema, revisionSchema, schemaVersion, secretRefSchema, semverSchema } from "./common.js";
import { executorRefSchema, retryPolicySchema } from "./entities.js";

export const DEFAULT_RETRY = { max_attempts: 3, backoff_seconds: [10, 60, 300], retry_on: ["transient", "abandoned"] as const };

export const WHEN_RE = /^options\.([a-z][a-z0-9_]*) (==|!=) "([^"]*)"$/;

export const stageDefinitionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  executor: executorRefSchema,
  depends_on: z.array(z.string()).default([]),
  depends_on_optional: z.array(z.string()).default([]),
  when: z.string().regex(WHEN_RE, 'expected options.<key> == "<value>" or !=').optional(),
  requires_resources: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
  gate_deadline_seconds: z.number().int().min(1).optional(),
  required_capabilities: z.array(z.string()).default([]),
  required_checks: z.array(z.string()).default([]),
  retry: retryPolicySchema.default({ ...DEFAULT_RETRY, retry_on: [...DEFAULT_RETRY.retry_on] }),
  outputs: z.array(expectedOutputSchema).default([]),
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
  for (const s of wf.stages) for (const d of [...s.depends_on, ...s.depends_on_optional]) {
    if (!keys.has(d)) ctx.addIssue({ code: "custom", message: `stage ${s.key} depends on unknown stage ${d}` });
    if (d === s.key) ctx.addIssue({ code: "custom", message: `stage ${s.key} depends on itself` });
  }
  // cycle detection: DFS with colouring over depends_on edges
  const deps = new Map(wf.stages.map((s) => [s.key, [...s.depends_on, ...s.depends_on_optional]]));
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
  options_schema: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.array(z.string().min(1)).min(1)).default({}),
  options_defaults: jsonObjectSchema.default({}),
  reuse: z.enum(["allow", "never"]).default("allow"),
  content: z.object({ target_duration_seconds: z.tuple([z.number().min(0), z.number().min(0)]).optional(), max_silence_ratio: z.number().min(0).max(1).optional() }).strict().default({}),
  verification: z.object({ required_checks: z.array(z.string()).default([]), required_checks_by_stage: z.record(z.string(), z.array(z.string())).default({}) }).strict().default({ required_checks: [], required_checks_by_stage: {} }),
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
  resources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.number().int().min(0)).default({}),
  source: z.object({ materialize: z.enum(["link", "copy", "reference"]).default("link") }).strict().default({ materialize: "link" }),
  library: z.object({
    root: z.string().min(1),
    role: z.enum(["studio", "channel"]),
    sync_seconds: z.number().int().min(10).default(300),
  }).strict().optional(),
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
  resource_wait_warn_seconds: z.number().int().min(1).default(600),
}).strict();

export const scriptSpecSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).default("."),
  env_refs: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), secretRefSchema).default({}),
  requires_resources: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
  timeout_seconds: z.number().int().min(1).optional(),
}).strict();
/** `executors/scripts.yaml` of an operations project: script name (executor.script) -> command. */
export const ScriptsRegistrySchema = z.object({ schema_version: schemaVersion("scripts"), scripts: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), scriptSpecSchema) }).strict();

export const sourceEntrySchema = z.object({
  path: z.string().min(1),
  collection: z.string().regex(/^[a-z][a-z0-9-]*$/).default("main"),
  rights_status: z.enum(["unknown", "cleared", "restricted"]).default("unknown"),
  language: z.string().nullable().default(null),
}).strict();
/** `source-catalog/sources.yaml`: the reviewed register; the DB is the machine index. */
export const SourcesRegistrySchema = z.object({ schema_version: schemaVersion("sources"), sources: z.array(sourceEntrySchema).default([]) }).strict();

export type ScriptSpec = z.infer<typeof scriptSpecSchema>;
export type ScriptsRegistry = z.infer<typeof ScriptsRegistrySchema>;
export type SourcesRegistry = z.infer<typeof SourcesRegistrySchema>;

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type StageDefinition = z.infer<typeof stageDefinitionSchema>;
export type ProductionProfile = z.infer<typeof ProductionProfileSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
