/**
 * From the approved edit plan of a shot-cut episode to its first timeline v4 (spec local-chat §3.3, plan phase 5 D2):
 * the plan becomes a harness EDL and narration, the read lines its narration timing, harness `fitEdl` reshapes the
 * picture so every line has enough of it ("picture follows voice", ADR-0001 item 106), `buildTimeline` lays it out,
 * and the result is written as a timeline v4. Pure: no I/O.
 */
import {
  DEFAULT_NARRATION_LEAD_SECONDS, EdlSchema, NarrationTimingSchema, TimelineV4Schema,
  type EditPlan, type EpisodeAsset, type FitReport, type NarrationTiming, type ShotsIndex, type StudioCanvas, type StudioMusic,
  type StudioSurvey, type TimelineClipV4, type TimelineV4, type Transcript,
} from "@harness/contracts";
import { buildTimeline, fitEdl } from "@harness/core";

/** The read audio of a narration line (voice store). */
export interface ReadLine { key: string; duration_s: number; words: { word: string; start: number; end: number }[] }

export interface FitCutInput {
  productionId: string;
  plan: EditPlan;
  shots: ShotsIndex;
  survey: StudioSurvey;
  transcript: Transcript | null;
  /** Every narration line of the plan, by `line_id`. */
  voice: Record<string, ReadLine>;
  /** asset of each source of the episode. */
  sources: { asset_id: string; source_id: string }[];
  assets: Record<string, EpisodeAsset>;
  canvas: StudioCanvas;
  fps: 25 | 30;
  music: StudioMusic | null;
}

/** A dissolve, when the plan asks for one: the harness brand default length. */
const DISSOLVE_SECONDS = 0.4;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The shot of `source_id` holding the middle of `[in, out)` (an appended piece is not one of the plan's shots). */
function shotAt(shots: ShotsIndex, sourceId: string, inS: number, out: number): string | null {
  const mid = (inS + out) / 2;
  const s = shots.sources.find((x) => x.source_id === sourceId)?.shots.find((x) => x.in <= mid && mid < x.out);
  return s?.shot_id ?? null;
}

export function fitCutTimeline(p: FitCutInput): { timeline: TimelineV4; report: FitReport } {
  const { plan } = p;
  const narrated = plan.narration === "tts";
  const anchors = new Map(plan.shots.filter((s) => s.line_id).map((s) => [s.line_id!, s.order]));
  const lines = narrated ? plan.lines.filter((l) => anchors.has(l.line_id)) : [];
  const unread = lines.filter((l) => !p.voice[l.line_id]).map((l) => l.line_id);
  if (unread.length) throw new Error(`narration lines without audio: ${unread.join(", ")}`);

  const edl = EdlSchema.parse({
    schema_version: "harness.edl/v1",
    entries: plan.shots.map((s) => ({ source_id: s.source_id, in: s.in, out: s.out, order: s.order, overlay: null, note: s.note })),
  });
  const timing: NarrationTiming = NarrationTimingSchema.parse({
    schema_version: "harness.narration-timing/v1", voice_id: null, voice_revision: null,
    total_seconds: r3(lines.reduce((sum, l) => sum + p.voice[l.line_id]!.duration_s, 0)),
    lines: lines.map((l) => {
      const v = p.voice[l.line_id]!;
      return {
        line_id: l.line_id, edl_order: anchors.get(l.line_id)!, text: l.text, wav: `voice/${v.key}.wav`, duration_seconds: v.duration_s,
        chunks: [{ text: l.text, start: 0, end: v.duration_s }], words: v.words, alignment: v.words.length ? "word" : "chunk", cached: true,
      };
    }),
  });
  const voice = plan.narration;
  const tolerance = plan.target_seconds * 0.2;
  const fitted = fitEdl({
    edl, timing, shots: p.shots, survey: p.survey, transcript: p.transcript, voice,
    target_duration_seconds: [Math.max(1, plan.target_seconds - tolerance), plan.target_seconds + tolerance],
  });
  const laid = buildTimeline({ edl: fitted.edl, timing, transcript: p.transcript, voice, language: plan.language, orderMap: fitted.orderMap });

  // fitted order -> the plan shot it came from (first and last piece of each)
  const fromPlan = new Map<number, { shot: EditPlan["shots"][number]; first: boolean; last: boolean }>();
  for (const s of plan.shots) {
    const produced = fitted.orderMap.get(s.order) ?? [];
    produced.forEach((o, i) => fromPlan.set(o, { shot: s, first: i === 0, last: i === produced.length - 1 }));
  }
  const assetOf = new Map(p.sources.map((s) => [s.source_id, s.asset_id]));
  const lineAt = new Map(laid.narration.map((n) => {
    const clip = laid.video.find((v) => Math.abs(v.start + DEFAULT_NARRATION_LEAD_SECONDS - n.start) < 1e-3);
    return [clip?.order ?? -1, n.line_id] as const;
  }));
  const video = [...laid.video].sort((a, b) => a.order - b.order);
  const clips: TimelineClipV4[] = video.map((v, i) => {
    const origin = fromPlan.get(v.order);
    const transition = origin?.last && origin.shot.transition === "dissolve" && i < video.length - 1
      ? { kind: "dissolve" as const, seconds: DISSOLVE_SECONDS } : { kind: "cut" as const, seconds: 0 };
    const assetId = assetOf.get(v.source_id);
    if (!assetId) throw new Error(`fitted entry ${v.order} is on an unknown source ${v.source_id}`);
    return {
      clip_id: `C${String(i + 1).padStart(3, "0")}`, asset_id: assetId,
      section_title: origin?.first ? origin.shot.section_title : null,
      in: v.in, out: v.out, shot_id: shotAt(p.shots, v.source_id, v.in, v.out),
      line_id: lineAt.get(v.order) ?? null, transition_out: transition,
    };
  });

  // texts: on the first piece of their shot, offset into it
  const startOf = new Map(video.map((v) => [v.order, v.start]));
  const texts = plan.texts.flatMap((t) => {
    const first = fitted.orderMap.get(t.at_order)?.[0];
    const start = first === undefined ? undefined : startOf.get(first);
    return start === undefined ? [] : [{ text_id: t.text_id, kind: t.kind, text: t.text, start: r3(start + t.offset_s), duration: t.duration, position: t.position }];
  });

  const used = new Set(clips.map((c) => c.asset_id));
  const timeline = TimelineV4Schema.parse({
    schema_version: "studio.timeline/v4",
    production_id: p.productionId, episode_id: plan.episode_id, canvas: p.canvas, fps: p.fps, language: plan.language,
    edit_style: "cut",
    clips, texts,
    narration: {
      voice, lead_seconds: DEFAULT_NARRATION_LEAD_SECONDS,
      lines: lines.map((l) => ({ line_id: l.line_id, text: l.text, audio: { key: p.voice[l.line_id]!.key, duration_s: p.voice[l.line_id]!.duration_s, words: p.voice[l.line_id]!.words } })),
    },
    captions: { mode: narrated ? "burn-in" : "none" },
    music: p.music,
    source_audio: { muted: false },
    assets: Object.fromEntries(Object.entries(p.assets).filter(([id]) => used.has(id))),
    alternates: [],
  });
  return { timeline, report: fitted.report };
}
