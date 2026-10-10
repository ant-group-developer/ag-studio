/**
 * AG Studio as a Claude-Code-like workspace (spec 2026-10-10 agent-workspace, ADR-0001 items 179–190): a team's
 * projects (one per YouTube channel), the videos added to them one at a time, and the per-project settings.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const PROJECT_ASPECTS = ["16:9", "9:16"] as const;
export type ProjectAspect = (typeof PROJECT_ASPECTS)[number];

export const VIDEO_STATUSES = ["draft", "in_progress", "rendering", "done"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

/** How the agent works on a project. Absent keys mean the Studio default. */
export const ProjectSettingsSchema = z.object({
  /** A model alias or full name for this project's agent turns (else `STUDIO_AGENT_MODEL`). */
  model: z.string().min(1).max(80).optional(),
  /** The usual length of a video on this channel, in seconds. */
  target_seconds: z.number().positive().max(4 * 3600).optional(),
  /** Team skills this project loads (ids); absent = every enabled team skill. */
  team_skills: z.array(z.string().min(1)).max(100).optional(),
  /** After a turn leaves a file with errors, Studio asks the agent once to fix it. */
  auto_fix: z.boolean().default(true),
  /** When a job the agent started finishes, the agent is told and continues (at most 3 turns in a row). */
  auto_continue: z.boolean().default(true),
}).strict();
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/** A stored settings value (JSON TEXT), or the defaults when it is missing or no longer valid. */
export function projectSettingsOf(raw: string | null | undefined): ProjectSettings {
  if (raw) {
    try {
      const parsed = ProjectSettingsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch { /* broken JSON: defaults */ }
  }
  return ProjectSettingsSchema.parse({});
}

const trimmed = (max: number) => z.string().trim().max(max);

/** A YouTube channel: a youtube.com / youtu.be link or an `@handle`. */
export const ChannelUrlSchema = z.string().trim().max(300).refine(
  (v) => /^@[\w.-]{3,100}$/.test(v) || /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(v),
  { message: "kênh phải là link youtube.com hoặc @handle" },
);

export const CreateProjectSchema = z.object({
  name: trimmed(120).min(1),
  channelUrl: ChannelUrlSchema.optional(),
  description: trimmed(4000).default(""),
  language: z.string().trim().min(2).max(10).default("vi"),
  aspect: z.enum(PROJECT_ASPECTS).default("16:9"),
}).strict();
export type CreateProject = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({
  name: trimmed(120).min(1).optional(),
  channelUrl: ChannelUrlSchema.nullable().optional(),
  description: trimmed(4000).optional(),
  language: z.string().trim().min(2).max(10).optional(),
  aspect: z.enum(PROJECT_ASPECTS).optional(),
  settings: ProjectSettingsSchema.optional(),
}).strict();
export type UpdateProject = z.infer<typeof UpdateProjectSchema>;

/**
 * A tool's input as the JSON Schema an MCP `tools/list` answers (an object schema, no `$schema`, no `$ref`s), from
 * the zod schema Studio checks the call with.
 */
export function toolInputJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const out = zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

// ---------------------------------------------------------------------------
// Playbook: suggested steps, never enforced (spec 2026-10-10 agent-workspace §6, ADR-0001 item 184)
// ---------------------------------------------------------------------------

/** Checks Studio runs on a step's file (`workspace/validators.ts`). */
export const FILE_VALIDATORS = ["brief", "branding", "youtube_kit", "style", "survey", "edit_plan"] as const;
export type FileValidatorId = (typeof FILE_VALIDATORS)[number];

/** How a step counts as done: its document says `status: done` and checks out; its files exist and check out; Studio knows. */
export const STEP_DONE_WHEN = ["doc_done", "files_valid", "studio"] as const;

export const STEP_STATUSES = ["missing", "draft", "invalid", "done", "skipped", "stale", "running"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

const stepKey = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "chữ thường, số, gạch ngang");

export const PlaybookOutputSchema = z.object({
  /** Workspace path; `{video}` stands for the video's id. */
  path: z.string().min(1).max(200),
  /** `doc`: markdown a person reads (frontmatter `status`); `data`: a file Studio reads; `studio`: Studio writes it. */
  role: z.enum(["doc", "data", "studio"]),
  validator: z.enum(FILE_VALIDATORS).optional(),
}).strict();

export const PlaybookStepSchema = z.object({
  key: stepKey,
  scope: z.enum(["project", "video"]),
  title: z.string().min(1).max(80),
  description: z.string().max(600).default(""),
  /** The skill the agent uses (`studio:<name>`), if any. */
  skill: z.string().max(60).optional(),
  /** Steps that should be done first (a suggestion: nothing blocks). A video step may require a project step. */
  requires: z.array(stepKey).max(10).default([]),
  optional: z.boolean().default(false),
  outputs: z.array(PlaybookOutputSchema).min(1).max(6),
  done_when: z.enum(STEP_DONE_WHEN).default("doc_done"),
  /** What the composer is filled with: do the step, redo it, revise it after feedback (`{file}`, `{video}`). */
  prompts: z.object({
    do: z.string().min(1).max(1500),
    redo: z.string().max(1500).optional(),
    revise: z.string().max(1500).optional(),
  }).strict(),
}).strict();
export type PlaybookStep = z.infer<typeof PlaybookStepSchema>;

export const StudioPlaybookSchema = z.object({
  schema_version: z.literal("studio.playbook/v1"),
  steps: z.array(PlaybookStepSchema).min(1).max(40),
}).strict().superRefine((p, ctx) => {
  const keys = new Map<string, "project" | "video">();
  p.steps.forEach((s, i) => {
    if (keys.has(s.key)) ctx.addIssue({ code: "custom", path: ["steps", i, "key"], message: `bước "${s.key}" bị trùng` });
    keys.set(s.key, s.scope);
  });
  p.steps.forEach((s, i) => s.requires.forEach((r, j) => {
    const scope = keys.get(r);
    if (!scope) ctx.addIssue({ code: "custom", path: ["steps", i, "requires", j], message: `không có bước "${r}"` });
    else if (s.scope === "project" && scope === "video") ctx.addIssue({ code: "custom", path: ["steps", i, "requires", j], message: `bước dự án không thể cần bước video "${r}"` });
  }));
});
export type StudioPlaybook = z.infer<typeof StudioPlaybookSchema>;
