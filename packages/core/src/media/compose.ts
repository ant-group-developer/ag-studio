/** Composes the pieces from Tasks 2-4 (brand/music library, captions, overlays, transitions, music plan) into
 * one `composition.json` plus the `overlay.ass`/`captions.srt`/`captions.vtt` text it implies -- sub-project
 * 5B Task 5, spec §4.5. Pure: no I/O, no clock, no randomness beyond `selectTrack`'s deterministic hash of
 * `request_id`. Every path this function writes into `composition.json` (`source_path`, narration `wav`,
 * `music.path`, `logo.path`, `brand.fonts_dir`) is resolved by the caller and handed in already-absolute --
 * `compose.ts` itself never touches the filesystem, so `composition-valid` is the only thing that ever checks
 * those paths actually exist. */
import { basename, join } from "node:path";
import { HarnessError, type Composition, type CompositionSegment, type Edl, type MediaConfig, type MusicTrack, type Narration, type Overlays, type SubtitleMode, type TextEvent, type Timeline } from "@harness/contracts";
import { CompositionSchema } from "@harness/contracts";
import type { LoadedBrand } from "../library/brands.js";
import { buildAss } from "./ass.js";
import { buildCaptionCues, toSrt, toVtt } from "./captions.js";
import { buildMusicPlan, selectTrack } from "./music.js";
import { assignTransitions } from "./transitions.js";
import { placeOverlays, raiseCaptions } from "./overlays.js";

/** A brand's `subtitles.max_chars_per_line`/`max_lines` default (`BrandProfileSchema`'s own defaults) --
 * used for caption wrapping when there is no brand to read them from (cues are still computed for SRT/VTT
 * even with no brand -- brief decision). */
const DEFAULT_MAX_CHARS_PER_LINE = 42;
const DEFAULT_MAX_LINES = 2;

const FPS_CANDIDATES = [24, 25, 30, 50, 60] as const;

export interface ComposeInput {
  timeline: Timeline;
  overlays: Overlays | null;
  narration: Narration | null;
  edl: Edl;
  brand: LoadedBrand | null;
  /** Already filtered to the brand's active tracks (`activeTracks`) -- `buildComposition` never touches the
   * library store itself. */
  tracks: MusicTrack[];
  trackPath: (t: MusicTrack) => string;
  sources: ReadonlyMap<string, { path: string; duration_seconds: number; has_audio: boolean; fps: number | null }>;
  voiceSetDir: string | null;
  request_id: string;
  subtitlesOverride?: SubtitleMode;
  render: MediaConfig["render"];
}

/** Snaps a vote-winning fps to the nearest of the five the harness ever encodes at. */
function snapFps(fps: number): (typeof FPS_CANDIDATES)[number] {
  let best: (typeof FPS_CANDIDATES)[number] = FPS_CANDIDATES[0];
  let bestDist = Infinity;
  for (const c of FPS_CANDIDATES) {
    const d = Math.abs(fps - c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** `output.fps`: the configured number if `render.fps` is not `"auto"`; otherwise the fps with the most
 * total screen time across `timeline.video[]` (sources with `fps: null` never vote; a segment whose source is
 * entirely absent from `sources` never votes either -- `buildComposition` still requires that source to exist
 * once it gets to building `segments`, this just never counts it toward fps), snapped to the nearest of
 * `{24,25,30,50,60}`; no votes at all -> 30 -- spec §4.5.
 */
function computeFps(p: { timeline: Timeline; sources: ComposeInput["sources"]; renderFps: MediaConfig["render"]["fps"] }): number {
  if (p.renderFps !== "auto") return p.renderFps;

  const weightByFps = new Map<number, number>();
  for (const seg of p.timeline.video) {
    const source = p.sources.get(seg.source_id);
    if (!source || source.fps === null) continue;
    weightByFps.set(source.fps, (weightByFps.get(source.fps) ?? 0) + (seg.out - seg.in));
  }
  if (weightByFps.size === 0) return 30;

  let bestFps = 30;
  let bestWeight = -Infinity;
  for (const [fps, weight] of weightByFps) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bestFps = fps;
    }
  }
  return snapFps(bestFps);
}

function requireSource(sources: ComposeInput["sources"], sourceId: string): { path: string; duration_seconds: number; has_audio: boolean; fps: number | null } {
  const source = sources.get(sourceId);
  if (!source) {
    throw new HarnessError("CONFIG_INVALID", `no source entry for source_id ${sourceId}`, { source_id: sourceId });
  }
  return source;
}

export function buildComposition(p: ComposeInput): { composition: Composition; srt: string; vtt: string; ass: string } {
  const { timeline } = p;
  const brandProfile = p.brand?.brand ?? null;

  const fps = computeFps({ timeline, sources: p.sources, renderFps: p.render.fps });

  const sourceDurations = new Map<string, number>();
  for (const [sourceId, source] of p.sources) sourceDurations.set(sourceId, source.duration_seconds);
  const { transition_out, summary: transitionsSummary } = assignTransitions({ timeline, overlays: p.overlays, brand: brandProfile, sourceDurations });

  const fit = brandProfile?.source_fit ?? "scale_pad";
  // `assignTransitions` sorts its own copy of `timeline.video` by `order` before building `transition_out`
  // (fix round 1, Important 2), so `segments` has to walk the SAME order-sorted sequence -- otherwise
  // `transition_out[k]` (indexed into the sorted array) would zip onto the wrong segment whenever the caller
  // hands in a `timeline.video` that is not already order-ascending.
  const sortedVideo = [...timeline.video].sort((a, b) => a.order - b.order);
  const segments: CompositionSegment[] = sortedVideo.map((seg, k) => {
    const source = requireSource(p.sources, seg.source_id);
    return {
      order: seg.order,
      source_id: seg.source_id,
      source_path: source.path,
      in: seg.in,
      out: seg.out,
      start: seg.start,
      end: seg.end,
      fit,
      has_audio: source.has_audio,
      transition_out: transition_out[k]!,
    };
  });

  // Text events: `placeOverlays` needs a brand (text-kind sizes/positions/seconds come from it); with no
  // brand, an agent-drafted `overlays.json` is simply not renderable, so its items are dropped wholesale with
  // one warning rather than resolved against nothing.
  let textEvents: TextEvent[] = [];
  let textDropped: Composition["text_dropped"] = [];
  let overlayWarnings: string[] = [];
  if (p.brand !== null && brandProfile !== null) {
    const logoCorner = brandProfile.logo ? { corner: brandProfile.logo.corner } : null;
    const placed = placeOverlays({ overlays: p.overlays, timeline, brand: brandProfile, logo: logoCorner });
    textEvents = placed.events;
    textDropped = placed.dropped;
    overlayWarnings = placed.warnings;
  } else if (p.overlays !== null && p.overlays.items.length > 0) {
    overlayWarnings = ["overlays_ignored_no_brand"];
  }

  // `subtitlesOverride` only ever picks a mode BETWEEN what a brand offers -- with no brand there is no font,
  // no highlight color, no `buildAss` styling at all, so `buildAss` always emits zero Dialogue lines
  // regardless of `mode` (fix round 1, Important 1). Letting an override force "karaoke"/"burn-in" here would
  // produce a `captions.mode` that promises burned-in text the ASS can never deliver, and would fail
  // `composition-valid`'s own dialogue-count check the moment cues are non-empty.
  const mode: SubtitleMode = brandProfile !== null ? (p.subtitlesOverride ?? brandProfile.subtitles.mode) : "none";
  const maxCharsPerLine = brandProfile?.subtitles.max_chars_per_line ?? DEFAULT_MAX_CHARS_PER_LINE;
  const maxLines = brandProfile?.subtitles.max_lines ?? DEFAULT_MAX_LINES;
  const { cues: rawCues, warnings: captionWarnings } = buildCaptionCues({ timeline, max_chars_per_line: maxCharsPerLine, max_lines: maxLines });
  const cues = brandProfile !== null ? raiseCaptions(rawCues, textEvents, brandProfile) : rawCues;
  const captions: Composition["captions"] = {
    mode,
    cues,
    ...(timeline.voice === "none" ? { reason: "voice_none" } : {}),
  };

  let music: Composition["music"] = null;
  let musicReason: string | undefined;
  const musicWarnings: string[] = [];
  if (p.brand === null || brandProfile === null) {
    musicReason = "no_brand";
  } else if (brandProfile.music.tracks.length === 0) {
    musicReason = "brand_no_tracks";
  } else {
    const picked = selectTrack({ tracks: p.tracks, mood: p.overlays?.music?.mood, request_id: p.request_id });
    musicWarnings.push(...picked.warnings);
    if (picked.track === null) {
      musicReason = picked.reason ?? "no_candidates";
    } else {
      const plan = buildMusicPlan({ track: picked.track, path: p.trackPath(picked.track), brand: brandProfile, timeline });
      music = plan.music;
      musicWarnings.push(...plan.warnings);
    }
  }

  const logo: Composition["logo"] =
    p.brand !== null && brandProfile !== null && brandProfile.logo !== undefined && p.brand.logo_path !== null
      ? { path: p.brand.logo_path, corner: brandProfile.logo.corner, opacity: brandProfile.logo.opacity, height_px: brandProfile.logo.height_px }
      : null;

  if (timeline.voice === "tts" && p.voiceSetDir === null) {
    throw new HarnessError("CONFIG_INVALID", "voice: tts requires a voice_set directory to resolve narration wav paths", { request_id: p.request_id });
  }
  const voiceSetDir = p.voiceSetDir;
  const narration: Composition["narration"] = timeline.narration.map((n) => ({
    line_id: n.line_id,
    wav: voiceSetDir !== null ? join(voiceSetDir, basename(n.wav)) : n.wav,
    start: n.start,
    end: n.end,
  }));

  const brand: Composition["brand"] =
    p.brand === null
      ? null
      : { channel_id: p.brand.brand.channel_id, revision: p.brand.brand.revision, dir: p.brand.dir, fonts_dir: p.brand.fonts_dir, checksums: p.brand.brand.checksums };

  const composition = CompositionSchema.parse({
    schema_version: "harness.composition/v1",
    output: { width: 3840, height: 2160, fps, codec: p.render.codec },
    voice: timeline.voice,
    language: timeline.language,
    total_seconds: timeline.total_seconds,
    request_id: p.request_id,
    brand,
    segments,
    text_events: textEvents,
    captions,
    music,
    ...(musicReason !== undefined ? { music_reason: musicReason } : {}),
    logo,
    narration,
    transitions: transitionsSummary,
    text_dropped: textDropped,
    warnings: [...captionWarnings, ...overlayWarnings, ...musicWarnings],
  });

  const ass = buildAss({
    brand: brandProfile,
    mode: composition.captions.mode,
    cues: composition.captions.cues,
    text_events: composition.text_events,
    logo: composition.logo !== null ? { corner: composition.logo.corner, height_px: composition.logo.height_px } : null,
  });

  return { composition, srt: toSrt(composition.captions.cues), vtt: toVtt(composition.captions.cues), ass };
}
