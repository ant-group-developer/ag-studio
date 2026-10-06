import { z } from "zod";
import {
  CAPTION_MODES, ChannelRefSchema, MAX_RESEARCH_CHANNELS, MAX_RESEARCH_KEYWORDS, STUDIO_ASPECTS, StudioHintsSchema, StudioMusicSchema,
  studioVersion, TEXT_KINDS, TEXT_POSITIONS_V2, TIMELINE_TRANSITIONS, type TeamSkillStep,
} from "./studio.js";

/**
 * Chat with Claude on a production (spec local-chat §3.1). Every reply is one structured Claude call answering
 * `{ reply, action, proposal }`; `proposal` is a new version of the document on show (checked by the same validator
 * as the stage that wrote it) and is only applied when the person presses Apply/Approve.
 */

/** What the person sees next to a reply: a plain answer, a new version, or a card asking to approve / render / … */
export const CHAT_ACTIONS = ["answer", "revise", "suggest_approve", "render", "export", "retry"] as const;
export type ChatActionName = (typeof CHAT_ACTIONS)[number];

export const CHAT_REPLY_MAX = 4000;

/** The reply Claude gives in a chat turn, around the stage's own document schema. */
export function chatReplySchema<T extends z.ZodTypeAny>(proposal: T) {
  return z.object({
    reply: z.string().min(1).max(CHAT_REPLY_MAX),
    action: z.enum(CHAT_ACTIONS),
    proposal: proposal.nullable(),
  }).strict();
}

// ---------------------------------------------------------------------------
// Skills that only exist in chat
// ---------------------------------------------------------------------------

export const STUDIO_CHAT_SKILLS = ["studio-intake", "studio-timeline"] as const;
export type StudioChatSkill = (typeof STUDIO_CHAT_SKILLS)[number];
export const STUDIO_CHAT_SKILL_STEP: Record<StudioChatSkill, TeamSkillStep> = {
  "studio-intake": "intake",
  "studio-timeline": "timeline",
};

// ---------------------------------------------------------------------------
// Intake: a free sentence and @folders → what the series needs before it can start
// ---------------------------------------------------------------------------

/** Fields Claude may still need to ask about. `research` = at least one channel or keyword. */
export const INTAKE_FIELDS = ["title", "folder_ids", "aspect", "language", "research", "episode_target_seconds", "max_episodes", "tone", "audience"] as const;
export type IntakeField = (typeof INTAKE_FIELDS)[number];

/** The production as the chat has understood it so far; null = not known yet. */
export const IntakeDraftSchema = z.object({
  schema_version: studioVersion("intake-draft"),
  title: z.string().min(1).max(200).nullable(),
  folder_ids: z.array(z.string().min(1)).max(50),
  channels: z.array(ChannelRefSchema).max(MAX_RESEARCH_CHANNELS),
  keywords: z.array(z.string().min(1).max(100)).max(MAX_RESEARCH_KEYWORDS),
  aspect: z.enum(STUDIO_ASPECTS).nullable(),
  language: z.string().min(2).max(10).nullable(),
  hints: StudioHintsSchema,
  /** Still to ask, most important first; the chat asks only the first one. `options` become quick answers. */
  questions: z.array(z.object({
    field: z.enum(INTAKE_FIELDS),
    question: z.string().min(1).max(300),
    options: z.array(z.string().min(1).max(60)).max(4),
  }).strict()).max(5),
}).strict();
export type IntakeDraft = z.infer<typeof IntakeDraftSchema>;

/** What must be known before the series starts (`startPlanRun` needs folders and a channel or a keyword). */
export function intakeMissing(d: IntakeDraft): IntakeField[] {
  const out: IntakeField[] = [];
  if (!d.title) out.push("title");
  if (d.folder_ids.length === 0) out.push("folder_ids");
  if (!d.aspect) out.push("aspect");
  if (!d.language) out.push("language");
  if (d.channels.length === 0 && d.keywords.length === 0) out.push("research");
  return out;
}

// ---------------------------------------------------------------------------
// Timeline: chat proposes edit operations (the timeline itself holds a record of assets, which Claude cannot write)
// ---------------------------------------------------------------------------

const clipId = z.string().regex(/^C\d{3,4}$/);
const textId = z.string().regex(/^T\d{3}$/);
const index = z.number().int().min(0);
const textFields = {
  kind: z.enum(TEXT_KINDS),
  text: z.string().min(1).max(64),
  start: z.number().min(0),
  duration: z.number().min(0.5).max(20),
  position: z.enum(TEXT_POSITIONS_V2),
};

/** One edit, named after the operation in `core/src/studio/layout.ts` it runs. */
export const TimelineOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addClip"), asset_id: z.string().min(1), index }).strict(),
  z.object({ op: z.literal("removeClip"), clip_id: clipId }).strict(),
  z.object({ op: z.literal("moveClip"), from: index, to: index }).strict(),
  z.object({ op: z.literal("replaceClipAsset"), clip_id: clipId, asset_id: z.string().min(1) }).strict(),
  z.object({ op: z.literal("setSectionTitle"), clip_id: clipId, title: z.string().min(1).max(100).nullable() }).strict(),
  z.object({ op: z.literal("addText"), ...textFields }).strict(),
  /** null = keep the current value. */
  z.object({
    op: z.literal("updateText"), text_id: textId,
    kind: textFields.kind.nullable(), text: textFields.text.nullable(), start: textFields.start.nullable(),
    duration: textFields.duration.nullable(), position: textFields.position.nullable(),
  }).strict(),
  z.object({ op: z.literal("removeText"), text_id: textId }).strict(),
  z.object({ op: z.literal("setMusic"), music: StudioMusicSchema.nullable() }).strict(),
  z.object({ op: z.literal("setSourceMuted"), muted: z.boolean() }).strict(),
  /** Timeline v4 only (shot-cut episodes): seconds into the asset; `out: null` = to the end of the asset. */
  z.object({ op: z.literal("trimClip"), clip_id: clipId, in: z.number().min(0), out: z.number().positive().nullable() }).strict(),
  z.object({ op: z.literal("setTransition"), clip_id: clipId, kind: z.enum(TIMELINE_TRANSITIONS), seconds: z.number().min(0).max(1) }).strict(),
  z.object({ op: z.literal("setCaptions"), mode: z.enum(CAPTION_MODES) }).strict(),
]);
export type TimelineOp = z.infer<typeof TimelineOpSchema>;

/** What a timeline chat reply proposes: the edits, applied in order to the latest revision. */
export const TimelineChatProposalSchema = z.object({ ops: z.array(TimelineOpSchema).min(1).max(50) }).strict();
export type TimelineChatProposal = z.infer<typeof TimelineChatProposalSchema>;
