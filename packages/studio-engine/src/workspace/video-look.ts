/**
 * A video's words and picture (plan 2026-10-28 P3): the font and colours of the text on screen (`text_look`), the colour
 * of the picture (`look`) and colour matching. A person picks them in the video's Style tab; what they pick wins over
 * the edit plan's, which wins over the channel's branding. Picking one puts it on the latest timeline at once.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TEXT_FONT_INFO, TEXT_FONTS, TEXT_LOOK_SIZES, TextLookSchema, VIDEO_LOOKS, type TextLook, type TimelineV4, type VideoLook } from "@harness/contracts";
import { StudioRunError } from "../errors.js";
import type { StudioDb } from "../studio-db.js";
import { brandingOf, editPlanPath, writeTimelineSnapshot } from "./fit.js";
import { latestVideoRevision, saveVideoRevision, videoOwnLook, type VideoOwnLook } from "./project-db.js";

export type LookSource = "video" | "plan" | "channel" | "default";

/** What the Style tab offers: the fonts the render machines have (with the scripts each draws), sizes, picture looks. */
export const LOOK_CHOICES = {
  fonts: TEXT_FONTS.map((name) => ({ name, scripts: [...TEXT_FONT_INFO[name].scripts] })),
  sizes: [...TEXT_LOOK_SIZES],
  looks: [...VIDEO_LOOKS],
};

const OwnLookSchema = z.object({
  text_look: TextLookSchema.nullable(),
  look: z.enum(VIDEO_LOOKS).nullable(),
  color_match: z.boolean().nullable(),
}).strict();

/** A person's pick as sent (every key; null = not picked), or `invalid` saying what is wrong. */
export function parseOwnLook(raw: unknown): VideoOwnLook {
  const r = OwnLookSchema.safeParse(raw);
  if (!r.success) throw new StudioRunError("invalid", `chữ/màu không hợp lệ: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, { code: "bad_look" });
  return r.data;
}

export interface VideoLookView {
  own: VideoOwnLook;
  plan: VideoOwnLook;
  channel: VideoOwnLook;
  /** What the timeline draws: the video's pick, else the plan's, else the branding's, else Studio's default. */
  effective: { text_look: TextLook | null; look: VideoLook; color_match: boolean; from: { text_look: LookSource; look: LookSource; color_match: LookSource } };
}

/** The edit plan's say (`text_look`, `look`, `color_match` of `edit-plan.json`), each null when it has none or the file cannot be read. */
export function planLookOf(dir: string, videoId: string): VideoOwnLook {
  const none: VideoOwnLook = { text_look: null, look: null, color_match: null };
  const path = join(dir, editPlanPath(videoId));
  if (!existsSync(path)) return none;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return none; }
  const text = raw.text_look ? TextLookSchema.safeParse(raw.text_look) : null;
  return {
    text_look: text?.success ? text.data : null,
    look: typeof raw.look === "string" && (VIDEO_LOOKS as readonly string[]).includes(raw.look) ? (raw.look as VideoLook) : null,
    color_match: typeof raw.color_match === "boolean" ? raw.color_match : null,
  };
}

function pick<T>(own: T | null, plan: T | null, channel: T | null): { value: T | null; from: LookSource } {
  if (own !== null) return { value: own, from: "video" };
  if (plan !== null) return { value: plan, from: "plan" };
  if (channel !== null) return { value: channel, from: "channel" };
  return { value: null, from: "default" };
}

export async function videoLookView(db: StudioDb, dir: string, videoId: string): Promise<VideoLookView> {
  const own = await videoOwnLook(db, videoId);
  const plan = planLookOf(dir, videoId);
  const b = brandingOf(dir);
  const channel: VideoOwnLook = { text_look: b.textLook, look: b.look, color_match: b.colorMatch };
  const text = pick(own.text_look, plan.text_look, channel.text_look);
  const look = pick(own.look, plan.look, channel.look);
  const match = pick(own.color_match, plan.color_match, channel.color_match);
  return {
    own, plan, channel,
    effective: {
      text_look: text.value, look: look.value ?? "none", color_match: match.value ?? false,
      from: { text_look: text.from, look: look.from, color_match: match.from },
    },
  };
}

/** The timeline with these words and picture (absent keys: Studio's default look, as filmed, no matching). */
export function withLook(t: TimelineV4, e: VideoLookView["effective"]): TimelineV4 {
  const { text_style: _t, look: _l, color_match: _c, ...rest } = t;
  return { ...rest, ...(e.text_look ? { text_style: e.text_look } : {}), ...(e.look !== "none" ? { look: e.look } : {}), ...(e.color_match ? { color_match: true } : {}) };
}

/**
 * The revision the video's latest timeline now draws its words and picture in, or null when nothing was written: no
 * timeline yet (the fit takes them when it builds one), or it already has them.
 */
export async function videoLookToTimeline(db: StudioDb, o: { workspaceDir: string; projectId: string; videoId: string; authorId: string; now?: string }): Promise<number | null> {
  const latest = await latestVideoRevision(db, o.videoId);
  if (!latest) return null;
  const view = await videoLookView(db, o.workspaceDir, o.videoId);
  const next = withLook(latest.data, view.effective);
  const same = (a: TimelineV4) => JSON.stringify([a.text_style ?? null, a.look ?? null, a.color_match ?? null]);
  if (same(next) === same(latest.data)) return null;
  const { revision } = await saveVideoRevision(db, o.videoId, { baseRevision: latest.revision, data: next, authorId: o.authorId, label: "look" });
  await writeTimelineSnapshot(db, o.workspaceDir, o.projectId, o.videoId, o.now);
  return revision;
}
