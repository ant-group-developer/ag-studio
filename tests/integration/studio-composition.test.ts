// Sub-project 5B Task 10: the FIRST end-to-end drive of `library-production@1.3.0`. Tasks 1-9 tested every
// piece in isolation -- the pure composers by snapshot, `media compose`/`media render` as single stages
// through a hand-built workspace (`packages/cli/test/composition-stages.test.ts`) -- but nothing has yet run
// a branded 4K episode with burned-in karaoke captions, a logo, music and dissolves through all 15 stages of
// a real autopilot loop. This does, with the fake agent CLI and `FakeMediaEngine` standing in for
// `claude -p` / WhisperX / OmniVoice, real ffmpeg for every frame, and no studio command beyond
// `worker --once`.
//
// The render is a CPU render on any machine without a working NVENC (this one included: the driver is too
// old), so nothing here asserts `encoder: "nvenc"` -- `render-report.encoder` is read but not pinned.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type Composition, type LibraryItem, type RenderReport, type Timeline } from "@harness/contracts";
import { SqliteStateStore } from "@harness/core";
import { ffprobeDuration, hasFfmpeg, systemFontPath } from "../media.js";
import {
  addTrack, addVoice, artifactPathFor, freshLibraryWorld, ingestShoot, requestCreate, requestStatus, setBrand,
  status, studioWorkerUntil, writeActiveStyle,
} from "./library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const CHANNEL_ID = "channel-one";

/** Every stage of `library-production@1.3.0` (spec §6.1): 15 keys, with `cut`/`assemble` gone. */
const STAGE_KEYS = [
  "intake", "media-index", "media-transcribe", "watch-source", "survey-source", "plan-edit", "media-tts",
  "media-fit-edl", "media-compose", "media-render", "watch-episode", "thumbnail-candidates", "library-export",
  "library-review", "library-apply-review",
];

/** Every stage's state plus, for the stages that did not succeed, the check verdicts of their last attempt --
 * an assertion message that says WHY a run stopped instead of just which state it ended in (copied from
 * `studio-media.test.ts`, which introduced it for the same reason). */
function why(project: string, runId: string): string {
  const store = new SqliteStateStore(join(project, "data", "state", "harness.db"));
  try {
    return JSON.stringify(
      store.listStageRuns(runId).map((s) => {
        if (s.state === "SUCCEEDED" || s.state === "PENDING") return [s.stage_key, s.state];
        const attempt = store.listAttempts(s.stage_run_id).at(-1);
        const checks = attempt ? store.listCheckResults(attempt.attempt_id).filter((c) => c.verdict !== "pass").map((c) => [c.check_id, c.verdict, c.evidence]) : [];
        return [s.stage_key, s.state, attempt?.error_summary ?? null, checks];
      }),
    );
  } finally {
    store.close();
  }
}

function ffprobeFrameSize(path: string): { width: number; height: number } | null {
  const r = spawnSync(process.env.FFPROBE_PATH ?? "ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path,
  ], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const [w, h] = r.stdout.trim().split("x").map(Number);
  return w !== undefined && h !== undefined ? { width: w, height: h } : null;
}

const hasFont = systemFontPath() !== undefined;

describe.skipIf(!hasFfmpeg() || !hasFont)("studio composition: library-production@1.3.0 end to end, branded 4K with karaoke captions and music", () => {
  it("runs a branded three-clip shoot through all 15 stages into an approved item, and a second request hits the mezzanine cache", () => {
    const world = freshLibraryWorld({ media: false, media1_3: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const voiceId = addVoice(world);

    // Brand and music are CHANNEL-owned (the only role allowed to write under brands/** and music/**); the
    // brand names the track, so the track has to exist first.
    addTrack(world, "calm-01", { mood: ["calm"], seconds: 8, loopOk: true, frequency: 220 });
    expect(
      setBrand(world, CHANNEL_ID, { withLogo: true, tracks: ["calm-01"], subtitles: "karaoke", transition: { kind: "dissolve", seconds: 0.4 } }),
      "no system font on this machine: the branded scenario cannot run",
    ).toBe(true);

    const sourceIds = ingestShoot(world, "shoot-a", 3, { withAudio: true });
    expect(sourceIds).toHaveLength(3);

    const requestId = requestCreate(world, {
      topic: "Buổi quay có chữ và nhạc", style: styleId, sourceHint: "shoot-a",
      voice: "tts", voiceId, duration: [5, 120], language: "en",
    });
    expect(requestStatus(world, requestId).status).toBe("open");

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 400, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");
    const itemId = fulfilled.item_ids[0]!;

    const manifest = readJson<LibraryItem>(join(world.lib, "items", itemId, "manifest.json"));
    expect(manifest.status).toBe("approved");
    const runId = manifest.lineage.run_id;

    // ---- the run itself: 1.3.0, all 15 stages SUCCEEDED, no `cut`/`assemble` ----
    const final = status(world.studio, runId);
    expect(final.run.state, why(world.studio, runId)).toBe("SUCCEEDED");
    expect(final.stages.map((s) => s.stage_key).sort()).toEqual([...STAGE_KEYS].sort());
    expect(final.stages.map((s) => s.stage_key)).not.toContain("cut");
    expect(final.stages.map((s) => s.stage_key)).not.toContain("assemble");
    for (const s of final.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");

    const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      const run = store.getRun(runId)!;
      expect(`${run.workflow_release.id}@${run.workflow_release.version}`).toBe("library-production@1.3.0");
    } finally {
      store.close();
    }

    // ---- the timeline invariant: composition.segments mirror timeline.video exactly ----
    const timeline = readJson<Timeline>(artifactPathFor(world.studio, runId, "media-fit-edl", "timeline")!);
    const composition = readJson<Composition>(artifactPathFor(world.studio, runId, "media-compose", "composition")!);
    const shape = (v: { order: number; source_id: string; in: number; out: number; start: number; end: number }) =>
      ({ order: v.order, source_id: v.source_id, in: v.in, out: v.out, start: v.start, end: v.end });
    expect(composition.segments.map(shape)).toEqual([...timeline.video].sort((a, b) => a.order - b.order).map(shape));
    expect(composition.total_seconds).toBe(timeline.total_seconds);
    expect(composition.brand?.channel_id).toBe(CHANNEL_ID);
    expect(composition.captions.mode).toBe("karaoke");
    expect(composition.captions.cues.length).toBeGreaterThan(0);
    expect(composition.logo).not.toBeNull();
    expect(composition.music?.track_id).toBe("calm-01");

    // ---- the delivered episode ----
    const episode = artifactPathFor(world.studio, runId, "media-render", "episode_video")!;
    expect(ffprobeFrameSize(episode)).toEqual({ width: 3840, height: 2160 });
    const episodeSeconds = ffprobeDuration(episode);
    expect(episodeSeconds, "ffprobe could not read the rendered episode").not.toBeNull();
    expect(Math.abs(episodeSeconds! - composition.total_seconds), `timeline ${composition.total_seconds}s vs episode ${episodeSeconds}s`).toBeLessThanOrEqual(0.1);

    // ---- the kho item carries the captions the composition produced ----
    const srtPath = join(world.lib, "items", itemId, "captions.srt");
    expect(existsSync(srtPath), `${srtPath} missing from the exported item`).toBe(true);
    expect(existsSync(join(world.lib, "items", itemId, "captions.vtt"))).toBe(true);
    const srtBlocks = readFileSync(srtPath, "utf8").trim().split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
    expect(srtBlocks.length).toBe(composition.captions.cues.length);
    expect(srtBlocks.length).toBeGreaterThanOrEqual(1);
    expect(manifest.files.map((f) => f.path)).toContain("captions.srt");
    expect(manifest.files.map((f) => f.path)).toContain("captions.vtt");

    // ---- render-report.json ----
    const report = readJson<RenderReport>(artifactPathFor(world.studio, runId, "media-render", "render_report")!);
    expect(report.brand).toBe("present");
    expect(report.music.track_id).toBe("calm-01");
    expect(report.captions.mode).toBe("karaoke");
    expect(report.captions.cues).toBe(composition.captions.cues.length);
    expect(report.loudness, "no loudness measured: the two-pass loudnorm did not run").not.toBeNull();
    expect(report.loudness!.integrated_lufs).toBeGreaterThanOrEqual(-16);
    expect(report.loudness!.integrated_lufs).toBeLessThanOrEqual(-12);
    expect(report.loudness!.true_peak_dbtp).toBeLessThanOrEqual(-0.5);
    expect(report.segments.total).toBe(composition.segments.length);
    expect(report.segments.cached, "nothing can be a cache hit on the very first render").toBe(0);

    // ---- events ----
    const events = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      const composed = events.listEvents({ event_type: "media.composed" }).filter((e) => e.payload.run_id === runId);
      expect(composed).toHaveLength(1);
      expect(composed[0]!.payload.cues).toBe(composition.captions.cues.length);
      expect(composed[0]!.payload.music_track).toBe("calm-01");
      const rendered = events.listEvents({ event_type: "media.rendered" }).filter((e) => e.payload.run_id === runId);
      expect(rendered).toHaveLength(1);
      expect(rendered[0]!.payload.encoder).toBe(report.encoder);
      expect(Number(rendered[0]!.payload.rendered_segments)).toBe(report.segments.rendered);
    } finally {
      events.close();
    }

    // ---- a second request over the SAME shoot is served out of the content-addressed mezzanine cache ----
    // `source_hint.collection` bypasses the "already used by another request" exclusion (`pickSources` rule
    // 2), so this really does re-cut the same three clips at the same in/out points -- which is exactly the
    // condition the cache key is built to recognise.
    const secondId = requestCreate(world, {
      topic: "Tập hai cùng buổi quay", style: styleId, sourceHint: "shoot-a",
      voice: "tts", voiceId, duration: [5, 120], language: "en",
    });
    studioWorkerUntil(world, () => requestStatus(world, secondId).status === "fulfilled", 400, env);
    const secondFulfilled = requestStatus(world, secondId);
    expect(secondFulfilled.status, JSON.stringify(secondFulfilled)).toBe("fulfilled");

    const secondRunId = readJson<LibraryItem>(join(world.lib, "items", secondFulfilled.item_ids[0]!, "manifest.json")).lineage.run_id;
    const secondReport = readJson<RenderReport>(artifactPathFor(world.studio, secondRunId, "media-render", "render_report")!);
    expect(secondReport.segments.cached, `second render rendered everything again: ${JSON.stringify(secondReport.segments)}`).toBeGreaterThan(0);
  }, 900_000);
});
