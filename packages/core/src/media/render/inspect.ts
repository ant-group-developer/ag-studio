/** The check of a finished render (plan 2026-10-15 feedback-vps §2.1): the render worker runs it on the file it
 * just uploaded, so the agent and people learn that a preview froze at 13:21 or went silent without watching all
 * 17 minutes. One ffmpeg pass over a downscaled picture and the audio:
 *
 *   - `freezedetect` and `blackdetect` on the picture at 10 fps, 320 px wide;
 *   - `silencedetect`, and `ebur128` momentary loudness written to a file, read per composition segment;
 *   - contact sheets from the same picture: one frame every 10 s, 5x4 tiles (`sheet-NN.jpg`);
 *   - with narration, the level of two bands of the sound every 10 ms (`onset-lo.txt`, `onset-hi.txt`): the start of
 *     every line is compared with the others' (`repeatedOnsets`), since a voice sample that leaks into the TTS opens
 *     every line with the same sound (2026-10-27, "outch" before each of 153 lines).
 *
 * `inspectArgs`, `parseDetections`, `parseMomentary`, `parseLevels`, `segmentLoudness`, `repeatedOnsets` and
 * `inspectionIssues` are pure;
 * `inspectRender` runs the pass and writes `inspect.json` next to the sheets. */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RenderInspectionSchema, type Clock, type Composition, type RenderInspectIssue, type RenderInspection } from "@harness/contracts";
import { round3 } from "../time.js";
import { runFfmpegPass, type SpawnFn } from "./run.js";

export const INSPECT_FILE = "inspect.json";
/** One frame every `every_s` seconds, `columns` x `rows` tiles per sheet, each `tile_width` px wide. */
export const INSPECT_SHEET = { every_s: 10, columns: 5, rows: 4, tile_width: 320 } as const;
const LOUDNESS_FILE = "loudness.txt";
/** Picture analysis rate: enough for a freeze or a black of a second, a tenth of the decode work of 30 fps. */
const ANALYSIS_FPS = 10;
const FREEZE = { noise_db: -60, min_s: 2 };
const BLACK = { min_s: 1, pix_th: 0.1 };
const SILENCE = { noise_db: -50, min_s: 2 };

/** How far a stream may sit from `total_seconds` (the render worker's `duration_mismatch` uses the same). */
const DURATION_TOLERANCE_S = 0.5;
/** A frozen picture this long inside one clip may be a still shot; across a cut it never is. */
const FREEZE_IN_CLIP_S = 5;
/** A freeze must cover a cut by this much on each side to count as crossing it (a dissolve still moves). */
const CUT_MARGIN_S = 0.3;
/** Black shorter than this, or a fade at either end of the episode, says nothing. */
const BLACK_WARN_S = 1.5;
const SILENCE_WARN_S = 3;
/** Share of the episode silent from which the whole episode is said to be silent. */
const SILENT_EPISODE = 0.9;
/** A segment this much louder or quieter than the median segment stands out. */
const CLIP_LOUDNESS_DB = 8;
const CLIP_LOUDNESS_MIN_S = 3;
/** Momentary loudness below this is silence (the EBU R128 absolute gate). */
const GATE_LUFS = -70;
/** `ebur128`'s momentary window: a value at `t` covers `(t - 0.4, t]`. */
const MOMENTARY_S = 0.4;
/** The two bands of a line's opening, each read as a level every 10 ms: the voice (600 Hz) and its "ch" (4.5 kHz). */
const ONSET_FILES = { lo: "onset-lo.txt", hi: "onset-hi.txt" } as const;
const ONSET = {
  frame_s: 0.01,
  /** Where a line's first sound is looked for, around its `start`, and the quiet it rises from (before it). */
  search_s: [-0.05, 0.35] as const,
  floor_s: 0.3,
  rise_db: 10,
  /** The opening compared: 0.6 s from the first sound, both bands. */
  window_s: 0.6,
  /** Two openings alike: correlation of their shapes. A line is alike when that share of the other lines is. */
  correlation: 0.75,
  alike_share: 0.2,
  /** Lines alike before the render is said to open every line with one sound. */
  min_lines: 3,
  min_share: 0.3,
  silent_db: -90,
} as const;

export interface Span {
  start: number;
  end: number;
}

/** The ffmpeg argv of the inspection pass. Runs in the directory the sheets and the loudness file go to: their names
 * are relative, so no drive letter (`C:`) lands in a filter option. */
export function inspectArgs(p: { ffmpeg: string; input: string; hasAudio: boolean; onsets?: boolean }): string[] {
  const s = INSPECT_SHEET;
  const video = [
    `[0:v]fps=${ANALYSIS_FPS},scale=${s.tile_width}:-2,split=2[v1][v2]`,
    `[v1]freezedetect=n=${FREEZE.noise_db}dB:d=${FREEZE.min_s},blackdetect=d=${BLACK.min_s}:pix_th=${BLACK.pix_th},nullsink`,
    // the first frame, then the first one at least `every_s` later (`fps=1/10` gives none for a file under 10 s)
    `[v2]select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${s.every_s - 0.05})',tile=${s.columns}x${s.rows}[sheet]`,
  ];
  // a band's level every 10 ms: `asetnsamples` makes 10 ms frames, `astats` with `reset=1` measures each one
  const level = (rate: number, file: string) =>
    `aresample=${rate},asetnsamples=n=${Math.round(rate * ONSET.frame_s)}:p=0,astats=metadata=1:reset=1:measure_overall=none:measure_perchannel=RMS_level,ametadata=mode=print:key=lavfi.astats.1.RMS_level:file=${file},anullsink`;
  const loudness = `silencedetect=noise=${SILENCE.noise_db}dB:d=${SILENCE.min_s},ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=${LOUDNESS_FILE}[aout]`;
  const audio = !p.hasAudio
    ? []
    : p.onsets
      ? [
        "[0:a]asplit=2[a1][a2]",
        `[a1]${loudness}`,
        "[a2]aformat=channel_layouts=mono,asplit=2[b1][b2]",
        `[b1]bandpass=f=600:width_type=h:w=800,${level(4000, ONSET_FILES.lo)}`,
        `[b2]bandpass=f=4500:width_type=h:w=3000,${level(16000, ONSET_FILES.hi)}`,
      ]
      : [`[0:a]${loudness}`];
  return [
    p.ffmpeg, "-hide_banner", "-nostats", "-y", "-i", p.input,
    "-filter_complex", [...video, ...audio].join(";"),
    // passthrough: a sheet is one frame every 200 s; at a constant rate the image muxer repeats it for every frame
    // in between (599 sheets for an 18-minute video)
    "-map", "[sheet]", "-fps_mode", "passthrough", "-q:v", "4", "sheet-%02d.jpg",
    ...(p.hasAudio ? ["-map", "[aout]", "-f", "null", "-"] : []),
  ];
}

/** Pairs `<x>_start` / `<x>_end` values in order; a start never ended runs to `end`. */
function pair(events: { kind: "start" | "end"; t: number }[], end: number): Span[] {
  const spans: Span[] = [];
  let open: number | null = null;
  for (const e of events) {
    if (e.kind === "start") open ??= Math.max(0, e.t);
    else if (open !== null) {
      spans.push({ start: round3(open), end: round3(e.t) });
      open = null;
    }
  }
  if (open !== null && end > open) spans.push({ start: round3(open), end: round3(end) });
  return spans;
}

/** Freezes, blacks and silences from the pass's stderr lines; `end` closes one still running at the end of the file. */
export function parseDetections(lines: readonly string[], end: number): { freezes: Span[]; blacks: Span[]; silences: Span[] } {
  const freeze: { kind: "start" | "end"; t: number }[] = [];
  const silence: { kind: "start" | "end"; t: number }[] = [];
  const blacks: Span[] = [];
  for (const line of lines) {
    let m = /freezedetect\.freeze_(start|end): (-?[\d.]+)/.exec(line);
    if (m) freeze.push({ kind: m[1] as "start" | "end", t: Number(m[2]) });
    m = /silence_(start|end): (-?[\d.]+)/.exec(line);
    if (m) silence.push({ kind: m[1] as "start" | "end", t: Number(m[2]) });
    m = /black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/.exec(line);
    if (m) blacks.push({ start: round3(Math.max(0, Number(m[1]))), end: round3(Number(m[2])) });
  }
  return { freezes: pair(freeze, end), blacks, silences: pair(silence, end) };
}

/** `ametadata` print lines (`frame:… pts_time:T` then `lavfi.r128.M=V`) as momentary loudness points. */
export function parseMomentary(text: string): { t: number; m: number }[] {
  const points: { t: number; m: number }[] = [];
  let t: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const time = /pts_time:(-?[\d.]+)/.exec(line);
    if (time) {
      t = Number(time[1]);
      continue;
    }
    const value = /lavfi\.r128\.M=(-?[\d.]+|-inf|inf|nan)/.exec(line);
    if (value && t !== null) {
      const m = Number(value[1]);
      points.push({ t, m: Number.isFinite(m) ? m : -Infinity });
      t = null;
    }
  }
  return points;
}

/** `ametadata` print lines of `astats`' `RMS_level` as levels (dBFS) by time; silence (`-inf`) is `ONSET.silent_db`. */
export function parseLevels(text: string): { t: number; db: number }[] {
  const points: { t: number; db: number }[] = [];
  let t: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const time = /pts_time:(-?[\d.]+)/.exec(line);
    if (time) {
      t = Number(time[1]);
      continue;
    }
    const value = /lavfi\.astats\.1\.RMS_level=(-?[\d.]+|-inf|inf|nan)/.exec(line);
    if (value && t !== null) {
      const db = Number(value[1]);
      points.push({ t, db: Number.isFinite(db) ? Math.max(db, ONSET.silent_db) : ONSET.silent_db });
      t = null;
    }
  }
  return points;
}

/** What `repeatedOnsets` found: how many lines open with a sound alike to many other lines', of how many measured. */
export interface OnsetRepeat {
  alike: number;
  lines: number;
  /** The first such line's start. */
  start: number | null;
}

/**
 * Whether the lines of the narration open with the same sound. For each line, its first sound near `start` (a rise of
 * `rise_db` over the quiet before it, in either band) and the 0.6 s after it, as a shape of both bands' levels; a line
 * is alike when its shape matches (correlation >= 0.75) a fifth of the other lines. On the "outch" render 64% of the
 * lines were alike, on the real words after it none.
 */
export function repeatedOnsets(lo: readonly { t: number; db: number }[], hi: readonly { t: number; db: number }[], starts: readonly number[]): OnsetRepeat {
  const frames = (points: readonly { t: number; db: number }[]) => {
    const out: number[] = [];
    for (const p of points) out[Math.round(p.t / ONSET.frame_s)] = p.db;
    return out;
  };
  const a = frames(lo);
  const b = frames(hi);
  const at = (xs: number[], k: number) => xs[k] ?? ONSET.silent_db;
  const quiet = (xs: number[], from: number, to: number) => {
    const v: number[] = [];
    for (let k = Math.max(0, from); k < to; k++) v.push(at(xs, k));
    v.sort((x, y) => x - y);
    return v.length > 0 ? v[Math.floor(v.length / 4)]! : ONSET.silent_db;
  };
  const f = (s: number) => Math.round(s / ONSET.frame_s);
  const width = f(ONSET.window_s);
  const shapes: { start: number; v: number[] }[] = [];
  for (const s of [...starts].sort((x, y) => x - y)) {
    const from = f(s + ONSET.search_s[0]);
    const floorA = quiet(a, from - f(ONSET.floor_s), from);
    const floorB = quiet(b, from - f(ONSET.floor_s), from);
    let first: number | null = null;
    for (let k = from; k < f(s + ONSET.search_s[1]); k++) {
      if (at(a, k) > floorA + ONSET.rise_db || at(b, k) > floorB + ONSET.rise_db) {
        first = k;
        break;
      }
    }
    if (first === null) continue;
    // each band about its own mean: the gap between the bands' levels is alike in every line and says nothing
    const band = (xs: number[]) => {
      const v: number[] = [];
      for (let k = first!; k < first! + width; k++) v.push(at(xs, k));
      const mean = v.reduce((x, y) => x + y, 0) / v.length;
      return v.map((x) => x - mean);
    };
    const c = [...band(a), ...band(b)];
    const norm = Math.sqrt(c.reduce((x, y) => x + y * y, 0)) || 1;
    shapes.push({ start: s, v: c.map((x) => x / norm) });
  }
  const alike = shapes.filter((x, i) => {
    let n = 0;
    shapes.forEach((y, j) => {
      if (j !== i && x.v.reduce((sum, p, k) => sum + p * y.v[k]!, 0) >= ONSET.correlation) n++;
    });
    return shapes.length > 1 && n >= ONSET.alike_share * (shapes.length - 1);
  });
  return { alike: alike.length, lines: shapes.length, start: alike[0] ? round3(alike[0].start) : null };
}

/** Each segment's loudness: momentary values whose window lies inside the segment, gated at -70 LUFS, averaged as
 * energy; null when nothing is above the gate. */
export function segmentLoudness(points: readonly { t: number; m: number }[], segments: readonly { order: number; start: number; end: number }[]): { order: number; start: number; end: number; lufs: number | null }[] {
  return segments.map((s) => {
    let energy = 0;
    let n = 0;
    for (const p of points) {
      if (p.t - MOMENTARY_S < s.start - 1e-6 || p.t > s.end + 1e-6 || !(p.m > GATE_LUFS)) continue;
      energy += 10 ** (p.m / 10);
      n++;
    }
    return { order: s.order, start: round3(s.start), end: round3(s.end), lufs: n > 0 ? Math.round(100 * Math.log10(energy / n)) / 10 : null };
  });
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

type InspectionFacts = Pick<RenderInspection, "expected_seconds" | "video_seconds" | "audio_seconds" | "freezes" | "blacks" | "silences" | "segments" | "loudness_median_lufs">;

/** What the composition asked of a segment's own sound: none (`has_audio: false`, a muted clip), or turned by `gain_db`. */
export type SegmentSoundIntent = { order: number; has_audio?: boolean; gain_db?: number | undefined };

/** The segments whose loudness says how the render sounds as a whole: they play their own sound as it is. */
function asIs(intent: ReadonlyMap<number, SegmentSoundIntent>, order: number): boolean {
  const i = intent.get(order);
  return i?.has_audio !== false && !i?.gain_db;
}

/**
 * What is wrong with a render, from its measurements, earliest first (a `duration` issue leads). `intent` (the
 * composition's segments): a clip the timeline muted is not compared, one it turned up or down is compared with where
 * its gain puts it.
 */
export function inspectionIssues(f: InspectionFacts, intent: readonly SegmentSoundIntent[] = [], onsets: OnsetRepeat | null = null): RenderInspectIssue[] {
  const intentOf = new Map(intent.map((i) => [i.order, i]));
  const issues: RenderInspectIssue[] = [];
  const measured = [f.video_seconds, f.audio_seconds].filter((s): s is number => s !== null);
  if (measured.length > 0) {
    const worst = measured.reduce((a, b) => (Math.abs(b - f.expected_seconds) > Math.abs(a - f.expected_seconds) ? b : a));
    if (Math.abs(worst - f.expected_seconds) > DURATION_TOLERANCE_S) issues.push({ code: "duration", severity: "error", expected_s: round3(f.expected_seconds), actual_s: round3(worst) });
  }
  const total = f.video_seconds ?? f.expected_seconds;
  const segmentAt = (t: number): number | undefined => f.segments.find((s) => t >= s.start - 1e-6 && t < s.end)?.order ?? f.segments.at(-1)?.order;
  const cuts = f.segments.slice(1).map((s) => s.start);
  const timed: RenderInspectIssue[] = [];

  for (const z of f.freezes) {
    const crossesCut = cuts.some((c) => c > z.start + CUT_MARGIN_S && c < z.end - CUT_MARGIN_S);
    const toEnd = z.end >= total - DURATION_TOLERANCE_S;
    if (!crossesCut && z.end - z.start < FREEZE_IN_CLIP_S) continue;
    const order = segmentAt(z.start);
    timed.push({ code: "freeze", severity: crossesCut ? "error" : "warning", start: z.start, end: z.end, ...(order !== undefined ? { order } : {}), ...(toEnd ? { to_end: true } : {}) });
  }
  for (const b of f.blacks) {
    const fade = (b.start <= 0.1 || b.end >= total - 0.1) && b.end - b.start <= BLACK_WARN_S * 2;
    if (b.end - b.start < BLACK_WARN_S || fade) continue;
    const order = segmentAt(b.start);
    timed.push({ code: "black", severity: "warning", start: b.start, end: b.end, ...(order !== undefined ? { order } : {}) });
  }
  const silent = f.silences.reduce((n, s) => n + (s.end - s.start), 0);
  if (total > 0 && silent >= SILENT_EPISODE * total) {
    timed.push({ code: "silence", severity: "error", start: 0, end: round3(total) });
  } else {
    for (const s of f.silences) {
      if (s.end - s.start < SILENCE_WARN_S) continue;
      timed.push({ code: "silence", severity: "warning", start: s.start, end: s.end });
    }
  }
  const med = f.loudness_median_lufs;
  const compared = f.segments.filter((s) => s.lufs !== null && s.end - s.start >= CLIP_LOUDNESS_MIN_S && intentOf.get(s.order)?.has_audio !== false);
  if (med !== null && compared.length >= 3) {
    for (const s of compared) {
      const delta = Math.round((s.lufs! - med - (intentOf.get(s.order)?.gain_db ?? 0)) * 10) / 10;
      if (Math.abs(delta) >= CLIP_LOUDNESS_DB) timed.push({ code: "clip_loudness", severity: "warning", start: s.start, end: s.end, order: s.order, delta_db: delta });
    }
  }
  // the voice sample leaking into the TTS: the same sound before the words of many lines
  if (onsets && onsets.alike >= ONSET.min_lines && onsets.alike >= ONSET.min_share * onsets.lines) {
    timed.push({ code: "repeated_onset", severity: "warning", ...(onsets.start !== null ? { start: onsets.start } : {}), lines: onsets.alike, of_lines: onsets.lines });
  }
  timed.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  return [...issues, ...timed];
}

/** The median loudness of the segments long enough to say something (`CLIP_LOUDNESS_MIN_S`). */
export function medianSegmentLoudness(segments: readonly { start: number; end: number; lufs: number | null }[]): number | null {
  const m = median(segments.filter((s) => s.lufs !== null && s.end - s.start >= CLIP_LOUDNESS_MIN_S).map((s) => s.lufs!));
  return m === null ? null : Math.round(m * 10) / 10;
}

/** The sheets in `dir`, in order, with the moments their tiles show. */
function sheetsIn(dir: string, seconds: number): RenderInspection["sheets"] {
  const s = INSPECT_SHEET;
  const perSheet = s.columns * s.rows;
  const frames = Math.max(1, Math.floor(Math.max(0, seconds - 0.001) / s.every_s) + 1);
  return readdirSync(dir)
    .filter((f) => /^sheet-\d+\.jpg$/.test(f))
    .sort()
    .map((file, i) => ({
      file, from_s: i * perSheet * s.every_s, every_s: s.every_s, columns: s.columns, rows: s.rows,
      frames: Math.max(0, Math.min(perSheet, frames - i * perSheet)), tile_width: s.tile_width,
    }));
}

export interface InspectDeps {
  ffmpeg: string;
  clock: Clock;
  spawn?: SpawnFn;
}

export interface InspectInput {
  /** The rendered episode. */
  episodePath: string;
  composition: Composition;
  /** Where `inspect.json` and `sheet-NN.jpg` go (emptied of older sheets first). */
  outDir: string;
  hasAudio: boolean;
  /** The file's streams as measured (ffprobe); null: not measured. */
  videoSeconds: number | null;
  audioSeconds: number | null;
  timeoutSeconds: number;
  signal?: AbortSignal;
}

/** Runs the inspection pass over a rendered episode; writes `inspect.json` and the sheets into `outDir`. */
export async function inspectRender(d: InspectDeps, p: InspectInput): Promise<{ inspection: RenderInspection; path: string; sheets: string[] }> {
  const startedAt = Date.parse(d.clock.now());
  const outDir = resolve(p.outDir);
  mkdirSync(outDir, { recursive: true });
  const levelFiles: string[] = [ONSET_FILES.lo, ONSET_FILES.hi];
  for (const f of readdirSync(outDir)) if (/^sheet-\d+\.jpg$/.test(f) || f === LOUDNESS_FILE || levelFiles.includes(f)) rmSync(join(outDir, f), { force: true });

  const narration = p.composition.narration ?? [];
  const onsets = p.hasAudio && narration.length >= ONSET.min_lines;
  const lines: string[] = [];
  await runFfmpegPass(d.spawn ?? nodeSpawn, inspectArgs({ ffmpeg: d.ffmpeg, input: resolve(p.episodePath), hasAudio: p.hasAudio, onsets }), p.timeoutSeconds, "render inspection", {
    cwd: outDir, signal: p.signal,
    onStderrLine: (l) => {
      if (/freeze_|silence_|black_start/.test(l)) lines.push(l);
    },
  });

  const end = p.videoSeconds ?? p.composition.total_seconds;
  const detections = parseDetections(lines, end);
  const loudnessPath = join(outDir, LOUDNESS_FILE);
  const points = existsSync(loudnessPath) ? parseMomentary(readFileSync(loudnessPath, "utf8")) : [];
  rmSync(loudnessPath, { force: true });
  const levels = (file: string) => {
    const path = join(outDir, file);
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    rmSync(path, { force: true });
    return parseLevels(text);
  };
  const repeat = onsets ? repeatedOnsets(levels(ONSET_FILES.lo), levels(ONSET_FILES.hi), narration.map((n) => n.start)) : null;
  const segments = segmentLoudness(points, [...p.composition.segments].sort((a, b) => a.order - b.order));
  const intent: SegmentSoundIntent[] = p.composition.segments.map((s) => ({ order: s.order, has_audio: s.has_audio, gain_db: s.gain_db }));
  const intentOf = new Map(intent.map((i) => [i.order, i]));
  // the median of the clips as they are: muted clips (music only) and turned ones would pull it away
  const plain = segments.filter((s) => asIs(intentOf, s.order));
  const facts: InspectionFacts = {
    expected_seconds: round3(p.composition.total_seconds), video_seconds: p.videoSeconds === null ? null : round3(p.videoSeconds),
    audio_seconds: p.audioSeconds === null ? null : round3(p.audioSeconds), ...detections, segments,
    loudness_median_lufs: medianSegmentLoudness(plain) ?? medianSegmentLoudness(segments),
  };
  const sheets = sheetsIn(outDir, end);
  const finishedAt = Date.parse(d.clock.now());
  const inspection = RenderInspectionSchema.parse({
    schema_version: "harness.render-inspect/v1", ...facts, ...(repeat ? { narration_onsets: repeat } : {}), sheets, issues: inspectionIssues(facts, intent, repeat),
    inspect_seconds: Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? round3(Math.max(0, (finishedAt - startedAt) / 1000)) : 0,
  });
  const path = join(outDir, INSPECT_FILE);
  writeFileSync(path, JSON.stringify(inspection, null, 2));
  return { inspection, path, sheets: sheets.map((s) => join(outDir, s.file)) };
}
