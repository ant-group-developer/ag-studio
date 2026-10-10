/**
 * AG Studio as a Claude-Code-like workspace (spec 2026-10-10 agent-workspace, ADR-0001 items 179–190): a team's
 * projects (one per YouTube channel), the videos added to them one at a time, and the per-project settings.
 */
import { z } from "zod";

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
