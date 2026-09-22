/** Final audio mix graph: voice layer, music with sidechain ducking, loudnorm -- sub-project 5B Task 6,
 * spec §5.3. Pure: no I/O, no clock, no randomness. Input file indices are supplied by the caller
 * (`final-graph.ts`) via `mezzIndex`/`narrationIndex`/`musicIndex`, so this module never has to know how
 * `finalArgs` ordered its `-i` list. */
import type { Composition } from "@harness/contracts";
import { round3 } from "../time.js";

/**
 * `loudnorm`'s single-pass measurement output (`print_format=json` on the first, `-f null` pass). Defined
 * here rather than in Task 7's `loudnorm.ts` to avoid a forward dependency from this module onto that one;
 * Task 7 re-exports this type as its own so callers only ever import one name.
 */
export interface LoudnormMeasured {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

export interface AudioGraphInput {
  composition: Composition;
  /** ffmpeg input index of a segment's mezzanine body, by `composition.segments[].order`. */
  mezzIndex: (order: number) => number;
  /** ffmpeg input index of a narration wav, by `composition.narration[].line_id`. */
  narrationIndex: (line_id: string) => number;
  /** ffmpeg input index of the music track, or `null` when `composition.music` is `null`. */
  musicIndex: number | null;
  /** `null` for the measurement pass; the first pass's measured loudness for the final encode pass. */
  loudnorm: LoudnormMeasured | null;
}

/** Formats a time/gain value on the 3-decimal grid with no trailing zeros (e.g. `0.4`, not `0.400`). */
function fmt(n: number): string {
  return String(round3(n));
}

const DUCK_THRESHOLD = "0.031";
const DUCK_RATIO = "6";

function buildVoiceGraph(composition: Composition, mezzIndex: (order: number) => number, narrationIndex: (line_id: string) => number): { parts: string[]; label: string } {
  const parts: string[] = [];
  const total = fmt(composition.total_seconds);

  if (composition.voice === "tts") {
    if (composition.narration.length === 0) {
      // Already spans exactly `total_seconds` -- no pad/trim needed.
      parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total}[voice]`);
      return { parts, label: "voice" };
    }
    const labels: string[] = [];
    composition.narration.forEach((n, idx) => {
      const i = narrationIndex(n.line_id);
      const ms = Math.round(n.start * 1000);
      const label = `n_${idx}`;
      parts.push(`[${i}:a]adelay=${ms}|${ms}[${label}]`);
      labels.push(`[${label}]`);
    });
    // `amix ... duration=longest` ends at the last narration line, not `total_seconds` -- with a trailing
    // silent gap (or narration that runs past the last video segment being clamped) that fell short of the
    // episode's full length, the music's fade-out (anchored at `total_seconds - fade_out`) would never play
    // and the final `amix=duration=first` below would truncate everything to this short voice layer, making
    // the tail of the episode silent (fix round 1, Critical 2). `apad` extends with silence when short;
    // `atrim` clamps if narration somehow ran long.
    parts.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest[voice_mixed]`);
    parts.push(`[voice_mixed]apad,atrim=0:${total}[voice]`);
    return { parts, label: "voice" };
  }

  // "original" or "none": every segment's own audio, trimmed to its body length (no tail), 20ms edge fades,
  // concatenated in segment order. Mezzanine audio is trimmed exactly to `end - start` per segment, so the
  // concat's total should already equal `total_seconds`; `apad,atrim` here is defensive (same reasoning as
  // the `tts` branch above) against per-segment rounding drift accumulating over many segments.
  const segs = [...composition.segments].sort((a, b) => a.order - b.order);
  const labels: string[] = [];
  segs.forEach((seg, idx) => {
    const i = mezzIndex(seg.order);
    const len = seg.end - seg.start;
    const label = `s_${idx}`;
    parts.push(`[${i}:a]atrim=0:${fmt(len)},afade=t=in:d=0.02,afade=t=out:st=${fmt(len - 0.02)}:d=0.02[${label}]`);
    labels.push(`[${label}]`);
  });
  parts.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[voice_concat]`);

  if (composition.voice === "none") {
    parts.push(`[voice_concat]apad,atrim=0:${total}[voice_padded]`);
    parts.push("[voice_padded]volume=-12dB[voice]");
  } else {
    parts.push(`[voice_concat]apad,atrim=0:${total}[voice]`);
  }
  return { parts, label: "voice" };
}

/** Builds the audio-only filtergraph feeding `[aout]`: voice layer, optional ducked music, loudnorm. */
export function audioGraph(p: AudioGraphInput): { filter: string; out: string } {
  const { composition, mezzIndex, narrationIndex, musicIndex, loudnorm } = p;
  const parts: string[] = [];

  const voice = buildVoiceGraph(composition, mezzIndex, narrationIndex);
  parts.push(...voice.parts);

  const music = composition.music;
  let mixLabel: string;
  if (music !== null && musicIndex !== null) {
    const loopPrefix = music.loop ? "aloop=loop=-1:size=2e9," : "";
    const gainDb = music.cues[0]?.gain_db ?? -18;
    const fadeOutStart = fmt(composition.total_seconds - music.fade_out);
    parts.push(
      `[${musicIndex}:a]${loopPrefix}atrim=0:${fmt(composition.total_seconds)},afade=t=in:d=${fmt(music.fade_in)},afade=t=out:st=${fadeOutStart}:d=${fmt(music.fade_out)},volume=${fmt(gainDb)}dB[music]`,
    );
    if (composition.voice !== "none") {
      parts.push("[voice]asplit=2[voice_mix][voice_sc]");
      parts.push(`[music][voice_sc]sidechaincompress=threshold=${DUCK_THRESHOLD}:ratio=${DUCK_RATIO}:attack=${music.duck.attack_ms}:release=${music.duck.release_ms}:makeup=1[music_d]`);
      parts.push("[voice_mix][music_d]amix=inputs=2:normalize=0:duration=first[mix]");
    } else {
      parts.push("[voice][music]amix=inputs=2:normalize=0:duration=first[mix]");
    }
    mixLabel = "mix";
  } else {
    parts.push("[voice]anull[mix]");
    mixLabel = "mix";
  }

  if (loudnorm === null) {
    parts.push(`[${mixLabel}]loudnorm=I=-14:TP=-1:LRA=11:print_format=json[aout]`);
  } else {
    parts.push(
      `[${mixLabel}]loudnorm=I=-14:TP=-1:LRA=11:measured_I=${loudnorm.input_i}:measured_TP=${loudnorm.input_tp}:measured_LRA=${loudnorm.input_lra}:measured_thresh=${loudnorm.input_thresh}:offset=${loudnorm.target_offset}:linear=true:print_format=json[aout]`,
    );
  }

  return { filter: parts.join(";"), out: "[aout]" };
}
