/** Pure literal fixtures shared by the `fit-edl` and `timeline` tests (sub-project 5A Task 6). No ffmpeg,
 * no store, no I/O: every builder returns a plain object that already satisfies its contract schema. */
import type { Edl, NarrationTiming, ShotsIndex, SurveyIndexV2, Transcript, Word } from "@harness/contracts";
import { shotId } from "../../src/media/scene.js";

export const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";
export const SRC_B = "src_01JBBBBBBBBBBBBBBBBBBBBBBB";

export function shotsFixture(
  sources: { source_id: string; index: number; duration: number; shots: [number, number][] }[],
): ShotsIndex {
  return {
    schema_version: "harness.shots/v2",
    sources: sources.map((s) => ({
      source_id: s.source_id,
      index: s.index,
      file_name: `source-${s.index}.mp4`,
      duration_seconds: s.duration,
      has_audio: true,
      shots: s.shots.map(([i, o], n) => ({ shot_id: shotId(s.index, n), in: i, out: o })),
    })),
  };
}

/** Six 5s shots on one 30s source -- the default "plenty of footage" board. */
export function sixShots(source_id: string, index: number): { source_id: string; index: number; duration: number; shots: [number, number][] } {
  return {
    source_id,
    index,
    duration: 30,
    shots: [[0, 5], [5, 10], [10, 15], [15, 20], [20, 25], [25, 30]],
  };
}

export function edlFixture(
  entries: { source_id: string; in: number; out: number; order: number; overlay?: "avatar" | null; note?: string }[],
): Edl {
  return {
    schema_version: "harness.edl/v1",
    entries: entries.map((e) => ({
      source_id: e.source_id,
      in: e.in,
      out: e.out,
      order: e.order,
      overlay: e.overlay ?? null,
      note: e.note ?? "",
    })),
  };
}

export function timingFixture(
  lines: { line_id: string; edl_order: number; duration_seconds: number; words?: Word[] }[],
): NarrationTiming {
  return {
    schema_version: "harness.narration-timing/v1",
    voice_id: null,
    voice_revision: null,
    total_seconds: lines.reduce((a, l) => a + l.duration_seconds, 0),
    lines: lines.map((l) => ({
      line_id: l.line_id,
      edl_order: l.edl_order,
      text: `text of ${l.line_id}`,
      wav: `voice/${l.line_id}.wav`,
      duration_seconds: l.duration_seconds,
      chunks: [],
      words: l.words ?? [],
      alignment: "word" as const,
      cached: false,
    })),
  };
}

export function surveyFixture(
  shots: { source_id: string; shot_id: string; in: number; out: number; score: number; usable?: boolean }[],
): SurveyIndexV2 {
  return {
    schema_version: "harness.survey-index/v2",
    shots: shots.map((s) => ({
      source_id: s.source_id,
      shot_id: s.shot_id,
      in: s.in,
      out: s.out,
      score: s.score,
      tags: [],
      usable: s.usable ?? true,
      note: "",
      speech: "none" as const,
    })),
  };
}

/** A survey covering every shot of `shots` with a constant score, so only the overrides differ. */
export function surveyFor(
  shots: ShotsIndex,
  overrides: Record<string, { score?: number; usable?: boolean }> = {},
  defaultScore = 1,
): SurveyIndexV2 {
  return surveyFixture(
    shots.sources.flatMap((src) =>
      src.shots.map((sh) => ({
        source_id: src.source_id,
        shot_id: sh.shot_id,
        in: sh.in,
        out: sh.out,
        score: overrides[sh.shot_id]?.score ?? defaultScore,
        usable: overrides[sh.shot_id]?.usable ?? true,
      })),
    ),
  );
}

export function transcriptFixture(
  sources: {
    source_id: string;
    alignment: "word" | "segment";
    segments: { start: number; end: number; text: string; words?: Word[] }[];
  }[],
): Transcript {
  return {
    schema_version: "harness.transcript/v1",
    engine: "test",
    sources: sources.map((s) => ({
      source_id: s.source_id,
      language: "en",
      alignment: s.alignment,
      segments: s.segments.map((g) => ({ start: g.start, end: g.end, text: g.text, words: g.words ?? [] })),
    })),
  };
}

/** Words on a regular grid, handy when only the gaps between specific words matter. */
export function words(spec: [string, number, number][]): Word[] {
  return spec.map(([word, start, end]) => ({ word, start, end }));
}
