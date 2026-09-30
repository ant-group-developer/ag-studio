/**
 * `build-timeline` (plan 4.1): selection + narration + measured TTS durations -> Timeline v2 draft.
 *
 * Each beat is cut to fit its narration: it lasts the voiced lines plus `BEAT_TAIL` (or the treatment's
 * seconds when it has no narration). Picks fill that length in order, taken from the middle of each segment;
 * when the picks run short they are lengthened up to their full segment, then the beat's alternates are
 * brought in. A beat that still cannot be covered is left short -- `timelineIssues` reports it as
 * `narration_overflow` and the editor is where a person fixes it; the builder never repeats a segment.
 */
import type { CatalogSegment, Selection, StudioBrief, StudioNarration, TimelineV2, Treatment } from "@harness/contracts";
import { BEAT_TAIL, MIN_CLIP_SECONDS, NARRATION_GAP } from "./layout.js";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface BuildTimelineInput {
  brief: StudioBrief;
  treatment: Treatment;
  catalog: CatalogSegment[];
  selection: Selection;
  /** `null` in the montage flow: no narration, beats last their treatment seconds, the footage keeps its sound. */
  narration: StudioNarration | null;
  /** Per line: the uploaded WAV's key under `productions/<id>/` and its measured duration. */
  audio: Map<string, { key: string; duration: number }>;
}

export function buildStudioTimeline(input: BuildTimelineInput): TimelineV2 {
  const { brief, treatment, selection } = input;
  const lines = input.narration?.lines ?? [];
  const catalog = new Map(input.catalog.map((s) => [s.id, s]));
  const selByBeat = new Map(selection.beats.map((b) => [b.beat_id, b]));
  const segments: TimelineV2["segments"] = {};
  const remember = (id: string) => {
    const s = catalog.get(id);
    if (s && !segments[id]) segments[id] = { asset_id: s.asset_id, start_ms: s.start_ms, end_ms: s.end_ms, caption: s.caption_vi || s.caption_en, orientation: s.orientation };
    return s;
  };
  const used = new Set<string>();
  for (const b of selection.beats) for (const p of b.picks) used.add(p.segment_id);

  const clips: TimelineV2["clips"] = [];
  const alternates: TimelineV2["alternates"] = {};
  let clipNo = 0;

  for (const tb of treatment.beats) {
    const sel = selByBeat.get(tb.beat_id);
    const beatLines = lines.filter((l) => l.beat_id === tb.beat_id);
    const voiced = beatLines.map((l) => input.audio.get(l.line_id)?.duration ?? 0);
    const target = beatLines.length
      ? r3(voiced.reduce((a, b) => a + b, 0) + NARRATION_GAP * (beatLines.length - 1) + BEAT_TAIL)
      : tb.seconds;

    type Pending = { segment_id: string; seg: CatalogSegment; len: number };
    const chosen: Pending[] = [];
    for (const p of sel?.picks ?? []) {
      const seg = remember(p.segment_id);
      if (seg) chosen.push({ segment_id: p.segment_id, seg, len: 0 });
    }
    const altQueue = (sel?.alternates ?? []).filter((a) => !used.has(a.segment_id) && catalog.has(a.segment_id));
    for (const a of sel?.alternates ?? []) remember(a.segment_id);

    // 1) share the target across the picks, each capped by its own segment
    let remaining = target;
    chosen.forEach((c, i) => {
      const share = remaining / (chosen.length - i);
      c.len = r3(Math.min(c.seg.duration_s, Math.max(share, MIN_CLIP_SECONDS)));
      remaining -= c.len;
    });
    // 2) lengthen picks that still have footage left
    for (const c of chosen) {
      if (remaining <= 0.001) break;
      const extra = Math.min(c.seg.duration_s - c.len, remaining);
      if (extra > 0) { c.len = r3(c.len + extra); remaining -= extra; }
    }
    // 3) bring alternates in
    while (remaining > 0.001 && altQueue.length) {
      const a = altQueue.shift()!;
      const seg = catalog.get(a.segment_id)!;
      if (seg.duration_s < MIN_CLIP_SECONDS) continue;
      const len = r3(Math.min(seg.duration_s, Math.max(remaining, MIN_CLIP_SECONDS)));
      chosen.push({ segment_id: a.segment_id, seg, len });
      used.add(a.segment_id);
      remaining -= len;
    }
    // 4) the picks may overshoot a short beat (one segment longer than the whole narration): trim the last
    for (let i = chosen.length - 1; i >= 0 && remaining < -0.001; i--) {
      const c = chosen[i]!;
      const cut = Math.min(-remaining, c.len - MIN_CLIP_SECONDS);
      if (cut > 0) { c.len = r3(c.len - cut); remaining += cut; }
    }

    for (const c of chosen) {
      clipNo++;
      const src_in = r3((c.seg.duration_s - c.len) / 2);
      clips.push({ clip_id: `C${String(clipNo).padStart(3, "0")}`, beat_id: tb.beat_id, segment_id: c.segment_id, src_in, src_out: r3(src_in + c.len) });
    }
    alternates[tb.beat_id] = altQueue.map((a) => ({ segment_id: a.segment_id, reason: a.reason }));
  }

  // The title card sits inside the first beat, whatever length that beat ended up with.
  const firstBeat = treatment.beats[0];
  const firstBeatSeconds = firstBeat ? clips.filter((c) => c.beat_id === firstBeat.beat_id).reduce((s, c) => s + c.src_out - c.src_in, 0) : 0;
  const texts: TimelineV2["texts"] = firstBeat && firstBeatSeconds >= 1.5
    ? [{ text_id: "T001", beat_id: firstBeat.beat_id, kind: "title", text: treatment.title.slice(0, 64), offset: 0.5, duration: r3(Math.min(3.5, firstBeatSeconds - 0.5)), position: "top_left" }]
    : [];

  return {
    schema_version: "studio.timeline/v2",
    production_id: brief.production_id,
    canvas: brief.canvas,
    fps: brief.fps,
    language: brief.language,
    beats: treatment.beats.map((b) => ({ beat_id: b.beat_id, title: b.purpose })),
    clips,
    narration: lines.map((l) => ({ line_id: l.line_id, beat_id: l.beat_id, text: l.text, audio: input.audio.get(l.line_id) ?? null })),
    texts,
    music: brief.music,
    // narrated: the voice carries the sound; montage: the footage's own sound is all there is
    source_audio: { muted: input.narration !== null },
    captions: { enabled: true },
    segments,
    alternates,
  };
}
