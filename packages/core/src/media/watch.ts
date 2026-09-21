import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  HarnessError,
  WatchIndexSchema,
  watchTranscriptSchema,
  type MediaProbe,
  type MediaProber,
  type WatchFrame,
  type WatchIndex,
  type WatchTranscript,
  type WatchVideo,
} from "@harness/contracts";

export type WatchMode = "samples" | "source" | "episode";

export const WATCH_DEFAULTS: Record<WatchMode, { interval_seconds: number; max_frames: number }> = {
  samples: { interval_seconds: 8, max_frames: 60 },
  source: { interval_seconds: 10, max_frames: 120 },
  episode: { interval_seconds: 15, max_frames: 80 },
};

/** shot_marks: add a frame at each of these marks (kind "scene"), in addition to detected scene changes. */
export interface WatchVideoInput {
  label: string;
  path: string;
  shot_marks?: number[];
  /** sub-project 5A: this video's kho source id, when it has one -- the key `transcriptBySource` is looked
   * up by (falling back to `label` when unset), since a multi-source `watch` keys transcripts by source_id,
   * not by the display label. */
  source_id?: string;
}

export type WatchLogFn = (level: "info" | "warn", msg: string, data?: Record<string, unknown>) => void;

/** A video whose frames are already on disk (the `collect-samples` shape: one still per mark, no ffmpeg). */
export interface PreExtractedVideo {
  label: string;
  source_path: string;
  /** Absolute paths of the already-extracted frames, in time order. */
  frames: string[];
}

export interface WatchDeps {
  prober: MediaProber;
  /** ffmpeg binary name/path; defaults to "ffmpeg" on PATH. */
  ffmpeg?: string;
  transcribe?: { argv: string[]; cwd: string; timeout_seconds: number; env?: Record<string, string> };
  log?: WatchLogFn;
}

export interface WatchOptions {
  mode: WatchMode;
  outDir: string;
  interval_seconds?: number;
  max_frames?: number;
  /** ffmpeg select=gt(scene,threshold) sensitivity, 0..1; defaults to 0.3. */
  scene_threshold?: number;
  /** frame width in pixels, scaled with -2 for height (even, aspect-preserving); defaults to 640. */
  frame_width?: number;
  /** sub-project 5A: total contact sheets to spend across every video in this call, allocated proportionally
   * to duration (see `distributeSheetBudget`). Unset keeps the SP4 behavior: each video gets as many sheets
   * as its frame count needs (grouped `CONTACT_SHEET_GROUP_SIZE` at a time), with no cross-video budget. */
  max_sheets?: number;
  /** sub-project 5A: transcripts already produced by the `transcribe` stage, keyed by `WatchVideoInput.source_id`
   * (or `label` when a video has no `source_id`). When a video's key is present here, that transcript is used
   * as-is and `WatchDeps.transcribe` is never invoked for it. */
  transcriptBySource?: Record<string, WatchTranscript>;
}

const DEDUPE_WINDOW_SECONDS = 1;
const CONTACT_SHEET_GROUP_SIZE = 16;
const CONTACT_SHEET_MAX_COLS = 4;
const FFMPEG_TIMEOUT_MS = 300_000;

const noopLog: WatchLogFn = () => {};

/**
 * A binary that could not be started at all shows up on `spawnSync`'s return as `error` (ENOENT when ffmpeg
 * is not on PATH, EACCES when it is there but not executable) with no `signal`; a run that started and was
 * killed by the `timeout` option sets `signal` instead. The first case is a machine/config problem for the
 * whole stage -- degrading it into "this frame just didn't come out" is what let a studio with ffprobe but no
 * ffmpeg produce a SUCCEEDED, completely empty `watch/` (final-review finding I-2) -- so it throws, while a
 * per-frame non-zero exit or timeout stays a warning the caller handles.
 */
function assertFfmpegSpawned(ffmpeg: string, r: SpawnSyncReturns<string>): void {
  if (!r.error || r.signal) return;
  throw new HarnessError("CONFIG_INVALID", `ffmpeg not available: cannot run "${ffmpeg}": ${r.error.message}`, { ffmpeg });
}

/** ffmpeg select=gt(scene,thr),showinfo -> pts_time[] (seconds, ascending). Frames below `threshold` scene-change
 * score never appear in showinfo output, so every parsed pts_time is a detected cut. Throws `CONFIG_INVALID`
 * when ffmpeg itself cannot be spawned (see `assertFfmpegSpawned`); an ffmpeg that ran and found nothing
 * still returns an empty array. */
export function detectSceneChanges(ffmpeg: string, path: string, threshold: number): number[] {
  const vf = `select='gt(scene\\,${threshold})',showinfo`;
  const r = spawnSync(ffmpeg, ["-i", path, "-vf", vf, "-f", "null", "-"], { timeout: FFMPEG_TIMEOUT_MS, encoding: "utf8" });
  assertFfmpegSpawned(ffmpeg, r);
  const stderr = r.stderr ?? "";
  const times = new Set<number>();
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) times.add(Math.round(t * 10) / 10);
  }
  return Array.from(times).sort((a, b) => a - b);
}

/** Picks up to `k` elements from a sorted array, evenly spread by index (always keeping the first and last
 * when k >= 2); used to thin both interval and scene candidates once they exceed the frame budget. */
function thinEvenly<T>(arr: T[], k: number): T[] {
  if (k <= 0) return [];
  if (arr.length <= k) return arr.slice();
  if (k === 1) return [arr[0]!];
  const indices = new Set<number>();
  for (let i = 0; i < k; i++) {
    indices.add(Math.round((i * (arr.length - 1)) / (k - 1)));
  }
  // Rounding can collide on nearby indices when arr.length is only slightly above k; backfill from the front
  // so the result always has exactly k elements (never fewer because two rounded indices landed on the same spot).
  let next = 0;
  while (indices.size < k && next < arr.length) {
    indices.add(next);
    next++;
  }
  return Array.from(indices).sort((a, b) => a - b).map((i) => arr[i]!);
}

function dedupeSorted(times: number[]): number[] {
  const out: number[] = [];
  for (const t of times) {
    if (out.length === 0 || t - out[out.length - 1]! >= DEDUPE_WINDOW_SECONDS) out.push(t);
  }
  return out;
}

/** Merges scene + interval, dedupes within 1s (scene wins ties over interval), and thins interval marks
 * first (keeping them evenly spread) before thinning scene marks evenly once still over max_frames. */
export function pickFrameTimes(p: {
  duration: number;
  scene: number[];
  marks: number[];
  interval_seconds: number;
  max_frames: number;
}): { t: number; kind: "scene" | "interval" }[] {
  const inRange = (t: number) => t >= 0 && t <= p.duration;
  const sceneRaw = [...p.scene, ...p.marks].filter(inRange).sort((a, b) => a - b);
  let sceneKept = dedupeSorted(sceneRaw);

  const intervalRaw: number[] = [];
  if (p.interval_seconds > 0) {
    for (let t = 0; t <= p.duration; t += p.interval_seconds) intervalRaw.push(Math.round(t * 10) / 10);
  }
  let intervalKept = intervalRaw.filter((t) => sceneKept.every((s) => Math.abs(t - s) >= DEDUPE_WINDOW_SECONDS));

  if (sceneKept.length + intervalKept.length > p.max_frames) {
    const intervalBudget = Math.max(0, p.max_frames - sceneKept.length);
    intervalKept = thinEvenly(intervalKept, intervalBudget);
  }
  if (sceneKept.length + intervalKept.length > p.max_frames) {
    sceneKept = thinEvenly(sceneKept, p.max_frames);
  }

  const merged = [
    ...sceneKept.map((t) => ({ t, kind: "scene" as const })),
    ...intervalKept.map((t) => ({ t, kind: "interval" as const })),
  ];
  return merged.sort((a, b) => a.t - b.t);
}

export function frameFileName(t: number): string {
  return `f-${t.toFixed(1).padStart(7, "0")}.png`;
}

function relOut(outDir: string, p: string): string {
  return relative(outDir, p).split("\\").join("/");
}

/** `false` when this one frame did not come out (bad seek, corrupt region, timeout); throws `CONFIG_INVALID`
 * when ffmpeg could not be spawned at all, since every other frame would fail the same way. */
function extractFrame(ffmpeg: string, sourcePath: string, t: number, frameWidth: number, outPath: string): boolean {
  const r = spawnSync(
    ffmpeg,
    ["-y", "-ss", String(t), "-i", sourcePath, "-frames:v", "1", "-vf", `scale=${frameWidth}:-2`, outPath],
    { timeout: FFMPEG_TIMEOUT_MS, encoding: "utf8" },
  );
  assertFfmpegSpawned(ffmpeg, r);
  return r.status === 0 && existsSync(outPath);
}

/** Builds one contact sheet from a group of <=16 frames: copies them into a temp numbered sequence (padding
 * with the last frame if the group isn't a perfect rectangle), tries to burn a timestamp label onto each copy,
 * tiles them with ffmpeg's `tile` filter, and always cleans up the temp sequence. Falls back to an unlabeled
 * sheet (logging a warning once) when drawtext fails, e.g. no fontconfig/font on the machine. */
function buildContactSheet(ffmpeg: string, group: { t: number; absPath: string }[], sheetPath: string, log: WatchLogFn): boolean {
  if (group.length === 0) return false;
  const tmpDir = mkdtempSync(join(tmpdir(), "watch-sheet-"));
  try {
    const cols = Math.min(CONTACT_SHEET_MAX_COLS, group.length);
    const rows = Math.ceil(group.length / cols);
    const total = cols * rows;

    const tmpFrames: string[] = [];
    for (let i = 0; i < total; i++) {
      const frame = group[Math.min(i, group.length - 1)]!;
      const dst = join(tmpDir, `f-${String(i + 1).padStart(2, "0")}.png`);
      copyFileSync(frame.absPath, dst);
      tmpFrames.push(dst);
    }

    let labeled = true;
    for (let i = 0; i < group.length && labeled; i++) {
      const dst = tmpFrames[i]!;
      const labeledDst = `${dst}.labeled.png`;
      const text = `${group[i]!.t.toFixed(1)}s`;
      const r = spawnSync(
        ffmpeg,
        ["-y", "-i", dst, "-vf", `drawtext=text='${text}':x=4:y=4:fontsize=14:fontcolor=white:box=1:boxcolor=black@0.5`, labeledDst],
        { timeout: FFMPEG_TIMEOUT_MS, encoding: "utf8" },
      );
      if (r.status === 0 && existsSync(labeledDst)) {
        copyFileSync(labeledDst, dst);
      } else {
        labeled = false;
      }
    }
    if (!labeled) log("warn", "watch: drawtext label failed (no fontconfig/font?), building contact sheet without labels", { sheet: sheetPath });

    const pattern = join(tmpDir, "f-%02d.png");
    const r = spawnSync(ffmpeg, ["-y", "-framerate", "1", "-i", pattern, "-vf", `tile=${cols}x${rows}`, "-frames:v", "1", sheetPath], {
      timeout: FFMPEG_TIMEOUT_MS,
      encoding: "utf8",
    });
    if (r.status !== 0 || !existsSync(sheetPath)) {
      log("warn", "watch: contact sheet build failed", { sheet: sheetPath, stderr: r.stderr });
      return false;
    }
    return true;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Splits `arr` into exactly `min(groups, arr.length)` chunks, as evenly sized as possible (earlier chunks
 * absorbing the remainder when `arr.length` doesn't divide evenly) -- used to build exactly a video's sheet
 * budget from `distributeSheetBudget`, in place of the fixed `CONTACT_SHEET_GROUP_SIZE`-per-sheet grouping
 * used when `max_sheets` is not set. */
function chunkIntoGroups<T>(arr: T[], groups: number): T[][] {
  if (arr.length === 0 || groups <= 0) return [];
  const g = Math.min(groups, arr.length);
  const base = Math.floor(arr.length / g);
  let extra = arr.length % g;
  const result: T[][] = [];
  let idx = 0;
  for (let i = 0; i < g; i++) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    result.push(arr.slice(idx, idx + size));
    idx += size;
  }
  return result;
}

/**
 * Allocates `maxSheets` contact sheets across `durations.length` videos, proportional to each video's
 * duration, with a floor of 1 sheet per video (sub-project 5A task-3 resolution). Uses the largest-remainder
 * method (every video starts at 1, the remaining `maxSheets - n` sheets are handed out by each video's
 * fractional share, largest fraction first) so the total is exactly `maxSheets` whenever there are enough
 * sheets to go around.
 *
 * When there are at least as many videos as `maxSheets`, the 1-per-video floor alone already meets or
 * exceeds the target, so every video gets exactly 1 and the total can exceed `maxSheets` in that degenerate
 * case -- the budget is a target, not a hard cap, and giving any video 0 sheets would be worse.
 */
function distributeSheetBudget(durations: number[], maxSheets: number): number[] {
  const n = durations.length;
  if (n === 0) return [];
  if (n >= maxSheets) return durations.map(() => 1);

  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const shares = totalDuration > 0 ? durations.map((d) => d / totalDuration) : durations.map(() => 1 / n);
  const remaining = maxSheets - n;
  const extraRaw = shares.map((s) => s * remaining);
  const extra = extraRaw.map((x) => Math.floor(x));
  const allocated = extra.reduce((a, b) => a + b, 0);
  const leftover = remaining - allocated;
  const order = extraRaw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < leftover; k++) extra[order[k]!.i]! += 1;

  return durations.map((_, i) => 1 + extra[i]!);
}

function runTranscribe(
  t: NonNullable<WatchDeps["transcribe"]>,
  sourcePath: string,
  labelDir: string,
): { transcript: WatchTranscript | null; transcript_error?: string } {
  const outPath = join(labelDir, "transcript.json");
  try {
    mkdirSync(labelDir, { recursive: true });
    const [cmd, ...rest] = t.argv;
    if (!cmd) return { transcript: null, transcript_error: "transcribe.argv is empty" };
    const r = spawnSync(cmd, [...rest, "--in", sourcePath, "--out", outPath], {
      cwd: t.cwd,
      timeout: t.timeout_seconds * 1000,
      encoding: "utf8",
      env: t.env,
    });
    if (r.error) return { transcript: null, transcript_error: `spawn error: ${r.error.message}` };
    if (r.signal) return { transcript: null, transcript_error: `transcribe timed out (killed with ${r.signal})` };
    if (r.status !== 0) return { transcript: null, transcript_error: `transcribe exited ${String(r.status)}: ${(r.stderr ?? "").slice(0, 500)}` };
    if (!existsSync(outPath)) return { transcript: null, transcript_error: "transcribe did not write --out file" };
    const raw: unknown = JSON.parse(readFileSync(outPath, "utf8"));
    const parsed = watchTranscriptSchema.safeParse(raw);
    if (!parsed.success) return { transcript: null, transcript_error: `invalid transcript schema: ${parsed.error.message}` };
    return { transcript: parsed.data };
  } catch (e) {
    return { transcript: null, transcript_error: e instanceof Error ? e.message : String(e) };
  }
}

/** One frame per second (t = index), kind "interval", no contact sheets, no transcript -- the shape a
 * caller can build without ffmpeg from frames some earlier stage already extracted. */
function preExtractedVideos(outDir: string, groups: PreExtractedVideo[]): WatchVideo[] {
  return groups.map((g) => ({
    label: g.label,
    source_path: g.source_path,
    duration_seconds: g.frames.length,
    media: null,
    frames: g.frames.map((f, i) => ({ t: i, file: relOut(outDir, f), kind: "interval" as const })),
    sheets: [],
    transcript: null,
  }));
}

/** Validate + write `<outDir>/watch.json`; the single place both entry points below produce the file. */
function writeWatchIndex(outDir: string, mode: WatchMode, videos: WatchVideo[]): WatchIndex {
  const index = WatchIndexSchema.parse({ schema_version: "harness.watch/v1", mode, videos });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "watch.json"), JSON.stringify(index, null, 2));
  return index;
}

/**
 * For each video: probe (media, duration) -> pick frame times (scene + interval) -> extract frames with
 * ffmpeg -> group into contact sheets -> optionally run the transcribe hook -> validate and write
 * `<outDir>/watch.json`. Never throws out of the transcribe step; a failed/timed-out/malformed transcript
 * always degrades to `transcript: null` + `transcript_error`.
 *
 * `preExtracted` (optional) are videos this machine cannot re-watch -- a sample whose recorded path no longer
 * exists here -- carried into the same index from frames an earlier stage already wrote, so one unresolvable
 * entry no longer forces the whole set down to the frames-only path (final-review finding I-3). They are
 * appended after the freshly watched videos, so `videos[]` order follows the argument order of each group,
 * not the caller's original interleaving.
 */
export async function watchVideos(d: WatchDeps, o: WatchOptions, videos: WatchVideoInput[], preExtracted: PreExtractedVideo[] = []): Promise<WatchIndex> {
  const ffmpeg = d.ffmpeg ?? "ffmpeg";
  const log = d.log ?? noopLog;
  const defaults = WATCH_DEFAULTS[o.mode];
  const interval_seconds = o.interval_seconds ?? defaults.interval_seconds;
  const max_frames = o.max_frames ?? defaults.max_frames;
  const scene_threshold = o.scene_threshold ?? 0.3;
  const frame_width = o.frame_width ?? 640;

  // Probe every video up front: the sheet budget below depends on every video's duration, not just the one
  // currently being processed, so all probing happens before any frame is extracted. This changes only the
  // order probes happen in (all-at-once instead of interleaved with extraction), not how many times each
  // video is probed, so it does not change behavior when `max_sheets` is unset.
  const probes: (MediaProbe | null)[] = [];
  for (const video of videos) probes.push(await d.prober.probe(video.path));
  const durations = probes.map((probe) => probe?.duration_seconds ?? 0);
  const sheetBudgets: (number | undefined)[] = o.max_sheets !== undefined ? distributeSheetBudget(durations, o.max_sheets) : videos.map(() => undefined);

  const outVideos: WatchVideo[] = [];
  for (let vi = 0; vi < videos.length; vi++) {
    const video = videos[vi]!;
    const probe = probes[vi]!;
    const duration_seconds = durations[vi]!;
    const scene = duration_seconds > 0 ? detectSceneChanges(ffmpeg, video.path, scene_threshold) : [];
    const marks = video.shot_marks ?? [];
    const times = pickFrameTimes({ duration: duration_seconds, scene, marks, interval_seconds, max_frames });

    const labelDir = join(o.outDir, video.label);
    const framesDir = join(labelDir, "frames");
    mkdirSync(framesDir, { recursive: true });

    const frames: WatchFrame[] = [];
    const extracted: { t: number; absPath: string }[] = [];
    for (const { t, kind } of times) {
      const fileName = frameFileName(t);
      const framePath = join(framesDir, fileName);
      if (!extractFrame(ffmpeg, video.path, t, frame_width, framePath)) {
        log("warn", "watch: frame extraction failed", { label: video.label, t });
        continue;
      }
      frames.push({ t, file: relOut(o.outDir, framePath), kind });
      extracted.push({ t, absPath: framePath });
    }

    const sheetBudget = sheetBudgets[vi];
    const sheetGroups: { t: number; absPath: string }[][] =
      sheetBudget !== undefined
        ? chunkIntoGroups(extracted, sheetBudget)
        : Array.from({ length: Math.ceil(extracted.length / CONTACT_SHEET_GROUP_SIZE) }, (_, i) =>
            extracted.slice(i * CONTACT_SHEET_GROUP_SIZE, (i + 1) * CONTACT_SHEET_GROUP_SIZE),
          );
    const sheets: string[] = [];
    for (let gi = 0; gi < sheetGroups.length; gi++) {
      const group = sheetGroups[gi]!;
      const sheetPath = join(labelDir, `sheet-${String(gi + 1).padStart(2, "0")}.png`);
      if (buildContactSheet(ffmpeg, group, sheetPath, log)) sheets.push(relOut(o.outDir, sheetPath));
    }

    let transcript: WatchTranscript | null = null;
    let transcript_error: string | undefined;
    const transcriptKey = video.source_id ?? video.label;
    const fromInput = o.transcriptBySource?.[transcriptKey];
    if (fromInput !== undefined) {
      transcript = fromInput;
    } else if (d.transcribe) {
      const result = runTranscribe(d.transcribe, video.path, labelDir);
      transcript = result.transcript;
      transcript_error = result.transcript_error;
    }

    outVideos.push({
      label: video.label,
      source_path: video.path,
      duration_seconds,
      media: probe?.media ?? null,
      frames,
      sheets,
      transcript,
      ...(transcript_error !== undefined ? { transcript_error } : {}),
    });
  }

  return writeWatchIndex(o.outDir, o.mode, [...outVideos, ...preExtractedVideos(o.outDir, preExtracted)]);
}

/**
 * No-ffmpeg path for the 2C `collect-samples` fixture, whose output is already a set of extracted PNGs:
 * one frame per second (t = index), kind "interval", no contact sheets, no transcript. Writes
 * `<outDir>/watch.json` the same way `watchVideos` does, for a consistent downstream contract.
 */
export function watchFromExistingFrames(o: { mode: "samples"; outDir: string }, groups: PreExtractedVideo[]): WatchIndex {
  return writeWatchIndex(o.outDir, o.mode, preExtractedVideos(o.outDir, groups));
}
