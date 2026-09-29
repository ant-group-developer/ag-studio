/**
 * Timeline v2 -> the render worker's `composition.json` (`harness.composition/v1`), and -> SRT/VTT.
 *
 * Segment times in the composition are ASSET-absolute: ag-go's `/footage/segments/resolve` hands back a URL of
 * the whole file (original, proxy or watermarked preview) plus where the segment sits in it, so
 * `in = start_ms/1000 + src_in`. Narration WAVs and music are logical inputs the render worker signs through
 * Studio's `/farm/sign` (`stage:` for files the executor uploads per attempt, `library:` for team assets).
 */
import { createHash } from "node:crypto";
import type { Composition, TimelineV2 } from "@harness/contracts";
import { layoutTimeline, type TimelineLayout } from "./layout.js";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Stable ULID-shaped id derived from a string, so the same segment keeps its mezzanine cache entry. */
export function stableUlid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest();
  let out = "";
  for (let i = 0; i < 26; i++) out += CROCKFORD[bytes[i]! % 32];
  // the first char of a ULID encodes the top 3 bits of a 48-bit time; keep it in 0..7
  return CROCKFORD[bytes[0]! % 8] + out.slice(1);
}

export const MAX_CHARS_PER_LINE = 42;
export const MAX_LINES_PER_CUE = 2;

export interface Cue { index: number; start: number; end: number; lines: string[] }

/** Split one narration line into cues of at most 2 x 42 characters, timed by character share. */
export function cuesFor(layout: TimelineLayout): Cue[] {
  const cues: Cue[] = [];
  for (const l of layout.lines) {
    if (l.estimated) continue;
    const words = l.text.split(/\s+/).filter(Boolean);
    const rows: string[] = [];
    let row = "";
    for (const w of words) {
      if (row && (row + " " + w).length > MAX_CHARS_PER_LINE) { rows.push(row); row = w; } else row = row ? `${row} ${w}` : w;
    }
    if (row) rows.push(row);
    const chunks: string[][] = [];
    for (let i = 0; i < rows.length; i += MAX_LINES_PER_CUE) chunks.push(rows.slice(i, i + MAX_LINES_PER_CUE));
    const total = chunks.reduce((s, c) => s + c.join(" ").length, 0) || 1;
    let t = l.start;
    for (const c of chunks) {
      const d = (l.end - l.start) * (c.join(" ").length / total);
      cues.push({ index: cues.length + 1, start: r3(t), end: r3(t + d), lines: c });
      t += d;
    }
  }
  return cues;
}

function stamp(seconds: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function cuesToSrt(cues: Cue[]): string {
  return cues.map((c) => `${c.index}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.lines.join("\n")}\n`).join("\n");
}
export function cuesToVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.lines.join("\n")}\n`).join("\n")}`;
}

export interface CompositionOptions {
  /** Logical input name for a narration WAV key, e.g. `stage:audio/<sha>.wav`. */
  audioInput: (key: string) => string;
}

export function timelineToComposition(t: TimelineV2, opts: CompositionOptions): Composition {
  const layout = layoutTimeline(t);
  const hasAudio = !t.source_audio.muted;
  const voiced = layout.lines.filter((l) => l.audio);
  const cues = cuesFor(layout);
  return {
    schema_version: "harness.composition/v1",
    output: { width: t.canvas.width, height: t.canvas.height, fps: t.fps, codec: "h264" },
    voice: voiced.length ? "tts" : "none",
    language: t.language,
    total_seconds: layout.duration,
    request_id: `req_${stableUlid(`production:${t.production_id}`)}`,
    brand: null,
    segments: layout.clips.map((c, order) => {
      const seg = t.segments[c.segment_id]!;
      const base = seg.start_ms / 1000;
      return {
        order,
        source_id: `src_${stableUlid(`segment:${c.segment_id}`)}`,
        source_path: `segment:${c.segment_id}`,
        in: r3(base + c.src_in),
        out: r3(base + c.src_out),
        start: c.start,
        end: c.end,
        fit: "scale_pad" as const,
        has_audio: hasAudio,
        transition_out: { kind: "cut" as const, seconds: 0, tail_available: false },
      };
    }),
    text_events: layout.texts.map((x) => ({ id: x.text_id, kind: x.kind, text: x.text, start: x.start, end: Math.min(x.end, layout.duration), position: x.position, animation: "fade" as const })),
    captions: t.captions.enabled
      ? { mode: "burn-in" as const, cues: cues.map((c) => ({ index: c.index, start: c.start, end: c.end, lines: c.lines, raise_px: 0, words: [] })) }
      : { mode: "none" as const, cues: [], reason: "captions disabled in the editor" },
    music: t.music ? {
      track_id: t.music.track.split("/").pop()!.replace(/\.[^.]+$/, "") || "music",
      path: t.music.track,
      loop: true,
      fade_in: 1,
      fade_out: 1.5,
      cues: [{ start: 0, end: layout.duration, gain_db: t.music.gain_db }],
      duck: { windows: t.music.ducking ? voiced.map((l) => ({ start: l.start, end: l.end })) : [], gain_db: -12, attack_ms: 150, release_ms: 600 },
    } : null,
    logo: null,
    narration: voiced.map((l) => ({ line_id: l.line_id, wav: opts.audioInput(l.audio!.key), start: l.start, end: l.end })),
    transitions: { requested: 0, applied: 0, downgraded: [] },
    text_dropped: [],
    warnings: [],
  };
}
