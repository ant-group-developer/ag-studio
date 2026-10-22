/** Final-render ffmpeg argv: video chain (dissolve/dip_black/cut transitions, ASS burn-in, logo overlay) plus
 * the audio graph from `audio-graph.ts` -- sub-project 5B Task 6, spec §5.2/§5.3. Pure: no I/O, no clock, no
 * randomness. Task 7 resolves `ffmpeg`, mezzanine paths, `assPath`/`fontsDir` and `loudnorm` (two ffmpeg
 * passes: `measureOnly: true` to measure, then `false` with the measured values) and spawns the result. */
import { HarnessError, type Composition } from "@harness/contracts";
import { round3 } from "../time.js";
import { audioGraph, type LoudnormMeasured } from "./audio-graph.js";
import { videoEncoderArgs, type EncoderChoice, type OutputTier } from "./encoder.js";

export interface FinalGraphInput {
  ffmpeg: string;
  composition: Composition;
  /** One entry per `composition.segments[]`, by `order`; `tail` is required whenever that segment's
   * `transition_out.kind === "dissolve"` (always true together with `tail_available` in a valid composition). */
  mezz: { order: number; body: string; tail: string | null }[];
  assPath: string | null;
  fontsDir: string | null;
  encoder: EncoderChoice;
  /** How the video is encoded (`videoEncoderArgs`); default `final`. */
  tier?: OutputTier;
  loudnorm: LoudnormMeasured | null;
  /** An `alimiter` ceiling before loudnorm (`peakLimit`), the same on the measurement and the final pass. */
  limit?: number | null;
  /** `composition.source_even`: each segment's even-level gain (dB, by order), measured by the runner. */
  evenGainDb?: ReadonlyMap<number, number>;
  out_path: string;
  /** `true` for the loudnorm measurement pass: same inputs, audio-only filtergraph, `-f null -`. */
  measureOnly: boolean;
  /** Logo overlay margin, `brand.safe_margin_px` when a brand is present. Default matches the brief's
   * "120" fallback for the no-brand case, since `Composition.brand` does not itself carry this field. */
  safe_margin_px?: number;
  /** What the pass makes (not with `measureOnly`): `both` streams in one file (default), the `video` of a slice
   * (`finalSliceArgs`), or the `audio` alone, for `finalConcatArgs` to mux with the slices. */
  streams?: FinalStreams;
  /** `streams: "video"`: where this picture starts on the episode's, so the subtitles show at their own time. */
  sliceStart?: number;
  /** The first segment fades in from black over half of this: the slice before ended on a dip_black. */
  dipInSeconds?: number;
}

export type FinalStreams = "both" | "video" | "audio";

/** A slice of the episode for its picture to be encoded on its own (`finalSlices`). */
export interface FinalSlice {
  /** Its segments' `order`s, in timeline order. */
  orders: number[];
  /** Where it starts on the episode's picture: the lengths of every segment before it. */
  start: number;
  seconds: number;
  /** The `dip_black` seconds the slice before ends on (0: a plain cut). */
  dipIn: number;
}

/** No slice shorter than this: a few seconds of picture are not worth an ffmpeg (and an NVENC session) of their own. */
export const MIN_SLICE_SECONDS = 30;

export type FinalGraphInputKind = "body" | "tail" | "narration" | "music" | "logo";

function fmt(n: number): string {
  return String(round3(n));
}

/**
 * Brings a mezzanine's picture to exactly `seconds`: a body that came out short (the render worker clamps
 * `segment.out` to a source file shorter than the timeline's asset, a frame lost to rounding) holds its last
 * frame, one that ran long is cut. Every xfade offset below is a sum of segment lengths, so a body shorter than
 * its segment pushed the offset past the end of the left stream, and xfade then dropped nearly all of the right
 * one: the Kiyomizu preview ended at 13:23 of 17:30, on its last dissolve.
 */
function exactLength(seconds: number): string {
  return `tpad=stop_mode=clone:stop_duration=${fmt(seconds)},trim=duration=${fmt(seconds)},setpts=PTS-STARTPTS`;
}

export function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    // The whole escaped path is wrapped in single quotes by the caller (`filename='...'`). ffmpeg parses this
    // in two passes: pass 1 (the filtergraph tokenizer) copies quoted text literally and only unescapes `\X`
    // OUTSIDE quotes; pass 2 (the filter's own key=value split) runs on that already-unquoted text and sees
    // no quote markers, so a bare `'` in it re-opens a quote as far as pass 2 is concerned and swallows
    // everything after it (e.g. `:fontsdir=...`). The 4-char shell-style trick `'\''` (close, escaped quote,
    // reopen) is one escaping level short here -- verified against real ffmpeg 8.1 (fix round 1, Important 3
    // review round 2). The working sequence closes the quote, then emits an ESCAPED BACKSLASH followed by an
    // ESCAPED QUOTE (both consumed by pass 1's outside-quote unescaping down to one literal `\` and one
    // literal `'`, which pass 2 then reads as an escaped quote rather than a new quote marker), then reopens
    // the quote: 6 literal characters `'\\\''` (quote, backslash, backslash, backslash, quote, quote).
    .replace(/'/g, "'\\\\\\''")
    .replace(/[,[\];]/g, (c) => `\\${c}`);
}

export function finalArgs(p: FinalGraphInput): { argv: string[]; inputs: { kind: FinalGraphInputKind; path: string; index: number }[] } {
  const { ffmpeg, composition, mezz, assPath, fontsDir, encoder, loudnorm, out_path, measureOnly } = p;
  const segs = [...composition.segments].sort((a, b) => a.order - b.order);
  if (segs.length === 0) throw new HarnessError("CONFIG_INVALID", "finalArgs: composition has no segments", {});
  const mezzByOrder = new Map(mezz.map((m) => [m.order, m]));
  const streams: FinalStreams = measureOnly ? "audio" : (p.streams ?? "both");
  const wantVideo = streams !== "audio";
  const wantAudio = streams !== "video";

  // ---- inputs: body_0, tail_0?, body_1, tail_1?, ..., narration wavs (tts), music, logo ----
  // The measurement pass keeps every input (its argv has always been the final pass's own); a pass making one
  // stream opens only the files that stream reads.
  const keepAll = measureOnly || streams === "both";
  const inputs: { kind: FinalGraphInputKind; path: string; index: number }[] = [];
  const bodyIndexByOrder = new Map<number, number>();
  const tailIndexByOrder = new Map<number, number>();
  let idx = 0;

  for (const seg of segs) {
    const m = mezzByOrder.get(seg.order);
    if (m === undefined) throw new Error(`finalArgs: missing mezzanine for segment order ${seg.order}`);
    inputs.push({ kind: "body", path: m.body, index: idx });
    bodyIndexByOrder.set(seg.order, idx);
    idx++;
    if ((keepAll || wantVideo) && seg.transition_out.kind === "dissolve" && seg.transition_out.tail_available) {
      if (m.tail === null) throw new Error(`finalArgs: segment order ${seg.order} has a dissolve transition but no tail mezzanine`);
      inputs.push({ kind: "tail", path: m.tail, index: idx });
      tailIndexByOrder.set(seg.order, idx);
      idx++;
    }
  }

  const narrationIndexByLineId = new Map<string, number>();
  if ((keepAll || wantAudio) && composition.voice === "tts") {
    for (const n of composition.narration) {
      inputs.push({ kind: "narration", path: n.wav, index: idx });
      narrationIndexByLineId.set(n.line_id, idx);
      idx++;
    }
  }

  let musicIdx: number | null = null;
  if ((keepAll || wantAudio) && composition.music !== null) {
    musicIdx = idx;
    inputs.push({ kind: "music", path: composition.music.path, index: idx });
    idx++;
  }

  let logoIdx: number | null = null;
  if ((keepAll || wantVideo) && composition.logo !== null) {
    logoIdx = idx;
    inputs.push({ kind: "logo", path: composition.logo.path, index: idx });
    idx++;
  }

  const argv: string[] = [ffmpeg, "-hide_banner", "-y"];
  for (const input of inputs) argv.push("-i", input.path);

  // ---- audio graph (the measurement pass, the one-pass encode, the sound of a sliced one) ----
  const audio = !wantAudio ? null : audioGraph({
    composition,
    mezzIndex: (order) => {
      const i = bodyIndexByOrder.get(order);
      if (i === undefined) throw new Error(`finalArgs: no body input for segment order ${order}`);
      return i;
    },
    narrationIndex: (line_id) => {
      const i = narrationIndexByLineId.get(line_id);
      if (i === undefined) throw new Error(`finalArgs: no narration input for line_id ${line_id}`);
      return i;
    },
    musicIndex: musicIdx,
    loudnorm,
    limit: p.limit ?? null,
    ...(p.evenGainDb ? { evenGainDb: p.evenGainDb } : {}),
  });

  if (measureOnly) {
    argv.push("-filter_complex", audio!.filter, "-map", audio!.out, "-vn", "-f", "null", "-");
    return { argv, inputs };
  }
  if (audio !== null && !wantVideo) {
    argv.push("-filter_complex", audio.filter, "-map", audio.out, "-vn", ...AUDIO_CODEC_ARGS, out_path);
    return { argv, inputs };
  }

  // ---- video chain ----
  const videoParts: string[] = [];
  /** Bare (unbracketed) label reference for each segment's own resolved video stream, after its own
   * dissolve-concat and any dip_black fades touching it. */
  const segLabel: string[] = [];
  const segLen: number[] = segs.map((seg) => seg.end - seg.start);

  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]!;
    const bodyIdx = bodyIndexByOrder.get(seg.order)!;
    let label = `v${k}b`;
    videoParts.push(`[${bodyIdx}:v]${exactLength(segLen[k]!)}[${label}]`);

    if (seg.transition_out.kind === "dissolve" && seg.transition_out.tail_available) {
      const tailIdx = tailIndexByOrder.get(seg.order)!;
      const tail = `v${k}t`;
      videoParts.push(`[${tailIdx}:v]${exactLength(seg.transition_out.seconds)}[${tail}]`);
      const out = `v${k}c`;
      videoParts.push(`[${label}][${tail}]concat=n=2:v=1:a=0[${out}]`);
      label = out;
    }

    // This segment is the outgoing side of a dip_black into k+1.
    if (seg.transition_out.kind === "dip_black") {
      const s = seg.transition_out.seconds;
      const out = `v${k}fo`;
      videoParts.push(`[${label}]fade=t=out:st=${fmt(segLen[k]! - s / 2)}:d=${fmt(s / 2)}[${out}]`);
      label = out;
    }

    // This segment is the incoming side of a dip_black from k-1 (or, first in a slice, from the slice before).
    const dipIn = k > 0 ? (segs[k - 1]!.transition_out.kind === "dip_black" ? segs[k - 1]!.transition_out.seconds : 0) : (p.dipInSeconds ?? 0);
    if (dipIn > 0) {
      const s = dipIn;
      const out = `v${k}fi`;
      videoParts.push(`[${label}]fade=t=in:st=0:d=${fmt(s / 2)}[${out}]`);
      label = out;
    }

    segLabel.push(label);
  }

  // Group into blocks split at every dissolve boundary; concat within a block, xfade between blocks.
  const blocks: number[][] = [];
  let current: number[] = [];
  for (let k = 0; k < segs.length; k++) {
    current.push(k);
    if (segs[k]!.transition_out.kind === "dissolve" && segs[k]!.transition_out.tail_available) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);

  const blockLabel: string[] = blocks.map((block, j) => {
    if (block.length === 1) return segLabel[block[0]!]!;
    const refs = block.map((k) => `[${segLabel[k]!}]`).join("");
    const out = `blk${j}`;
    videoParts.push(`${refs}concat=n=${block.length}:v=1:a=0[${out}]`);
    return out;
  });

  let accLabel = blockLabel[0]!;
  let accLen = blocks[0]!.reduce((sum, k) => sum + segLen[k]!, 0);
  for (let j = 1; j < blocks.length; j++) {
    const boundarySeg = segs[blocks[j - 1]![blocks[j - 1]!.length - 1]!]!;
    const s = boundarySeg.transition_out.seconds;
    const leftTb = `xt${j}l`;
    const rightTb = `xt${j}r`;
    // `fps` last: xfade refuses a link with no constant frame rate, and on ffmpeg 7.1 (the render worker's
    // Debian build) both `concat` and `setpts` leave the rate unknown (1/0) even though every mezzanine is CFR
    // -- "The inputs needs to be a constant frame rate", exit 234 on any episode with a dissolve. ffmpeg 8+
    // keeps the rate, which is why it never showed up locally.
    const cfr = `settb=AVTB,setpts=PTS-STARTPTS,fps=${composition.output.fps}`;
    videoParts.push(`[${accLabel}]${cfr}[${leftTb}]`);
    videoParts.push(`[${blockLabel[j]!}]${cfr}[${rightTb}]`);
    const out = `xf${j}`;
    videoParts.push(`[${leftTb}][${rightTb}]xfade=transition=fade:duration=${fmt(s)}:offset=${fmt(accLen)}[${out}]`);
    accLabel = out;
    accLen += blocks[j]!.reduce((sum, k) => sum + segLen[k]!, 0);
  }

  let stage = accLabel;
  if (assPath !== null) {
    const fontsdirPart = fontsDir !== null ? `:fontsdir='${escapeFilterPath(fontsDir)}'` : "";
    const ass = `ass=filename='${escapeFilterPath(assPath)}'${fontsdirPart}`;
    // libass reads the frame's own time: a slice's picture is moved to where it sits in the episode, then back
    const shift = p.sliceStart ?? 0;
    videoParts.push(shift > 0 ? `[${stage}]setpts=PTS+${fmt(shift)}/TB,${ass},setpts=PTS-STARTPTS[vass]` : `[${stage}]${ass}[vass]`);
    stage = "vass";
  }

  if (composition.logo !== null && logoIdx !== null) {
    const m = p.safe_margin_px ?? 120;
    const heightPx = composition.logo.height_px;
    const opacity = composition.logo.opacity;
    const x = composition.logo.corner === "left" ? fmt(m / 2) : `W-w-${fmt(m / 2)}`;
    const y = fmt(m / 2);
    videoParts.push(`[${logoIdx}:v]scale=-1:${heightPx},format=rgba,colorchannelmixer=aa=${fmt(opacity)}[lg]`);
    videoParts.push(`[${stage}][lg]overlay=${x}:${y}[vlogo]`);
    stage = "vlogo";
  }

  videoParts.push(`[${stage}]format=yuv420p[vout]`);

  const encoderArgs = videoEncoderArgs({ choice: encoder, codec: composition.output.codec, tier: p.tier ?? "final", fps: composition.output.fps });
  if (audio === null) {
    argv.push("-filter_complex", videoParts.join(";"), "-map", "[vout]", "-an", ...encoderArgs, out_path);
    return { argv, inputs };
  }
  const filterComplex = `${videoParts.join(";")};${audio.filter}`;
  argv.push("-filter_complex", filterComplex, "-map", "[vout]", "-map", audio.out);
  argv.push(...encoderArgs);
  argv.push(...AUDIO_CODEC_ARGS, "-movflags", "+faststart", out_path);

  return { argv, inputs };
}

const AUDIO_CODEC_ARGS = ["-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2"];

/** Length of a segment's picture: what `finalArgs` holds each body to (`exactLength`). */
function segmentSeconds(seg: Composition["segments"][number]): number {
  return seg.end - seg.start;
}

/** A slice may end after this segment: its picture is not carried on into the next one by a dissolve tail. */
function canSplitAfter(seg: Composition["segments"][number]): boolean {
  return !(seg.transition_out.kind === "dissolve" && seg.transition_out.tail_available);
}

/**
 * The episode cut into at most `count` slices whose pictures can be encoded at the same time (ffmpeg 6.1 runs the
 * decode and the filtergraph of one pass on a single thread: the farm's final pass used 10-20% of its CPU). A slice
 * ends only where a segment does not dissolve into the next (a cut, or a dip_black, whose two halves sit inside the
 * two segments), at the boundary nearest an even share of the episode, and no slice is shorter than `minSeconds`.
 * One slice (the whole episode) when there is nowhere to split.
 */
export function finalSlices(composition: Composition, count: number, minSeconds: number = MIN_SLICE_SECONDS): FinalSlice[] {
  const segs = [...composition.segments].sort((a, b) => a.order - b.order);
  const ends: number[] = [];
  let acc = 0;
  for (const seg of segs) ends.push((acc = round3(acc + segmentSeconds(seg))));
  const total = acc;
  /** Indices of the segments each slice ends after. */
  const cuts: number[] = [];
  for (let i = 1; i < Math.max(1, Math.floor(count)); i++) {
    const target = (total * i) / count;
    const from = cuts.length > 0 ? ends[cuts[cuts.length - 1]!]! : 0;
    let best: number | null = null;
    for (let k = 0; k < segs.length - 1; k++) {
      if (!canSplitAfter(segs[k]!) || ends[k]! - from < minSeconds || total - ends[k]! < minSeconds) continue;
      if (cuts.length > 0 && k <= cuts[cuts.length - 1]!) continue;
      if (best === null || Math.abs(ends[k]! - target) < Math.abs(ends[best]! - target)) best = k;
    }
    if (best !== null) cuts.push(best);
  }
  const slices: FinalSlice[] = [];
  let first = 0;
  for (const last of [...cuts, segs.length - 1]) {
    const start = first === 0 ? 0 : ends[first - 1]!;
    const before = first === 0 ? null : segs[first - 1]!.transition_out;
    slices.push({
      orders: segs.slice(first, last + 1).map((s) => s.order),
      start,
      seconds: round3(ends[last]! - start),
      dipIn: before !== null && before.kind === "dip_black" ? before.seconds : 0,
    });
    first = last + 1;
  }
  return slices;
}

/** `finalArgs` for the picture of one slice: its own segments, rebased to 0, into `out_path`. */
export function finalSliceArgs(p: FinalGraphInput, slice: FinalSlice, out_path: string): ReturnType<typeof finalArgs> {
  const orders = new Set(slice.orders);
  const segs = [...p.composition.segments].filter((s) => orders.has(s.order)).sort((a, b) => a.order - b.order);
  let at = 0;
  const segments = segs.map((s) => {
    const len = segmentSeconds(s);
    const rebased = { ...s, start: round3(at), end: round3(at + len) };
    at += len;
    return rebased;
  });
  return finalArgs({
    ...p,
    composition: { ...p.composition, segments, total_seconds: slice.seconds },
    mezz: p.mezz.filter((m) => orders.has(m.order)),
    streams: "video",
    measureOnly: false,
    sliceStart: slice.start,
    dipInSeconds: slice.dipIn,
    out_path,
  });
}

/** The concat demuxer's list of the slice files (names relative to the list's own directory). */
export function finalConcatList(files: readonly string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'\n`).join("");
}

/** The slices' pictures joined by stream copy, the sound (`streams: "audio"`) muxed in, `+faststart` as the
 * one-pass render writes it. */
export function finalConcatArgs(p: { ffmpeg: string; list: string; audio: string; codec: "h264" | "hevc"; out_path: string }): string[] {
  return [
    p.ffmpeg, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", p.list, "-i", p.audio,
    "-map", "0:v", "-map", "1:a", "-c", "copy", ...(p.codec === "hevc" ? ["-tag:v", "hvc1"] : []), "-movflags", "+faststart", p.out_path,
  ];
}
