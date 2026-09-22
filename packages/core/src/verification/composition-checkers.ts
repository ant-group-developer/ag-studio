/** Checkers for sub-project 5B: `overlays-valid` (runs at `plan-edit`, spec §3) and `composition-valid` (runs
 * at `media-compose`, spec §4.5). `render-valid` is Task 7's -- the export below leaves a named spot for it
 * but does not implement it yet. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CompositionSchema,
  EdlSchema,
  EditStyleSchema,
  libraryBriefSchema,
  NarrationSchema,
  OVERLAY_TEXT_MAX,
  OverlaysSchema,
  TimelineSchema,
  type Checker,
  type Edl,
  type MediaProber,
  type Narration,
} from "@harness/contracts";
import { countDialogues } from "../media/ass.js";
import { overlayDensityLimit } from "../media/overlays.js";

const skip = (reason: string) => ({ verdict: "skip" as const, evidence: { reason } });

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
 */
export function compositionCheckers(opts: { prober: MediaProber; available?: boolean; ffmpeg?: string }): Checker[] {
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
      const srtPath = join(input.workspaceDir, captionsOut.path, "captions.srt");
      if (!existsSync(srtPath)) return { verdict: "fail", evidence: { path: srtPath, reason: "missing captions.srt" } };
      let srtText: string;
      try {
        srtText = readFileSync(srtPath, "utf8");
      } catch (e) {
        return { verdict: "fail", evidence: { path: srtPath, reason: "unreadable captions.srt", error: e instanceof Error ? e.message : String(e) } };
      }
      const srtBlockCount = srtText.trim().length === 0 ? 0 : srtText.split(/\r?\n\r?\n/).map((b) => b.trim()).filter((b) => b.length > 0).length;
      if (srtBlockCount !== composition.captions.cues.length) {
        return { verdict: "fail", evidence: { reason: "captions.srt block count mismatch", expected: composition.captions.cues.length, actual: srtBlockCount } };
      }

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

  // `render-valid` (Task 7): validates `render-report.json` (loudness, output dims, encoder) against
  // `composition.json` once `media-render` exists. Not implemented here.

  return [overlaysValid, compositionValid];
}
