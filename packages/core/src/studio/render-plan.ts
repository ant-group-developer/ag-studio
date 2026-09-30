/**
 * Timeline v3 -> the render worker's `composition.json` (`harness.composition/v1`).
 *
 * Each clip plays its WHOLE asset (in=0, out=duration_s); the source path is `asset:<id>` which the
 * render worker resolves through Studio's `/farm/sign` endpoint. No TTS narration, no SRT/VTT.
 *
 * Also exports `thumbnailTimes` which picks three representative moments for the `thumbnails` payload
 * field the farm sends to the render worker.
 */
import { createHash } from "node:crypto";
import type { Composition, TimelineV3, YoutubeKit } from "@harness/contracts";
import { layoutTimeline } from "./layout.js";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Stable ULID-shaped id derived from a string, so the same asset keeps its mezzanine cache entry. */
export function stableUlid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest();
  let out = "";
  for (let i = 0; i < 26; i++) out += CROCKFORD[bytes[i]! % 32];
  return CROCKFORD[bytes[0]! % 8] + out.slice(1);
}

/** Build `composition.json` from a frozen Timeline v3. */
export function timelineToComposition(t: TimelineV3): Composition {
  const layout = layoutTimeline(t);
  const hasAudio = !t.source_audio.muted;

  const textEvents: Composition["text_events"] = layout.texts.map((x) => ({
    id: x.text_id,
    kind: x.kind,
    text: x.text,
    start: x.start,
    end: r3(x.start + x.duration),
    position: x.position,
    animation: "fade" as const,
  }));

  const music: Composition["music"] = t.music
    ? {
        track_id: stableUlid(`music:${t.music.track}`),
        path: t.music.track,
        loop: true,
        fade_in: 1.0,
        fade_out: 2.0,
        cues: [{ start: 0, end: layout.duration, gain_db: t.music.gain_db }],
        duck: {
          windows: [],
          gain_db: -8,
          attack_ms: 200,
          release_ms: 500,
        },
      }
    : null;

  return {
    schema_version: "harness.composition/v1",
    output: { width: t.canvas.width, height: t.canvas.height, fps: t.fps, codec: "h264" },
    voice: "none",
    language: t.language,
    total_seconds: layout.duration,
    request_id: `req_${stableUlid(`production:${t.production_id}`)}`,
    brand: null,
    segments: layout.clips.map((c, order) => ({
      order,
      source_id: `src_${stableUlid(`asset:${c.asset_id}`)}`,
      source_path: `asset:${c.asset_id}`,
      in: 0,
      out: r3(c.duration),
      start: c.start,
      end: c.end,
      fit: "scale_pad" as const,
      has_audio: hasAudio,
      transition_out: { kind: "cut" as const, seconds: 0, tail_available: false },
    })),
    text_events: textEvents,
    captions: { mode: "none" as const, cues: [] },
    narration: [],
    music,
    logo: null,
    transitions: { requested: 0, applied: 0, downgraded: [] },
    text_dropped: [],
    warnings: [],
  };
}

/** Three {t_s, text} thumbnail moments.  Each is the middle of the chosen asset's clip in the layout,
 *  or evenly-spaced if the kit's asset is not in the timeline. */
export function thumbnailTimes(
  t: TimelineV3,
  kit: YoutubeKit,
): Array<{ t_s: number; text: string }> {
  const layout = layoutTimeline(t);
  return kit.thumbnails.map((thumb) => {
    const clip = layout.clips.find((c) => c.asset_id === thumb.asset_id);
    const t_s = clip ? r3(clip.start + clip.duration / 2) : r3(layout.duration / 2);
    return { t_s, text: thumb.text };
  });
}
