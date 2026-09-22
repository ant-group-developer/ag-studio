/** Checkers for sub-project 5B: `overlays-valid` (runs at `plan-edit`, spec §3), `composition-valid` (runs at
 * `media-compose`, spec §4.5) and `render-valid` (runs at `media-render`, spec §6.2). */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrandProfileSchema,
  CompositionSchema,
  EdlSchema,
  EditStyleSchema,
  libraryBriefSchema,
  NarrationSchema,
  OVERLAY_TEXT_MAX,
  OverlaysSchema,
  RenderReportSchema,
  TimelineSchema,
  type Checker,
  type CheckerInput,
  type Composition,
  type Edl,
  type MediaProber,
  type Narration,
} from "@harness/contracts";
import { countDialogues } from "../media/ass.js";
import { overlayDensityLimit } from "../media/overlays.js";

const skip = (reason: string) => ({ verdict: "skip" as const, evidence: { reason } });

/** `render-valid` acceptance band for the delivered loudness (spec §6.2, global constants). */
const LOUDNESS_MIN_LUFS = -16;
const LOUDNESS_MAX_LUFS = -12;
const TRUE_PEAK_MAX_DBTP = -0.5;
/** Luma standard deviation below which a sampled region counts as "nothing was drawn here" -- a flat fill
 * (letterbox black, a solid backdrop) measures ~0, any real logo or subtitle edge measures far above 4. */
const PAINTED_STDDEV_MIN = 4;
/** Square sampled at the logo corner; comfortably covers the default 140 px logo at a 120 px safe margin. */
const LOGO_PROBE_PX = 260;
/** Fallbacks for a composition whose brand directory is unreadable -- the same defaults `BrandProfileSchema`
 * itself applies to `safe_margin_px` / `subtitles.size_px`. */
const DEFAULT_SAFE_MARGIN_PX = 120;
const DEFAULT_SUBTITLE_SIZE_PX = 88;

/** Same ceiling `media/watch.ts` puts on its own synchronous ffmpeg calls: a frame extract that has not
 * finished in five minutes is wedged, and a checker must not hang the verifier waiting for it. */
const FFMPEG_TIMEOUT_MS = 300_000;

/** Standard deviation of one gray frame's luma, sampled at `t` seconds inside `crop`; `null` when ffmpeg
 * could not produce the frame at all -- including when it was killed on `FFMPEG_TIMEOUT_MS`, which
 * `spawnSync` reports as a non-zero/null status, so the caller reads it as "frame extract failed" like any
 * other extraction failure. Synchronous on purpose: checkers already shell out this way
 * (`media-checkers.ts`'s `volumedetect`), and one frame of a 260x260 crop is a few milliseconds. */
function frameStdDev(ffmpeg: string, file: string, t: number, crop: { w: number; h: number; x: number; y: number }): number | null {
  const r = spawnSync(
    ffmpeg,
    ["-hide_banner", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},format=gray`, "-f", "rawvideo", "-"],
    { maxBuffer: 64 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS },
  );
  if (r.status !== 0) return null;
  const buf = r.stdout;
  if (!buf || buf.length === 0) return null;
  let sum = 0;
  for (const byte of buf) sum += byte;
  const mean = sum / buf.length;
  let variance = 0;
  for (const byte of buf) variance += (byte - mean) ** 2;
  return Math.sqrt(variance / buf.length);
}

/** `safe_margin_px` / `subtitles.size_px` from the composition's own brand directory, so the sampled caption
 * band matches where `overlay.ass` actually drew; schema defaults when there is no readable brand. */
function brandLayout(composition: Composition): { safe: number; subtitleSize: number } {
  const dir = composition.brand?.dir;
  if (dir !== undefined) {
    try {
      const parsed = BrandProfileSchema.safeParse(JSON.parse(readFileSync(join(dir, "brand.json"), "utf8")));
      if (parsed.success) return { safe: parsed.data.safe_margin_px, subtitleSize: parsed.data.subtitles.size_px };
    } catch {
      // No brand on disk (a hand-run render, or a kho that moved): fall through to the defaults.
    }
  }
  return { safe: DEFAULT_SAFE_MARGIN_PX, subtitleSize: DEFAULT_SUBTITLE_SIZE_PX };
}

/** The `captions` directory of this stage, whether it was produced here (`media-compose`) or consumed as an
 * input (`media-render`, where `captions` comes from the previous stage). */
function captionsDir(input: CheckerInput): string | null {
  const out = input.result.outputs.find((o) => o.kind === "directory" && o.type === "captions");
  if (out) return join(input.workspaceDir, out.path);
  const asInput = input.request.inputs.find((i) => i.type === "captions");
  return asInput ? join(input.workspaceDir, asInput.path) : null;
}

/**
 * `<dir>/captions.srt` must exist, be readable, and hold exactly `expectedCues` blocks -- the one place that
 * rule is written down, shared by `composition-valid` (where the SRT is being produced) and `render-valid`
 * (where it is being shipped). Returns a `fail` verdict to hand straight back, or `null` when the count is
 * right.
 */
function srtBlockCheck(dir: string, expectedCues: number): { verdict: "fail"; evidence: Record<string, unknown> } | null {
  const srtPath = join(dir, "captions.srt");
  if (!existsSync(srtPath)) return { verdict: "fail", evidence: { path: srtPath, reason: "missing captions.srt" } };
  let srtText: string;
  try {
    srtText = readFileSync(srtPath, "utf8");
  } catch (e) {
    return { verdict: "fail", evidence: { path: srtPath, reason: "unreadable captions.srt", error: e instanceof Error ? e.message : String(e) } };
  }
  const blocks = srtText.trim().length === 0 ? 0 : srtText.split(/\r?\n\r?\n/).map((b) => b.trim()).filter((b) => b.length > 0).length;
  if (blocks !== expectedCues) {
    return { verdict: "fail", evidence: { reason: "captions.srt block count mismatch", expected: expectedCues, actual: blocks } };
  }
  return null;
}

/** `<workspaceDir>/<request input of this type>.path`, JSON-parsed and schema-validated; `undefined` when
 * there is no such input, the file is unreadable/unparsable, or it fails the schema -- every caller here
 * treats "no usable value" as "fall back to the default", never as an error. */
function readInput<T>(input: { request: { inputs: { type: string; path: string }[] }; workspaceDir: string }, type: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | undefined {
  const found = input.request.inputs.find((i) => i.type === type);
  if (!found) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(join(input.workspaceDir, found.path), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Kho/timeline-agnostic checkers for the sub-project 5B composition pipeline (Task 5):
 *
 * `overlays-valid` validates the optional `overlays.json` an agent drafts at `plan-edit` (spec §3), reading
 * `narration`/`edl` from the SAME stage result (`plan-edit` produces all three) -- there is no `timeline.json`
 * yet at this point, so `word_index` is checked against the narration line's own `text` (whitespace-split),
 * and a `speech_index` anchor is not checked at all (nothing to resolve it against pre-fit).
 *
 * `composition-valid` validates `composition.json` against the `timeline.json` input it was built from, plus
 * the sibling `overlay_ass`/`captions` outputs of the same `media-compose` stage -- the render-plan invariants
 * spec §4.5 locks down (segments identical to the timeline, events/cues within range and non-overlapping, the
 * ASS/SRT dialogue and cue counts matching, transition bookkeeping balanced, and every path it names on disk).
 *
 * `render-valid` (Task 7) closes the loop at `media-render`: the rendered `full-episode.mp4` is probed
 * against the very `composition.json` it was built from, `render-report.json`'s measured loudness must land
 * in the delivery band, and the burned-in overlays are sampled frame by frame -- see its own comment below.
 * It is the only one of the three that needs a working `MediaProber` (and ffmpeg), and so the only one that
 * degrades to `skip` when `opts.available === false`.
 */
export function compositionCheckers(opts: { prober: MediaProber; available?: boolean; ffmpeg?: string }): Checker[] {
  const prober = opts.prober;
  const ffmpeg = opts.ffmpeg ?? "ffmpeg";

  const overlaysValid: Checker = {
    id: "overlays-valid",
    version: "1.0.0",
    async check(input) {
      const overlaysOut = input.result.outputs.find((o) => o.type === "overlays");
      if (!overlaysOut) return skip("no matching output");

      const overlaysPath = join(input.workspaceDir, overlaysOut.path);
      let overlaysJson: unknown;
      try {
        overlaysJson = JSON.parse(readFileSync(overlaysPath, "utf8"));
      } catch (e) {
        return { verdict: "fail", evidence: { path: overlaysOut.path, reason: "unreadable", error: e instanceof Error ? e.message : String(e) } };
      }
      const parsedOverlays = OverlaysSchema.safeParse(overlaysJson);
      if (!parsedOverlays.success) {
        return { verdict: "fail", evidence: { path: overlaysOut.path, reason: "invalid overlays", issues: parsedOverlays.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
      }
      const overlays = parsedOverlays.data;

      for (const item of overlays.items) {
        const max = OVERLAY_TEXT_MAX[item.kind];
        if (item.text.length > max) {
          return { verdict: "fail", evidence: { id: item.id, reason: "text exceeds limit", kind: item.kind, max, actual: item.text.length } };
        }
      }

      const seenIds = new Set<string>();
      for (const item of overlays.items) {
        if (seenIds.has(item.id)) return { verdict: "fail", evidence: { id: item.id, reason: "duplicate id" } };
        seenIds.add(item.id);
      }

      const narrationOut = input.result.outputs.find((o) => o.type === "narration");
      let narration: Narration | null = null;
      if (narrationOut) {
        try {
          const parsedNarration = NarrationSchema.safeParse(JSON.parse(readFileSync(join(input.workspaceDir, narrationOut.path), "utf8")));
          if (parsedNarration.success) narration = parsedNarration.data;
        } catch {
          narration = null;
        }
      }

      const edlOut = input.result.outputs.find((o) => o.type === "edl");
      if (!edlOut) return { verdict: "fail", evidence: { reason: "no edl output" } };
      let edl: Edl;
      try {
        const parsedEdl = EdlSchema.safeParse(JSON.parse(readFileSync(join(input.workspaceDir, edlOut.path), "utf8")));
        if (!parsedEdl.success) return { verdict: "fail", evidence: { path: edlOut.path, reason: "invalid edl output", issues: parsedEdl.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        edl = parsedEdl.data;
      } catch (e) {
        return { verdict: "fail", evidence: { path: edlOut.path, reason: "unreadable edl output", error: e instanceof Error ? e.message : String(e) } };
      }
      const edlOrders = new Set(edl.entries.map((e) => e.order));

      const titleOrderOwner = new Map<number, string>();
      for (const item of overlays.items) {
        const anchor = item.anchor;
        let resolvedEdlOrder: number | null = null;

        if ("line_id" in anchor) {
          const line = narration?.lines.find((l) => l.line_id === anchor.line_id);
          if (!line) return { verdict: "fail", evidence: { id: item.id, reason: "anchor line_id not found", line_id: anchor.line_id } };
          if (anchor.word_index !== undefined) {
            const wordCount = line.text.split(/\s+/).filter((w) => w.length > 0).length;
            if (anchor.word_index >= wordCount) {
              return { verdict: "fail", evidence: { id: item.id, reason: "anchor word_index out of range", word_index: anchor.word_index, word_count: wordCount } };
            }
          }
          resolvedEdlOrder = line.edl_order;
        } else if ("edl_order" in anchor) {
          if (!edlOrders.has(anchor.edl_order)) return { verdict: "fail", evidence: { id: item.id, reason: "anchor edl_order not found", edl_order: anchor.edl_order } };
          resolvedEdlOrder = anchor.edl_order;
        }
        // `speech_index` anchors are never checked here -- spec §3: no `timeline.json` yet to resolve them against.

        if (item.kind === "title" && resolvedEdlOrder !== null) {
          const owner = titleOrderOwner.get(resolvedEdlOrder);
          if (owner !== undefined) {
            return { verdict: "fail", evidence: { reason: "more than one title per edl_order", edl_order: resolvedEdlOrder, ids: [owner, item.id] } };
          }
          titleOrderOwner.set(resolvedEdlOrder, item.id);
        }
      }

      for (const t of overlays.transitions) {
        if (!edlOrders.has(t.before_order)) {
          return { verdict: "fail", evidence: { reason: "transition before_order not found", before_order: t.before_order } };
        }
      }

      const editStyle = readInput(input, "edit_style", EditStyleSchema);
      const density = editStyle?.params.text_overlay.density ?? "medium";
      const brief = readInput(input, "brief", libraryBriefSchema);
      const language = brief?.language ?? "vi";
      // `density: "none"` (an edit style that calls for zero overlays) has no spacing constant of its own --
      // a limit of 0 is the only reading consistent with what "none" means, not a design decision left open.
      const limit = density === "none" ? 0 : overlayDensityLimit({ narration, edl, language, density });
      if (overlays.items.length > limit) {
        return { verdict: "fail", evidence: { reason: "overlay density exceeds limit", density, limit, actual: overlays.items.length } };
      }

      return { verdict: "pass", evidence: { checked: overlaysOut.path } };
    },
  };

  const compositionValid: Checker = {
    id: "composition-valid",
    version: "1.0.0",
    async check(input) {
      const compOut = input.result.outputs.find((o) => o.type === "composition");
      if (!compOut) return skip("no matching output");

      const compPath = join(input.workspaceDir, compOut.path);
      let compJson: unknown;
      try {
        compJson = JSON.parse(readFileSync(compPath, "utf8"));
      } catch (e) {
        return { verdict: "fail", evidence: { path: compOut.path, reason: "unreadable", error: e instanceof Error ? e.message : String(e) } };
      }
      const parsedComp = CompositionSchema.safeParse(compJson);
      if (!parsedComp.success) {
        return { verdict: "fail", evidence: { path: compOut.path, reason: "invalid composition", issues: parsedComp.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
      }
      const composition = parsedComp.data;

      const timelineInput = input.request.inputs.find((i) => i.type === "timeline");
      if (!timelineInput) return { verdict: "fail", evidence: { reason: "no timeline input" } };
      let timelineJson: unknown;
      try {
        timelineJson = JSON.parse(readFileSync(join(input.workspaceDir, timelineInput.path), "utf8"));
      } catch (e) {
        return { verdict: "fail", evidence: { path: timelineInput.path, reason: "unreadable timeline input", error: e instanceof Error ? e.message : String(e) } };
      }
      const parsedTimeline = TimelineSchema.safeParse(timelineJson);
      if (!parsedTimeline.success) {
        return { verdict: "fail", evidence: { path: timelineInput.path, reason: "invalid timeline input", issues: parsedTimeline.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
      }
      const timeline = parsedTimeline.data;

      if (composition.segments.length !== timeline.video.length) {
        return { verdict: "fail", evidence: { reason: "segment count mismatch", expected: timeline.video.length, actual: composition.segments.length } };
      }
      // Matched by `order`, not array index (fix round 1, Important 2): `buildComposition` builds `segments`
      // from an order-sorted copy of `timeline.video`, so a `timeline.json` whose own `video[]` is not
      // order-ascending would otherwise compare the wrong pair of entries here even though the composition
      // itself is correct.
      const timelineByOrder = new Map(timeline.video.map((t) => [t.order, t]));
      for (const seg of composition.segments) {
        const t = timelineByOrder.get(seg.order);
        if (!t) return { verdict: "fail", evidence: { reason: "segment order not found in timeline", order: seg.order } };
        if (seg.source_id !== t.source_id) return { verdict: "fail", evidence: { reason: "segment field mismatch", order: t.order, field: "source_id", expected: t.source_id, actual: seg.source_id } };
        for (const field of ["in", "out", "start", "end"] as const) {
          if (Math.abs(seg[field] - t[field]) > 0.001) {
            return { verdict: "fail", evidence: { reason: "segment field mismatch", order: t.order, field, expected: t[field], actual: seg[field] } };
          }
        }
      }

      const total = composition.total_seconds;
      for (const ev of composition.text_events) {
        if (ev.start < -0.001 || ev.end > total + 0.001) {
          return { verdict: "fail", evidence: { reason: "text_event outside total_seconds", id: ev.id, start: ev.start, end: ev.end, total } };
        }
      }
      for (const cue of composition.captions.cues) {
        if (cue.start < -0.001 || cue.end > total + 0.001) {
          return { verdict: "fail", evidence: { reason: "cue outside total_seconds", index: cue.index, start: cue.start, end: cue.end, total } };
        }
      }
      for (let i = 0; i < composition.captions.cues.length - 1; i++) {
        const cur = composition.captions.cues[i]!;
        const next = composition.captions.cues[i + 1]!;
        if (next.start < cur.end - 0.001) {
          return { verdict: "fail", evidence: { reason: "cues overlap", index: cur.index, next_index: next.index } };
        }
      }

      const assOut = input.result.outputs.find((o) => o.type === "overlay_ass");
      if (!assOut) return { verdict: "fail", evidence: { reason: "no overlay_ass output" } };
      let assText: string;
      try {
        assText = readFileSync(join(input.workspaceDir, assOut.path), "utf8");
      } catch (e) {
        return { verdict: "fail", evidence: { path: assOut.path, reason: "unreadable overlay_ass", error: e instanceof Error ? e.message : String(e) } };
      }
      const expectedDialogues = (composition.captions.mode === "none" ? 0 : composition.captions.cues.length) + composition.text_events.length;
      const actualDialogues = countDialogues(assText);
      if (actualDialogues !== expectedDialogues) {
        return { verdict: "fail", evidence: { reason: "overlay_ass dialogue count mismatch", expected: expectedDialogues, actual: actualDialogues } };
      }

      const captionsOut = input.result.outputs.find((o) => o.kind === "directory" && o.type === "captions");
      if (!captionsOut) return { verdict: "fail", evidence: { reason: "no captions output" } };
      const srtFailure = srtBlockCheck(join(input.workspaceDir, captionsOut.path), composition.captions.cues.length);
      if (srtFailure) return srtFailure;

      if (composition.transitions.applied + composition.transitions.downgraded.length !== composition.transitions.requested) {
        return { verdict: "fail", evidence: { reason: "transitions applied+downgraded != requested", ...composition.transitions } };
      }

      for (const seg of composition.segments) {
        if (!existsSync(seg.source_path)) return { verdict: "fail", evidence: { reason: "source_path missing", order: seg.order, path: seg.source_path } };
      }
      for (const n of composition.narration) {
        if (!existsSync(n.wav)) return { verdict: "fail", evidence: { reason: "narration wav missing", line_id: n.line_id, path: n.wav } };
      }
      if (composition.music !== null && !existsSync(composition.music.path)) {
        return { verdict: "fail", evidence: { reason: "music path missing", path: composition.music.path } };
      }
      if (composition.logo !== null && !existsSync(composition.logo.path)) {
        return { verdict: "fail", evidence: { reason: "logo path missing", path: composition.logo.path } };
      }
      if (composition.brand !== null && !existsSync(composition.brand.fonts_dir)) {
        return { verdict: "fail", evidence: { reason: "brand fonts_dir missing", path: composition.brand.fonts_dir } };
      }

      return { verdict: "pass", evidence: { checked: compOut.path } };
    },
  };

  /**
   * `render-valid` (spec §6.2): the delivered episode really is the composition that was planned. Probes
   * `episode_video` (one video stream at 3840x2160, the composition's fps, the composition's total length,
   * 48 kHz stereo audio), reads the measured loudness out of `render-report.json`, counts the SRT cues, and
   * -- because a probe cannot tell a burned-in overlay from a missing one -- samples the luma standard
   * deviation of the logo corner and the caption band so a silently-dropped `ass`/`overlay` filter fails
   * here rather than reaching a channel.
   */
  const renderValid: Checker = {
    id: "render-valid",
    version: "1.0.0",
    async check(input) {
      const videoOut = input.result.outputs.find((o) => o.type === "episode_video");
      const reportOut = input.result.outputs.find((o) => o.type === "render_report");
      if (!videoOut || !reportOut) return skip("no matching output");

      const compInput = input.request.inputs.find((i) => i.type === "composition");
      if (!compInput) return { verdict: "fail", evidence: { reason: "no composition input" } };
      let composition: Composition;
      try {
        const parsed = CompositionSchema.safeParse(JSON.parse(readFileSync(join(input.workspaceDir, compInput.path), "utf8")));
        if (!parsed.success) return { verdict: "fail", evidence: { path: compInput.path, reason: "invalid composition input", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        composition = parsed.data;
      } catch (e) {
        return { verdict: "fail", evidence: { path: compInput.path, reason: "unreadable composition input", error: e instanceof Error ? e.message : String(e) } };
      }

      let report;
      try {
        const parsed = RenderReportSchema.safeParse(JSON.parse(readFileSync(join(input.workspaceDir, reportOut.path), "utf8")));
        if (!parsed.success) return { verdict: "fail", evidence: { path: reportOut.path, reason: "invalid render report", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        report = parsed.data;
      } catch (e) {
        return { verdict: "fail", evidence: { path: reportOut.path, reason: "unreadable render report", error: e instanceof Error ? e.message : String(e) } };
      }

      const videoPath = join(input.workspaceDir, videoOut.path);
      const probed = await prober.probe(videoPath);
      if (!probed || !probed.video) return { verdict: "fail", evidence: { path: videoOut.path, reason: "no video stream" } };
      if (probed.video.width !== 3840 || probed.video.height !== 2160) {
        return { verdict: "fail", evidence: { path: videoOut.path, reason: "wrong frame size", width: probed.video.width, height: probed.video.height } };
      }
      const fps = probed.video.fps;
      if (fps === null || Math.abs(fps - composition.output.fps) > 0.01) {
        return { verdict: "fail", evidence: { path: videoOut.path, reason: "fps mismatch", expected: composition.output.fps, actual: fps } };
      }
      const total = composition.total_seconds;
      const duration = probed.duration_seconds;
      if (duration === null || Math.abs(duration - total) > 0.1) {
        return { verdict: "fail", evidence: { path: videoOut.path, reason: "duration mismatch", expected: total, actual: duration } };
      }
      if (!probed.audio) return { verdict: "fail", evidence: { path: videoOut.path, reason: "no audio stream" } };
      if (probed.audio.sample_rate !== 48000 || probed.audio.channels !== 2) {
        return { verdict: "fail", evidence: { path: videoOut.path, reason: "audio not 48 kHz stereo", sample_rate: probed.audio.sample_rate, channels: probed.audio.channels } };
      }

      if (report.loudness === null) return { verdict: "fail", evidence: { reason: "no loudness measurement" } };
      if (report.loudness.integrated_lufs < LOUDNESS_MIN_LUFS || report.loudness.integrated_lufs > LOUDNESS_MAX_LUFS) {
        return { verdict: "fail", evidence: { reason: "integrated loudness out of range", integrated_lufs: report.loudness.integrated_lufs, min: LOUDNESS_MIN_LUFS, max: LOUDNESS_MAX_LUFS } };
      }
      if (report.loudness.true_peak_dbtp > TRUE_PEAK_MAX_DBTP) {
        return { verdict: "fail", evidence: { reason: "true peak too high", true_peak_dbtp: report.loudness.true_peak_dbtp, max: TRUE_PEAK_MAX_DBTP } };
      }

      const capDir = captionsDir(input);
      if (capDir !== null) {
        const srtFailure = srtBlockCheck(capDir, composition.captions.cues.length);
        if (srtFailure) return srtFailure;
      }

      const { safe, subtitleSize } = brandLayout(composition);
      /** Times are clamped into the episode: a very short episode would otherwise be sampled at t < 0. */
      const at = (t: number): number => Math.min(Math.max(t, 0), Math.max(0, total - 0.1));

      if (composition.logo !== null) {
        const x = composition.logo.corner === "left" ? 0 : 3840 - LOGO_PROBE_PX;
        const crop = { w: LOGO_PROBE_PX, h: LOGO_PROBE_PX, x, y: 0 };
        const samples = [at(1), at(total / 2), at(total - 1)].map((t) => ({ t, stddev: frameStdDev(ffmpeg, videoPath, t, crop) }));
        if (samples.some((s) => s.stddev === null)) {
          return { verdict: "fail", evidence: { reason: "frame extract failed", region: "logo", samples: samples.map((s) => s.t) } };
        }
        // 2 of 3: one sampled frame can legitimately land on a dip_black fade, where the whole frame is flat.
        const painted = samples.filter((s) => (s.stddev ?? 0) > PAINTED_STDDEV_MIN).length;
        if (painted < 2) {
          return { verdict: "fail", evidence: { reason: "logo region looks unpainted", min_stddev: PAINTED_STDDEV_MIN, samples: samples.map((s) => ({ t: s.t, stddev: s.stddev })) } };
        }
      }

      const firstCue = composition.captions.cues[0];
      if (composition.captions.mode !== "none" && firstCue !== undefined) {
        const t = at((firstCue.start + firstCue.end) / 2);
        const bandHeight = safe + subtitleSize * 3;
        const crop = { w: 1000, h: bandHeight, x: 1420, y: Math.max(0, 2160 - bandHeight) };
        const stddev = frameStdDev(ffmpeg, videoPath, t, crop);
        if (stddev === null) return { verdict: "fail", evidence: { reason: "frame extract failed", region: "captions", t } };
        if (stddev <= PAINTED_STDDEV_MIN) {
          return { verdict: "fail", evidence: { reason: "caption region looks unpainted", min_stddev: PAINTED_STDDEV_MIN, stddev, t } };
        }
      }

      return { verdict: "pass", evidence: { checked: videoOut.path, seconds: duration, integrated_lufs: report.loudness.integrated_lufs } };
    },
  };

  // `render-valid` is the only prober-backed checker of the three; with no ffprobe on the machine it can
  // give no verdict at all, exactly as `mediaCheckers` handles its own five (a `NullMediaProber` answers
  // `null` for every file, which would read as "broken episode").
  const render: Checker = opts.available === false
    ? { ...renderValid, check: async () => skip("no media prober available") }
    : renderValid;

  return [overlaysValid, compositionValid, render];
}
