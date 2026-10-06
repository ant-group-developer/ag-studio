import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { hasFfmpegOnPath as hasFfmpeg, makeVideo } from "../media.js";
import { cli, freshLibraryWorld } from "../integration/library-helpers.js";

const SHA = "sha256:" + "a".repeat(64);

/** A minimal `stage-request.json` for a `harness media watch --mode <mode>` invocation -- same shape
 * `tests/integration/studio-wrappers.test.ts`'s `baseRequest()` builds for the wrapper scripts directly,
 * adapted for the built-in `media watch` command (`packages/cli/src/commands/media.ts`), which only ever
 * reads `stage_key`/`inputs`/`expected_outputs` off it. */
function watchRequest(mode: string, inputs: { type: string; path: string; kind: "file" | "directory" }[]) {
  return {
    schema_version: "harness.stage-request/v1",
    run_id: "run_1", stage_run_id: "stage_1", attempt_id: "attempt_1",
    project_id: "p", portfolio_id: "pf", stage_key: `watch-${mode}`,
    workflow: { id: "w", version: "1.1.0", digest: SHA },
    profile_snapshot: { id: "studio", revision: 2 },
    inputs: inputs.map((i, idx) => ({ artifact_id: `artifact_${idx}`, checksum: SHA, path: i.path, type: i.type, kind: i.kind })),
    workspace_uri: "unused", stage_config: {}, options: {}, source_items: [], resources: [],
    expected_outputs: [{ type: "watch", mime_type: "application/x-directory", kind: "directory", name: "watch" }],
    limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 1 },
    capabilities: [], fencing_token: 1,
  };
}

/** Runs the built-in `media watch --mode <mode>` stage against a hand-built workspace (task-3 style: no
 * run/plan/enqueue at all, just the one CLI invocation the `watch-<mode>` script command re-execs into --
 * see `builtinMediaCommands` in `packages/cli/src/commands/media.ts`). Returns the parsed `watch.json`. */
function runWatch(project: string, mode: string, inputs: { type: string; path: string; kind: "file" | "directory" }[]): {
  videos: { label: string; frames: { t: number; kind: string }[]; transcript: { segments: { start: number; end: number; text: string }[] } | null }[];
} {
  const ws = mkdtempSync(join(tmpdir(), `watch-${mode}-`));
  writeFileSync(join(ws, "stage-request.json"), JSON.stringify(watchRequest(mode, inputs)));
  const r = cli(project, ["media", "watch", "--mode", mode], { HARNESS_WORKSPACE: ws });
  expect(r.code, `stderr: ${r.err}\nstdout: ${r.out}`).toBe(0);
  const resultRaw = readFileSync(join(ws, "stage-result.json"), "utf8");
  const result = JSON.parse(resultRaw) as { outcome: string; errors: { message: string }[] };
  expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
  return JSON.parse(readFileSync(join(ws, "output", "watch", "watch.json"), "utf8"));
}

/** Removes the `transcribe` entry from a temp studio project's committed `executors/scripts.yaml` in place
 * (the fixture always ships one -- see fixtures/ops-project-studio/executors/scripts.yaml -- so the "no
 * transcribe script registered" case needs its own edited copy). */
function dropTranscribeScript(project: string): void {
  const path = join(project, "executors", "scripts.yaml");
  const doc = parse(readFileSync(path, "utf8")) as { scripts: Record<string, unknown> };
  delete doc.scripts.transcribe;
  writeFileSync(path, stringify(doc));
}

// Acceptance 30: `harness media watch` (the built-in stage behind workflows/library-production@1.1.0's
// watch-source/watch-episode and style-study@1.1.0's watch-samples) caps frames at each mode's max_frames,
// marks a real scene cut as `kind: "scene"`, and only ever attempts transcription when the project's
// scripts.yaml actually registers a `transcribe` script -- otherwise `transcript` is `null`, never an empty
// segments array pretending nothing was said.
describe.skipIf(!hasFfmpeg())("acceptance 30: media watch frame caps, scene detection, and conditional transcription", () => {
  it("--mode source: frames.length <= 120 (spec default) and a two-color source produces at least one scene-kind frame", () => {
    const world = freshLibraryWorld({ media: false });
    const ws = mkdtempSync(join(tmpdir(), "watch-source-fixture-"));
    const proxy = join(ws, "proxy.mp4");
    makeVideo(proxy, { seconds: 6, audio: false, scene_cut_at: 3 });
    writeFileSync(join(ws, "shots.json"), JSON.stringify({ shots: [{ in: 0, out: 6 }] }));

    const index = runWatch(world.studio, "source", [
      { type: "proxy_video", path: proxy, kind: "file" },
      { type: "shots", path: join(ws, "shots.json"), kind: "file" },
    ]);
    expect(index.videos).toHaveLength(1);
    const video = index.videos[0]!;
    expect(video.frames.length).toBeLessThanOrEqual(120);
    expect(video.frames.length).toBeGreaterThan(0);
    expect(video.frames.some((f) => f.kind === "scene"), JSON.stringify(video.frames)).toBe(true);
  }, 120_000);

  it("--mode samples: transcript is null when scripts.yaml has no transcribe entry, even with a sibling .txt", () => {
    const world = freshLibraryWorld({ media: false });
    dropTranscribeScript(world.studio);

    const ws = mkdtempSync(join(tmpdir(), "watch-samples-fixture-"));
    const video = join(ws, "clip.mp4");
    makeVideo(video, { seconds: 3, audio: false });
    writeFileSync(`${video}.txt`, "Điều này không nên được đọc: không có transcribe script.\n");
    writeFileSync(join(ws, "samples.json"), JSON.stringify([{ index: 0, label: "s0", path: video }]));

    const index = runWatch(world.studio, "samples", [{ type: "sample_set", path: ws, kind: "directory" }]);
    expect(index.videos).toHaveLength(1);
    expect(index.videos[0]!.transcript).toBeNull();
  }, 120_000);

  it("--mode samples: transcript has >=1 segment when scripts.yaml registers transcribe and the video has a sibling .txt", () => {
    const world = freshLibraryWorld({ media: false });

    const ws = mkdtempSync(join(tmpdir(), "watch-samples-transcribe-"));
    const video = join(ws, "clip.mp4");
    makeVideo(video, { seconds: 3, audio: false });
    writeFileSync(`${video}.txt`, "Dòng một.\nDòng hai.\n");
    writeFileSync(join(ws, "samples.json"), JSON.stringify([{ index: 0, label: "s0", path: video }]));

    const index = runWatch(world.studio, "samples", [{ type: "sample_set", path: ws, kind: "directory" }]);
    expect(index.videos).toHaveLength(1);
    expect(index.videos[0]!.transcript).not.toBeNull();
    expect(index.videos[0]!.transcript!.segments.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
