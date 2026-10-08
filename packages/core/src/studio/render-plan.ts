/**
 * Timeline (v3 or v4) -> the render worker's `composition.json` (`harness.composition/v1`).
 *
 * Each clip plays `[in, out)` of its asset (v3 and whole-video episodes: the whole asset); the source path is
 * `asset:<id>`, which the render worker resolves through Studio's `/farm/sign` endpoint. A shot-cut timeline (v4)
 * also brings its narration (`stage:voice/<line_id>.wav`, uploaded with the job), subtitles cut from the
 * narration's words, the music ducked under it, and its transitions with the dissolve tails resolved. Nothing here
 * moves a clip (ADR-0001 item 118). A v3 timeline gives exactly the composition it always gave.
 *
 * Also exports `thumbnailTimes` which picks three representative moments for the `thumbnails` payload
 * field the farm sends to the render worker.
 */
import { createHash } from "node:crypto";
import { upgradeTimelineV3, type Composition, type Timeline, type YoutubeKit } from "@harness/contracts";
import { buildCaptionCues } from "../media/captions.js";
import { duckWindows } from "../media/music.js";
import { isTimelineV4, layoutTimeline, resolveTransitions, type AnyTimeline, type TimelineLayout } from "./layout.js";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Subtitle line shape at 4K (harness brand default). */
const CAPTION_MAX_CHARS_PER_LINE = 42;
const CAPTION_MAX_LINES = 2;

/** Stable ULID-shaped id derived from a string, so the same asset keeps its mezzanine cache entry. */
export function stableUlid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest();
  let out = "";
  for (let i = 0; i < 26; i++) out += CROCKFORD[bytes[i]! % 32];
  return CROCKFORD[bytes[0]! % 8] + out.slice(1);
}

/** The Studio source id of an ag-go asset (`src_<ULID>`), the same in every composition. */
export function studioSourceId(assetId: string): string {
  return `src_${stableUlid(`asset:${assetId}`)}`;
}

/** The input name the render worker downloads a narration line from (uploaded with the job). */
export function narrationInput(lineId: string): string {
  return `stage:voice/${lineId}.wav`;
}

/**
 * The narration on the episode axis as a harness timeline, the input of the caption and ducking helpers of the
 * media pipeline. Only lines that are anchored and have been read count.
 */
function narrationTimeline(input: AnyTimeline, layout: TimelineLayout): Timeline {
  const t = isTimelineV4(input) ? input : upgradeTimelineV3(input);
  const lines = new Map(t.narration.lines.map((l) => [l.line_id, l]));
  const narration = t.narration.voice !== "tts" ? [] : layout.lines.flatMap((laid) => {
    const audio = lines.get(laid.line_id)?.audio;
    if (!audio) return [];
    const words = audio.words.map((w) => ({ word: w.word, start: r3(laid.start + w.start), end: r3(laid.start + w.end) }));
    return [{ line_id: laid.line_id, wav: narrationInput(laid.line_id), start: laid.start, end: laid.end, words }];
  });
  return {
    schema_version: "harness.timeline/v1",
    voice: narration.length > 0 ? "tts" : "none",
    language: t.language,
    total_seconds: layout.duration,
    video: layout.clips.map((c, order) => ({ order, source_id: studioSourceId(c.asset_id), in: c.in, out: c.source_out, start: c.start, end: c.end })),
    narration,
    speech: [],
  };
}

/**
 * Lines written but not read (narration declined: `voice: none`, lines without audio) as a timeline for the caption
 * helper only: each line where the layout puts it (its length estimated from its characters), its words spread evenly
 * over it. Nothing here is played or ducks the music.
 */
function writtenLines(input: AnyTimeline, layout: TimelineLayout): Timeline | null {
  const t = isTimelineV4(input) ? input : upgradeTimelineV3(input);
  if (t.narration.voice !== "none") return null;
  const lines = new Map(t.narration.lines.map((l) => [l.line_id, l]));
  const narration = layout.lines.flatMap((laid) => {
    const line = lines.get(laid.line_id);
    if (!line || line.audio) return [];
    const tokens = line.text.split(/\s+/).filter(Boolean);
    const step = (laid.end - laid.start) / Math.max(1, tokens.length);
    const words = tokens.map((word, i) => ({ word, start: r3(laid.start + i * step), end: r3(laid.start + (i + 1) * step) }));
    return [{ line_id: laid.line_id, wav: "", start: laid.start, end: laid.end, words }];
  });
  if (narration.length === 0) return null;
  return { ...narrationTimeline(input, layout), voice: "tts", narration };
}

/** Build `composition.json` from a frozen timeline. */
export function timelineToComposition(t: AnyTimeline): Composition {
  const layout = layoutTimeline(t);
  const hasAudio = !t.source_audio.muted;
  const v4 = isTimelineV4(t) ? t : null;
  const spoken = narrationTimeline(t, layout);
  // the footage's own speech is the episode's voice: played as it is, not lowered like background sound
  const voice = spoken.voice === "tts" ? "tts" : v4?.narration.voice === "original" ? "original" : "none";
  const transitions = resolveTransitions(layout);
  const warnings: string[] = [];

  const textEvents: Composition["text_events"] = layout.texts.map((x) => ({
    id: x.text_id,
    kind: x.kind,
    text: x.text,
    start: x.start,
    end: r3(x.start + x.duration),
    position: x.position,
    animation: "fade" as const,
  }));

  const captionMode = v4?.captions.mode ?? "none";
  let captions: Composition["captions"] = { mode: "none", cues: [] };
  // read lines give the words their timings; lines only written (narration declined) are captioned by their length
  const captioned = spoken.voice === "tts" ? spoken : writtenLines(t, layout);
  if (captionMode !== "none" && captioned) {
    const built = buildCaptionCues({ timeline: captioned, max_chars_per_line: CAPTION_MAX_CHARS_PER_LINE, max_lines: CAPTION_MAX_LINES });
    captions = { mode: captionMode, cues: built.cues };
    warnings.push(...built.warnings);
  }

  const music: Composition["music"] = t.music
    ? {
        track_id: stableUlid(`music:${t.music.track}`),
        path: t.music.track,
        loop: true,
        fade_in: 1.0,
        fade_out: 2.0,
        cues: [{ start: 0, end: layout.duration, gain_db: t.music.gain_db }],
        duck: {
          windows: t.music.ducking ? duckWindows(spoken) : [],
          gain_db: -8,
          attack_ms: 200,
          release_ms: 500,
        },
      }
    : null;

  const requested = transitions.filter((r, k) => k < transitions.length - 1 && (r.downgraded !== null || r.kind !== "cut")).length;
  const downgraded = transitions.flatMap((r, k) => (r.downgraded ? [{ before_order: k + 1, reason: r.downgraded }] : []));

  return {
    schema_version: "harness.composition/v1",
    output: { width: t.canvas.width, height: t.canvas.height, fps: t.fps, codec: "h264" },
    voice,
    language: t.language,
    total_seconds: layout.duration,
    request_id: `req_${stableUlid(`production:${t.production_id}`)}`,
    brand: null,
    segments: layout.clips.map((c, order) => ({
      order,
      source_id: studioSourceId(c.asset_id),
      source_path: `asset:${c.asset_id}`,
      in: c.in,
      out: r3(c.source_out),
      start: c.start,
      end: c.end,
      fit: "scale_pad" as const,
      // a clip muted on its own (cut 1.1.0) is silent; every render worker reads this per segment
      has_audio: hasAudio && !c.muted,
      transition_out: { kind: transitions[order]!.kind, seconds: transitions[order]!.seconds, tail_available: transitions[order]!.tail_available },
    })),
    text_events: textEvents,
    captions,
    narration: spoken.narration.map((n) => ({ line_id: n.line_id, wav: n.wav, start: n.start, end: n.end })),
    music,
    logo: null,
    transitions: { requested, applied: requested - downgraded.length, downgraded },
    text_dropped: [],
    warnings,
  };
}

/** Three {t_s, text} thumbnail moments.  Each is the middle of the chosen asset's clip in the layout,
 *  or evenly-spaced if the kit's asset is not in the timeline. */
export function thumbnailTimes(
  t: AnyTimeline,
  kit: YoutubeKit,
): Array<{ t_s: number; text: string }> {
  const layout = layoutTimeline(t);
  return kit.thumbnails.map((thumb) => {
    const clip = layout.clips.find((c) => c.asset_id === thumb.asset_id);
    const t_s = clip ? r3(clip.start + clip.duration / 2) : r3(layout.duration / 2);
    return { t_s, text: thumb.text };
  });
}
