/** Final-render ffmpeg argv: video chain (dissolve/dip_black/cut transitions, ASS burn-in, logo overlay) plus
 * the audio graph from `audio-graph.ts` -- sub-project 5B Task 6, spec §5.2/§5.3. Pure: no I/O, no clock, no
 * randomness. Task 7 resolves `ffmpeg`, mezzanine paths, `assPath`/`fontsDir` and `loudnorm` (two ffmpeg
 * passes: `measureOnly: true` to measure, then `false` with the measured values) and spawns the result. */
import { HarnessError, type Composition } from "@harness/contracts";
import { round3 } from "../time.js";
import { audioGraph, type LoudnormMeasured } from "./audio-graph.js";
import { videoEncoderArgs, type EncoderChoice } from "./encoder.js";

export interface FinalGraphInput {
  ffmpeg: string;
  composition: Composition;
  /** One entry per `composition.segments[]`, by `order`; `tail` is required whenever that segment's
   * `transition_out.kind === "dissolve"` (always true together with `tail_available` in a valid composition). */
  mezz: { order: number; body: string; tail: string | null }[];
  assPath: string | null;
  fontsDir: string | null;
  encoder: EncoderChoice;
  loudnorm: LoudnormMeasured | null;
  out_path: string;
  /** `true` for the loudnorm measurement pass: same inputs, audio-only filtergraph, `-f null -`. */
  measureOnly: boolean;
  /** Logo overlay margin, `brand.safe_margin_px` when a brand is present. Default matches the brief's
   * "120" fallback for the no-brand case, since `Composition.brand` does not itself carry this field. */
  safe_margin_px?: number;
}

export type FinalGraphInputKind = "body" | "tail" | "narration" | "music" | "logo";

function fmt(n: number): string {
  return String(round3(n));
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

  // ---- inputs: body_0, tail_0?, body_1, tail_1?, ..., narration wavs (tts), music, logo ----
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
    if (seg.transition_out.kind === "dissolve" && seg.transition_out.tail_available) {
      if (m.tail === null) throw new Error(`finalArgs: segment order ${seg.order} has a dissolve transition but no tail mezzanine`);
      inputs.push({ kind: "tail", path: m.tail, index: idx });
      tailIndexByOrder.set(seg.order, idx);
      idx++;
    }
  }

  const narrationIndexByLineId = new Map<string, number>();
  if (composition.voice === "tts") {
    for (const n of composition.narration) {
      inputs.push({ kind: "narration", path: n.wav, index: idx });
      narrationIndexByLineId.set(n.line_id, idx);
      idx++;
    }
  }

  let musicIdx: number | null = null;
  if (composition.music !== null) {
    musicIdx = idx;
    inputs.push({ kind: "music", path: composition.music.path, index: idx });
    idx++;
  }

  let logoIdx: number | null = null;
  if (composition.logo !== null) {
    logoIdx = idx;
    inputs.push({ kind: "logo", path: composition.logo.path, index: idx });
    idx++;
  }

  const argv: string[] = [ffmpeg, "-hide_banner", "-y"];
  for (const input of inputs) argv.push("-i", input.path);

  // ---- audio graph (always built: needed for both the measurement pass and the final encode) ----
  const audio = audioGraph({
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
  });

  if (measureOnly) {
    argv.push("-filter_complex", audio.filter, "-map", audio.out, "-vn", "-f", "null", "-");
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
    let label = `${bodyIdx}:v`;

    if (seg.transition_out.kind === "dissolve" && seg.transition_out.tail_available) {
      const tailIdx = tailIndexByOrder.get(seg.order)!;
      const out = `v${k}c`;
      videoParts.push(`[${bodyIdx}:v][${tailIdx}:v]concat=n=2:v=1:a=0[${out}]`);
      label = out;
    }

    // This segment is the outgoing side of a dip_black into k+1.
    if (seg.transition_out.kind === "dip_black") {
      const s = seg.transition_out.seconds;
      const out = `v${k}fo`;
      videoParts.push(`[${label}]fade=t=out:st=${fmt(segLen[k]! - s / 2)}:d=${fmt(s / 2)}[${out}]`);
      label = out;
    }

    // This segment is the incoming side of a dip_black from k-1.
    if (k > 0 && segs[k - 1]!.transition_out.kind === "dip_black") {
      const s = segs[k - 1]!.transition_out.seconds;
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
    videoParts.push(`[${accLabel}]settb=AVTB,setpts=PTS-STARTPTS[${leftTb}]`);
    videoParts.push(`[${blockLabel[j]!}]settb=AVTB,setpts=PTS-STARTPTS[${rightTb}]`);
    const out = `xf${j}`;
    videoParts.push(`[${leftTb}][${rightTb}]xfade=transition=fade:duration=${fmt(s)}:offset=${fmt(accLen)}[${out}]`);
    accLabel = out;
    accLen += blocks[j]!.reduce((sum, k) => sum + segLen[k]!, 0);
  }

  let stage = accLabel;
  if (assPath !== null) {
    const fontsdirPart = fontsDir !== null ? `:fontsdir='${escapeFilterPath(fontsDir)}'` : "";
    videoParts.push(`[${stage}]ass=filename='${escapeFilterPath(assPath)}'${fontsdirPart}[vass]`);
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

  const filterComplex = `${videoParts.join(";")};${audio.filter}`;
  argv.push("-filter_complex", filterComplex, "-map", "[vout]", "-map", audio.out);
  argv.push(...videoEncoderArgs({ choice: encoder, codec: composition.output.codec, tier: "final", fps: composition.output.fps }));
  argv.push("-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out_path);

  return { argv, inputs };
}
