/**
 * Thumbnails cut from the final video (ag-studio-episode@1.2.0), pure parts shared by the episode stage and the API:
 * which moments to cut (clean of on-screen words), how the words of a thumbnail are laid out (the same lines for the
 * JPEG and for the PDF a Canva import gets), and the ASS document libass draws them with.
 */
import type { StudioBranding, ThumbnailStyle, ThumbnailTextPosition } from "@harness/contracts";
import { assColor, escapeAss } from "../media/ass.js";
import type { TimelineLayout } from "./layout.js";

export interface FrameCandidate { t_s: number; clip_id: string; asset_id: string }

export interface FrameCandidateOptions {
  /** Assets the YouTube kit picked for its suggestions: each gets at least one frame. */
  kitAssetIds?: string[];
  /** At most this many frames for the whole episode. */
  max?: number;
  /** Points per clip, spread inside it (fractions 1/(n+1) … n/(n+1)). */
  perClip?: number;
  /** Seconds kept clear at each clip edge (fades, cuts). */
  edgeS?: number;
  /** Seconds kept clear around every on-screen text, so the frames carry no words of the video. */
  textPadS?: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Moments of the episode to cut as thumbnail candidates: a few per clip, away from clip edges and from on-screen
 * texts; every asset of the kit's suggestions gets one (its clip's middle when nothing else is clean); at most `max`,
 * evenly thinned when there are more (kit frames kept). Sorted by time.
 */
export function frameCandidateTimes(layout: TimelineLayout, opts: FrameCandidateOptions = {}): FrameCandidate[] {
  const max = opts.max ?? 36;
  const perClip = opts.perClip ?? 3;
  const edge = opts.edgeS ?? 0.5;
  const pad = opts.textPadS ?? 0.25;
  const busy = layout.texts.map((t) => [t.start - pad, t.end + pad] as const);
  const clean = (t: number) => !busy.some(([a, b]) => t >= a && t <= b);

  const picked: FrameCandidate[] = [];
  const kitFrames: FrameCandidate[] = [];
  const kit = new Set(opts.kitAssetIds ?? []);
  for (const clip of layout.clips) {
    if (clip.duration <= 0) continue;
    const inner = clip.duration - 2 * edge;
    const points = inner > 0
      ? Array.from({ length: perClip }, (_, i) => clip.start + edge + (inner * (i + 1)) / (perClip + 1))
      : [clip.start + clip.duration / 2];
    const ok = points.filter(clean).map((t) => ({ t_s: r3(t), clip_id: clip.clip_id, asset_id: clip.asset_id }));
    picked.push(...ok);
    if (kit.has(clip.asset_id) && !kitFrames.some((f) => f.asset_id === clip.asset_id)) {
      kitFrames.push(ok[Math.floor(ok.length / 2)] ?? { t_s: r3(clip.start + clip.duration / 2), clip_id: clip.clip_id, asset_id: clip.asset_id });
    }
  }
  const all = [...picked];
  for (const f of kitFrames) if (!all.some((x) => x.t_s === f.t_s)) all.push(f);
  all.sort((a, b) => a.t_s - b.t_s);
  if (all.length <= max) return all;

  const keep = new Set(kitFrames.map((f) => f.t_s));
  const others = all.filter((f) => !keep.has(f.t_s));
  const room = Math.max(0, max - keep.size);
  const thinned = Array.from({ length: room }, (_, i) => others[Math.floor((i * others.length) / room)]!);
  return [...thinned, ...all.filter((f) => keep.has(f.t_s))].sort((a, b) => a.t_s - b.t_s);
}

/** The frame of `candidates` inside `assetId`'s clip closest to the clip's middle (a kit suggestion is drawn on it). */
export function suggestionFrame(layout: TimelineLayout, candidates: FrameCandidate[], assetId: string): FrameCandidate | null {
  const clip = layout.clips.find((c) => c.asset_id === assetId);
  if (!clip) return null;
  const mid = clip.start + clip.duration / 2;
  const inClip = candidates.filter((c) => c.clip_id === clip.clip_id);
  return inClip.sort((a, b) => Math.abs(a.t_s - mid) - Math.abs(b.t_s - mid))[0] ?? null;
}

/** Studio's look for thumbnail words, or the branding's (colours, where the words sit, upper case). */
export function thumbnailStyle(branding: StudioBranding | null): ThumbnailStyle {
  const t = branding?.thumbnail;
  return {
    position: t?.position ?? "bottom",
    size: "l",
    text_color: (t?.palette.text ?? "#FFFFFF").toUpperCase(),
    outline_color: (t?.palette.outline ?? "#000000").toUpperCase(),
    box_color: null,
    uppercase: t?.text_case === "upper",
  };
}

/** Font size in pixels of each size preset: a share of the frame's short edge. */
export function thumbnailFontSize(width: number, height: number, size: ThumbnailStyle["size"]): number {
  const share = { s: 0.09, m: 0.12, l: 0.15 }[size];
  return Math.round(Math.min(width, height) * share);
}

/**
 * The words as lines: greedy by characters (a bold sans glyph is about 0.55 em wide), at most 3 lines, upper case
 * when the style says so. The JPEG and the Canva PDF both draw these exact lines.
 */
export function thumbnailTextLines(text: string, opts: { width: number; height: number; style: ThumbnailStyle }): string[] {
  const words = (opts.style.uppercase ? text.toLocaleUpperCase("vi") : text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const font = thumbnailFontSize(opts.width, opts.height, opts.style.size);
  const usable = opts.width * (opts.style.position === "left" || opts.style.position === "right" ? 0.5 : 0.9);
  const perLine = Math.max(4, Math.floor(usable / (font * 0.55)));
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && (last + " " + w).length <= perLine) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  if (lines.length <= 3) return lines;
  return [...lines.slice(0, 2), lines.slice(2).join(" ")];
}

/** libass alignment (numpad) of each position. */
const ALIGNMENT: Record<ThumbnailTextPosition, number> = { bottom: 2, top: 8, center: 5, left: 4, right: 6 };

/**
 * The ASS document that draws `lines` on a `width`×`height` frame: bold `fontName`, outlined (or on a band), placed
 * by `style.position` with a 5% margin. Lines are joined by `\N` and never wrapped again (WrapStyle 2).
 */
export function thumbnailAss(p: { width: number; height: number; lines: string[]; style: ThumbnailStyle; fontName?: string }): string {
  const font = thumbnailFontSize(p.width, p.height, p.style.size);
  const margin = Math.round(Math.min(p.width, p.height) * 0.05);
  const box = p.style.box_color;
  const outline = box ? Math.max(4, Math.round(font * 0.2)) : Math.max(2, Math.round(font * 0.1));
  const style = [
    "Thumb", p.fontName ?? "Arial", font, assColor(p.style.text_color), assColor(p.style.text_color),
    assColor(box ?? p.style.outline_color), assColor(box ?? "#000000"),
    -1, 0, 0, 0, 100, 100, 0, 0, box ? 3 : 1, outline, box ? 0 : Math.max(1, Math.round(font * 0.04)),
    ALIGNMENT[p.style.position], margin, margin, margin, 1,
  ].join(",");
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${p.width}`,
    `PlayResY: ${p.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${style}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:00.00,0:00:10.00,Thumb,,0,0,0,,${p.lines.map(escapeAss).join("\\N")}`,
    "",
  ].join("\n");
}
