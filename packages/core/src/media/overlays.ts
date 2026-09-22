/** Overlay anchor resolution, placement/collision, caption raise and density-limit math for text-on-picture
 * overlays (sub-project 5B Task 4, spec §4.2). Pure: no I/O, no clock, no randomness. */
import type { BrandProfile, CaptionCue, Edl, Narration, OverlayKind, Overlays, TextAnimation, TextEvent, TextPosition, Timeline } from "@harness/contracts";
import { EPS, round3 } from "./time.js";

export const OVERLAY = { max_shift_seconds: 2, lower_third_raise_factor: 1.6 } as const;

type Anchor = Overlays["items"][number]["anchor"];
type Zone = "top" | "center" | "bottom";

/** Resolves an overlay's anchor to a start second, or `null` when the anchor does not exist in `timeline`
 * (missing `line_id`/`word_index`, missing `edl_order`, or out-of-range `speech_index`) -- spec §4.2. */
export function resolveAnchor(anchor: Anchor, timeline: Timeline): number | null {
  if ("line_id" in anchor) {
    const line = timeline.narration.find((n) => n.line_id === anchor.line_id);
    if (!line) return null;
    if (anchor.word_index !== undefined) {
      const word = line.words[anchor.word_index];
      return word ? word.start : null;
    }
    return line.start;
  }
  if ("edl_order" in anchor) {
    const seg = timeline.video.find((v) => v.order === anchor.edl_order);
    return seg ? seg.start : null;
  }
  const speech = timeline.speech[anchor.speech_index];
  return speech ? speech.start : null;
}

function zoneOf(position: TextPosition): Zone {
  if (position === "center") return "center";
  return position.startsWith("top_") ? "top" : "bottom";
}

function overlapsTime(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end - EPS && b.start < a.end - EPS;
}

interface Working {
  id: string;
  kind: OverlayKind;
  text: string;
  start: number;
  end: number;
  position: TextPosition;
  animation: TextAnimation;
}

/**
 * Resolves each overlay item's anchor and duration, drops anchors that don't exist or resolve to a span
 * under 0.5s, then applies logo avoidance (top-corner items sharing the logo's corner move to the other top
 * corner, or `top_center` if that corner is already taken by an overlapping kept event) and zone-based
 * collision resolution (a later event in the same zone that overlaps the last kept event of that zone is
 * pushed to start right after it, keeping its own duration; a push over `OVERLAY.max_shift_seconds` drops the
 * event instead) -- spec §4.2.
 */
export function placeOverlays(p: {
  overlays: Overlays | null;
  timeline: Timeline;
  brand: BrandProfile;
  logo: { corner: "left" | "right" } | null;
}): { events: TextEvent[]; dropped: { id: string; reason: string }[]; warnings: string[] } {
  const { overlays, timeline, brand, logo } = p;
  const dropped: { id: string; reason: string }[] = [];
  const warnings: string[] = [];
  if (!overlays || overlays.items.length === 0) return { events: [], dropped, warnings };

  const resolved: Working[] = [];
  for (const item of overlays.items) {
    const start = resolveAnchor(item.anchor, timeline);
    if (start === null) {
      dropped.push({ id: item.id, reason: "anchor_missing" });
      continue;
    }
    const style = brand.text[item.kind];
    const seconds = item.seconds ?? style.seconds;
    const end = Math.min(start + seconds, timeline.total_seconds);
    if (end - start < 0.5 - EPS) {
      dropped.push({ id: item.id, reason: "too_short" });
      continue;
    }
    resolved.push({
      id: item.id,
      kind: item.kind,
      text: item.text,
      start: round3(start),
      end: round3(end),
      position: style.position,
      animation: style.animation,
    });
  }

  // Stable sort by resolved start (Array#sort is stable; ties keep original item order).
  const sorted = resolved
    .map((w, i) => ({ w, i }))
    .sort((a, b) => a.w.start - b.w.start || a.i - b.i)
    .map((x) => x.w);

  // Logo avoidance runs before collision resolution (brief decision): only top_left/top_right items sharing
  // the logo's top corner are touched, so checking against the full sorted list is safe -- items whose
  // position is the *opposite* corner are never mutated by this loop, and earlier same-corner items have
  // already been mutated in place by the time a later item's overlap check runs.
  if (logo) {
    const topCorner: TextPosition = logo.corner === "right" ? "top_right" : "top_left";
    const opposite: TextPosition = topCorner === "top_right" ? "top_left" : "top_right";
    for (const ev of sorted) {
      if (ev.position !== topCorner) continue;
      const occupiedOpposite = sorted.some((other) => other !== ev && other.position === opposite && overlapsTime(ev, other));
      ev.position = occupiedOpposite ? "top_center" : opposite;
    }
  }

  const lastKeptByZone: Partial<Record<Zone, Working>> = {};
  const events: TextEvent[] = [];
  for (const ev of sorted) {
    const zone = zoneOf(ev.position);
    const last = lastKeptByZone[zone];
    if (last && ev.start < last.end - EPS) {
      const shift = last.end - ev.start;
      if (shift > OVERLAY.max_shift_seconds + EPS) {
        dropped.push({ id: ev.id, reason: "collision" });
        warnings.push(`overlay_dropped:${ev.id}`);
        continue;
      }
      const duration = ev.end - ev.start;
      ev.start = round3(last.end);
      ev.end = round3(Math.min(ev.start + duration, timeline.total_seconds));
    }
    lastKeptByZone[zone] = ev;
    events.push({ id: ev.id, kind: ev.kind, text: ev.text, start: ev.start, end: ev.end, position: ev.position, animation: ev.animation });
  }

  return { events, dropped, warnings };
}

/** Raises any caption cue that overlaps a `lower_third` text event by `text.lower_third.size_px * 1.6` px
 * (`raise_px`), so burned-in subtitles clear a lower-third banner -- spec §4.2. */
export function raiseCaptions(cues: CaptionCue[], events: TextEvent[], brand: BrandProfile): CaptionCue[] {
  const lowerThirds = events.filter((e) => e.kind === "lower_third");
  if (lowerThirds.length === 0) return cues;
  const raisePx = Math.round(brand.text.lower_third.size_px * OVERLAY.lower_third_raise_factor);
  return cues.map((cue) => (lowerThirds.some((e) => overlapsTime(cue, e)) ? { ...cue, raise_px: raisePx } : cue));
}

const DENSITY_SPACING: Record<"low" | "medium" | "high", number> = { high: 5, medium: 8, low: 15 };

function charsPerSecond(language: string): number {
  if (language.startsWith("en")) return 15;
  if (language.startsWith("vi")) return 14;
  return 15;
}

/**
 * Maximum overlay count for a given density: `max(1, floor(seconds / spacing))`, where `seconds` is
 * `max(estimated spoken length, total EDL screen time)` -- spec §3's density rule.
 *
 * Both terms, not one or the other (controller ruling, task-8 fix round 1). Taking the narration estimate
 * *instead of* the EDL length made every `voice: none`/`original` plan-edit carry a `narration.json` with
 * `lines: []`, which scored 0 seconds and so a limit of 0 -- every overlay plan for a silent or
 * original-audio episode was rejected outright. Taking the maximum also matches how the two actually
 * relate: the picture is at least as long as the script it covers, and a script running longer than the
 * footage is exactly the shortfall `media-fit-edl` fixes by appending more picture.
 *
 * The floor of 1 is spec §3's "luôn cho phép ít nhất một sự kiện": an opening title is always allowed,
 * however short the episode.
 */
export function overlayDensityLimit(p: { narration: Narration | null; edl: Edl; language: string; density: "low" | "medium" | "high" }): number {
  const spacing = DENSITY_SPACING[p.density];
  const narrationSeconds = (p.narration?.lines ?? []).reduce((sum, line) => sum + line.text.length, 0) / charsPerSecond(p.language);
  const edlSeconds = p.edl.entries.reduce((sum, e) => sum + (e.out - e.in), 0);
  return Math.max(1, Math.floor(Math.max(narrationSeconds, edlSeconds) / spacing));
}
