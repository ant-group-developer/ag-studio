import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type Composition, type Edl, type RenderReport } from "@harness/contracts";
import { ffprobeDuration, hasFfmpeg, systemFontPath } from "../media.js";
import {
  artifactPathFor, autoAcceptedRuns, freshLibraryWorld, ingestShoot, requestCreate, setBrand, status,
  studioWorkerUntil, writeActiveStyle, type LibraryWorld,
} from "../integration/library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const CHANNEL_ID = "channel-one";

/** Drives the autopilot until the request's FIRST run has a finished `media-render`, and returns that run.
 * Deliberately not "until fulfilled": the downgrade half of this acceptance is a run `library-review` is
 * right to reject (spec §6.3 rejects when more than 30 % of the requested transitions were downgraded), and
 * what is being asserted is what the renderer produced, not whether a reviewer liked it. */
function runWithRenderedEpisode(world: LibraryWorld, requestId: string, env: Record<string, string>): string {
  const firstRun = (): string | undefined => autoAcceptedRuns(world, requestId)[0]?.run_id;
  studioWorkerUntil(world, () => {
    const runId = firstRun();
    return runId !== undefined && status(world.studio, runId).stages.find((s) => s.stage_key === "media-render")?.state === "SUCCEEDED";
  }, 300, env);
  const runId = firstRun();
  expect(runId, "the autopilot never planned a run for the request").toBeDefined();
  const render = status(world.studio, runId!).stages.find((s) => s.stage_key === "media-render");
  expect(render?.state, `media-render did not finish: ${JSON.stringify(status(world.studio, runId!).stages.map((s) => [s.stage_key, s.state]))}`).toBe("SUCCEEDED");
  return runId!;
}

// Acceptance 49 (sub-project 5B §8, the timeline invariant of spec §4.3): a transition is allowed to change
// what happens ACROSS a cut and nothing else. Whatever `timeline.json` said each segment's `start`/`end` and
// `in`/`out` were, the delivered episode is still exactly that long and every `cuts/NNN.mp4` is still
// exactly its own `out - in` -- with dissolves applied, and again when the outgoing source has no frames
// left to fade with and the transition has to be downgraded back to a hard cut.
describe.skipIf(!hasFfmpeg() || !systemFontPath())("acceptance 49: transitions never move the timeline", () => {
  it("applies the brand's dissolves without changing the episode length or any cut", () => {
    const world = freshLibraryWorld({ media: false, media1_3: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    expect(setBrand(world, CHANNEL_ID, { subtitles: "none", transition: { kind: "dissolve", seconds: 0.4 } })).toBe(true);
    ingestShoot(world, "shoot-a", 3, { withAudio: true });

    const requestId = requestCreate(world, {
      topic: "Ba đoạn, chuyển mềm", style: styleId, sourceHint: "shoot-a",
      voice: "none", duration: [1, 120], language: "en",
    });
    const runId = runWithRenderedEpisode(world, requestId, env);

    const composition = readJson<Composition>(artifactPathFor(world.studio, runId, "media-compose", "composition")!);
    expect(composition.segments).toHaveLength(3);
    expect(composition.transitions.applied, JSON.stringify(composition.transitions)).toBeGreaterThanOrEqual(1);
    expect(composition.segments.filter((s) => s.transition_out.kind === "dissolve" && s.transition_out.tail_available).length).toBeGreaterThanOrEqual(1);

    // The invariant: the episode is exactly the sum of the segment spans the timeline declared, dissolves or
    // no dissolves (an `xfade` consumes the tail it was given, never the body of either side).
    const expectedSeconds = composition.segments.reduce((sum, s) => sum + (s.end - s.start), 0);
    expect(composition.total_seconds).toBeCloseTo(expectedSeconds, 3);
    const episodeSeconds = ffprobeDuration(artifactPathFor(world.studio, runId, "media-render", "episode_video")!);
    expect(episodeSeconds, "ffprobe could not read the episode").not.toBeNull();
    expect(Math.abs(episodeSeconds! - expectedSeconds), `Σ(end-start) ${expectedSeconds}s vs episode ${episodeSeconds}s`).toBeLessThanOrEqual(0.1);

    // ...and each delivered cut is still its own source span, not its span plus a fade.
    const edl = readJson<Edl>(artifactPathFor(world.studio, runId, "media-fit-edl", "edl")!);
    const cutsDir = artifactPathFor(world.studio, runId, "media-render", "clip_set")!;
    for (const entry of edl.entries) {
      const clip = join(cutsDir, `${String(entry.order).padStart(3, "0")}.mp4`);
      const seconds = ffprobeDuration(clip);
      expect(seconds, `cuts/${String(entry.order).padStart(3, "0")}.mp4 is unreadable`).not.toBeNull();
      expect(Math.abs(seconds! - (entry.out - entry.in)), `cut ${entry.order}: ${seconds}s vs out-in ${entry.out - entry.in}s`).toBeLessThanOrEqual(0.05);
    }
  }, 600_000);

  it("downgrades a dissolve to a cut when the outgoing source is used to its last frame, and the length still holds", () => {
    const world = freshLibraryWorld({ media: false, media1_3: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    expect(setBrand(world, CHANNEL_ID, { subtitles: "none", transition: { kind: "dissolve", seconds: 0.4 } })).toBe(true);
    // `scenes: 1`: each clip is one flat colour, so `media-index` finds no scene change and the whole clip is
    // a single shot -- which makes the fake `edit-plan`'s "first shot of each source" EDL run to the source's
    // last frame (`out == duration`), leaving nothing for a dissolve to fade into.
    ingestShoot(world, "shoot-b", 2, { withAudio: true, scenes: 1 });

    const requestId = requestCreate(world, {
      topic: "Cắt sát cuối nguồn", style: styleId, sourceHint: "shoot-b",
      voice: "none", duration: [1, 120], language: "en",
    });
    const runId = runWithRenderedEpisode(world, requestId, env);

    const composition = readJson<Composition>(artifactPathFor(world.studio, runId, "media-compose", "composition")!);
    expect(composition.transitions.requested, JSON.stringify(composition.transitions)).toBeGreaterThanOrEqual(1);
    expect(composition.transitions.downgraded.map((d) => d.reason)).toContain("no_tail");
    expect(composition.transitions.applied).toBe(composition.transitions.requested - composition.transitions.downgraded.length);
    expect(composition.segments.every((s) => !s.transition_out.tail_available)).toBe(true);

    const report = readJson<RenderReport>(artifactPathFor(world.studio, runId, "media-render", "render_report")!);
    expect(report.transitions.downgraded.map((d) => d.reason)).toContain("no_tail");

    // A downgrade is not a failure and does not shorten anything: the episode is still Σ(end-start).
    const expectedSeconds = composition.segments.reduce((sum, s) => sum + (s.end - s.start), 0);
    const episodeSeconds = ffprobeDuration(artifactPathFor(world.studio, runId, "media-render", "episode_video")!);
    expect(episodeSeconds, "ffprobe could not read the episode").not.toBeNull();
    expect(Math.abs(episodeSeconds! - expectedSeconds), `Σ(end-start) ${expectedSeconds}s vs episode ${episodeSeconds}s`).toBeLessThanOrEqual(0.1);
  }, 600_000);
});
