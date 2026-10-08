import { spawnSync } from "node:child_process";
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { newId, type ClaimResult, type StageInput, type StageResult, type WatchIndex, type WatchVideo } from "@harness/contracts";
import { HARNESS_ROOT, buildStageRequest, eventFor } from "@harness/core";
import { buildContext, type AppContext } from "../src/composition.js";
import { emptyWatchLabels } from "../src/commands/media.js";
import { hasFfmpegOnPath as hasFfmpeg, makeVideo } from "../../../tests/media.js";

// Task 3: `harness media watch --mode samples|source|episode` (a built-in stage script, same shape as
// `library stage`/`publish stage`). These tests drive it exactly the way publish-stage.test.ts drives its
// own built-in stages: a real run (via `plan`+`enqueue`), a real `store.claim()` for the "produce" stage of
// the trivial `sample-three-stage` workflow (its own outputs don't matter -- only its executor shape,
// `{ type: script }`, and `required_capabilities` do), a hand-built `stage-request.json` whose
// `expected_outputs` is overridden to the `watch` directory type this stage actually produces, and a spawned
// `harness media watch --mode <mode>` subprocess.

const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
const MINIMAL_FIXTURE = join(HARNESS_ROOT, "fixtures", "ops-project-minimal");
const FAKE_TRANSCRIBE = join(HARNESS_ROOT, "packages", "core", "test", "media", "fake-transcribe.mjs");

function cli(project: string, args: string[], env: Record<string, string> = {}): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error", ...env } });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "media-watch-"));
  cpSync(MINIMAL_FIXTURE, dir, { recursive: true });
  const migrate = cli(dir, ["db", "migrate"]);
  if (migrate.code !== 0) throw new Error(`db migrate failed: ${migrate.err}`);
  return dir;
}

/** Declares `transcribe` in a fresh project's `executors/scripts.yaml` -- the only entry needed, since
 * `sample-three-stage`'s own stages resolve through the built-in `fake-stage` script regardless. */
function declareTranscribeScript(project: string): void {
  mkdirSync(join(project, "executors"), { recursive: true });
  writeFileSync(
    join(project, "executors", "scripts.yaml"),
    stringify({ schema_version: "harness.scripts/v1", scripts: { transcribe: { argv: [process.execPath, FAKE_TRANSCRIBE], cwd: ".", timeout_seconds: 10 } } }),
  );
}

function planRun(project: string): string {
  const p = cli(project, ["plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json"]);
  if (p.code !== 0) throw new Error(`plan failed: ${p.err}\n${p.out}`);
  const runId = (JSON.parse(p.out) as { run_id: string }).run_id;
  const e = cli(project, ["enqueue", runId]);
  if (e.code !== 0) throw new Error(`enqueue failed: ${e.err}`);
  return runId;
}

/** Claims a stage_run by key and (mirroring worker.ts / publish-stage.test.ts's own `claimStage`) moves the
 * attempt/stage_run CLAIMED -> RUNNING. */
function claimStage(ctx: AppContext, runId: string, stageKey: string): ClaimResult {
  const stageRun = ctx.store.listStageRuns(runId).find((s) => s.stage_key === stageKey);
  if (!stageRun) throw new Error(`stage ${stageKey} not found on run ${runId}`);
  const claim = ctx.store.claim({ owner: "test", capabilities: stageRun.required_capabilities, now: ctx.clock.now(), leaseSeconds: 600, stageRunId: stageRun.stage_run_id, resourceCapacity: ctx.resourceCapacity });
  if (!claim) throw new Error(`could not claim ${stageKey} on run ${runId} (state ${stageRun.state})`);
  const run = ctx.store.getRun(runId)!;
  ctx.store.transaction(() => {
    ctx.store.transition("attempt", claim.attempt.attempt_id, "CLAIMED", "RUNNING", eventFor(run, claim.stageRun, claim.attempt, "attempt.started"));
    ctx.store.transition("stage_run", claim.stageRun.stage_run_id, "CLAIMED", "RUNNING", eventFor(run, claim.stageRun, claim.attempt, "stage.started"));
  });
  return claim;
}

function fakeInput(type: string, path: string, kind: "file" | "directory"): StageInput {
  return { artifact_id: newId("artifact"), checksum: "sha256:" + "0".repeat(64), path, type, kind };
}

interface InputSpec { type: string; relPath: string; kind?: "file" | "directory"; src: string }

/** Claims "produce" on a fresh stage_run, hand-builds a `stage-request.json` with `inputSpecs` materialized
 * as fake inputs and `expected_outputs` overridden to the `watch` directory type, and spawns
 * `harness media watch --mode <mode>`. */
async function invokeWatch(project: string, runId: string, mode: string, inputSpecs: InputSpec[], envExtra: Record<string, string> = {}): Promise<{ result: StageResult; workspaceDir: string }> {
  let claim: ClaimResult;
  {
    const ctx = buildContext({ projectDir: project });
    try { claim = claimStage(ctx, runId, "produce"); } finally { ctx.close(); }
  }

  const workspaceDir = mkdtempSync(join(tmpdir(), "ws-watch-"));
  mkdirSync(join(workspaceDir, "output"), { recursive: true });
  const inputs = inputSpecs.map((s) => fakeInput(s.type, s.relPath, s.kind ?? "file"));
  for (const s of inputSpecs) {
    const dest = join(workspaceDir, s.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    if ((s.kind ?? "file") === "directory") cpSync(s.src, dest, { recursive: true });
    else copyFileSync(s.src, dest);
  }

  {
    const ctx = buildContext({ projectDir: project });
    try {
      const run = ctx.store.getRun(runId)!;
      const request = buildStageRequest({ store: ctx.store, clock: ctx.clock, harness: ctx.harness, profiles: ctx.profiles, workflows: ctx.workflows }, {
        run, stageRun: claim.stageRun, attempt: claim.attempt, lease: claim.lease, inputs, workspaceDir, capabilities: claim.stageRun.required_capabilities,
      });
      // "produce"'s real workflow outputs (script_text) aren't what this stage writes -- the task-3 brief's
      // own test spec calls for hand-overriding expected_outputs to what `media watch` actually produces.
      request.expected_outputs = [{ type: "watch", mime_type: "application/x-directory", kind: "directory", name: "watch" }];
      writeFileSync(join(workspaceDir, "stage-request.json"), JSON.stringify(request, null, 2));
    } finally { ctx.close(); }
  }

  const r = cli(project, ["media", "watch", "--mode", mode], { ...envExtra, HARNESS_WORKSPACE: workspaceDir });
  const resultPath = join(workspaceDir, "stage-result.json");
  if (!existsSync(resultPath)) throw new Error(`media watch wrote no stage-result.json (exit ${r.code}): ${r.err}\n${r.out}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as StageResult;
  return { result, workspaceDir };
}

// Final-review finding I-2: `watchStage` turns a non-empty `emptyWatchLabels` into a `contract` failure, so a
// machine with ffprobe but no working ffmpeg can never commit a SUCCEEDED, frameless `watch/` artifact.
describe("emptyWatchLabels", () => {
  const video = (label: string, duration_seconds: number, frameCount: number): WatchVideo => ({
    label, source_path: `/src/${label}.mp4`, duration_seconds, media: null,
    frames: Array.from({ length: frameCount }, (_, i) => ({ t: i, file: `${label}/f-${i}.png`, kind: "interval" as const })),
    sheets: [], transcript: null,
  });

  it("flags a probed video that extracted nothing, and ignores both a healthy one and a zero-duration fallback entry", () => {
    const index: WatchIndex = {
      schema_version: "harness.watch/v1", mode: "samples",
      videos: [video("broken", 12, 0), video("ok", 8, 4), video("fallback", 0, 0)],
    };
    expect(emptyWatchLabels(index)).toEqual(["broken"]);
  });

  it("is empty for an index where every probed video produced frames", () => {
    const index: WatchIndex = { schema_version: "harness.watch/v1", mode: "episode", videos: [video("episode", 30, 8)] };
    expect(emptyWatchLabels(index)).toEqual([]);
  });
});

describe.skipIf(!hasFfmpeg())("harness media watch", () => {
  it("mode source: extracts frames guided by shots.json, writes a valid watch.json", async () => {
    const project = freshProject();
    const runId = planRun(project);
    const dir = mkdtempSync(join(tmpdir(), "src-media-"));
    const proxy = join(dir, "proxy.mp4");
    makeVideo(proxy, { seconds: 12, scene_cut_at: 6 });
    const shots = join(dir, "shots.json");
    writeFileSync(shots, JSON.stringify({ shots: [{ in: 0, out: 6 }, { in: 6, out: 12 }] }));

    const { result, workspaceDir } = await invokeWatch(project, runId, "source", [
      { type: "proxy_video", relPath: "input/proxy/proxy.mp4", src: proxy },
      { type: "shots", relPath: "input/shots/shots.json", src: shots },
    ]);
    expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
    expect(result.outputs.map((o) => o.type)).toEqual(["watch"]);
    expect(result.outputs[0]?.kind).toBe("directory");

    const watchJsonPath = join(workspaceDir, "output", "watch", "watch.json");
    expect(existsSync(watchJsonPath)).toBe(true);
    const watchIndex = JSON.parse(readFileSync(watchJsonPath, "utf8")) as { mode: string; videos: { label: string; frames: { file: string }[] }[] };
    expect(watchIndex.mode).toBe("source");
    expect(watchIndex.videos).toHaveLength(1);
    expect(watchIndex.videos[0]?.label).toBe("source");
    expect(watchIndex.videos[0]!.frames.length).toBeGreaterThan(0);
    for (const f of watchIndex.videos[0]!.frames) expect(existsSync(join(workspaceDir, "output", "watch", f.file))).toBe(true);
  });

  it('mode samples: falls back to already-extracted frames when samples.json paths don\'t resolve locally (2C fixture shape)', async () => {
    const project = freshProject();
    const runId = planRun(project);
    const samplesDir = mkdtempSync(join(tmpdir(), "samples-img-"));
    writeFileSync(join(samplesDir, "0-start.png"), "fake png bytes 1");
    writeFileSync(join(samplesDir, "0-mid.png"), "fake png bytes 2");
    writeFileSync(join(samplesDir, "0-end.png"), "fake png bytes 3");
    const samples = [{ index: 0, path: "/no/such/video.mp4", frames: ["0-start.png", "0-mid.png", "0-end.png"] }];
    writeFileSync(join(samplesDir, "samples.json"), JSON.stringify(samples, null, 2));

    const { result, workspaceDir } = await invokeWatch(project, runId, "samples", [
      { type: "sample_set", relPath: "input/samples", kind: "directory", src: samplesDir },
    ]);
    expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
    const watchIndex = JSON.parse(readFileSync(join(workspaceDir, "output", "watch", "watch.json"), "utf8")) as { videos: { label: string; frames: unknown[]; transcript: unknown }[] };
    expect(watchIndex.videos).toHaveLength(1);
    expect(watchIndex.videos[0]?.label).toBe("0"); // no "label" in samples.json -> falls back to String(index)
    expect(watchIndex.videos[0]?.frames).toHaveLength(3);
    expect(watchIndex.videos[0]?.transcript).toBeNull();
  });

  it("mode samples: extracts fresh frames when samples.json points at a real, existing video", async () => {
    const project = freshProject();
    const runId = planRun(project);
    const samplesDir = mkdtempSync(join(tmpdir(), "samples-video-"));
    makeVideo(join(samplesDir, "clip.mp4"), { seconds: 4 });
    writeFileSync(join(samplesDir, "samples.json"), JSON.stringify([{ index: 0, path: "clip.mp4" }], null, 2));

    const { result, workspaceDir } = await invokeWatch(project, runId, "samples", [
      { type: "sample_set", relPath: "input/samples", kind: "directory", src: samplesDir },
    ]);
    expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
    const watchIndex = JSON.parse(readFileSync(join(workspaceDir, "output", "watch", "watch.json"), "utf8")) as { videos: { frames: { file: string }[] }[] };
    expect(watchIndex.videos).toHaveLength(1);
    expect(watchIndex.videos[0]!.frames.length).toBeGreaterThan(0);
    for (const f of watchIndex.videos[0]!.frames) expect(existsSync(join(workspaceDir, "output", "watch", f.file))).toBe(true);
  });

  // Final-review finding I-3: one entry whose recorded path no longer resolves here used to drag every other
  // sample down to the frames-only fallback (no fresh frames, no contact sheets for any of them).
  it("mode samples: mixes per entry -- a resolvable clip is re-watched while an unresolvable one keeps its old frames", async () => {
    const project = freshProject();
    const runId = planRun(project);
    const samplesDir = mkdtempSync(join(tmpdir(), "samples-mixed-"));
    makeVideo(join(samplesDir, "dl-0.mp4"), { seconds: 4 });
    for (const name of ["1-start.png", "1-mid.png", "1-end.png"]) writeFileSync(join(samplesDir, name), `fake png ${name}`);
    writeFileSync(join(samplesDir, "samples.json"), JSON.stringify([
      { index: 0, label: "s0", path: "dl-0.mp4" },
      { index: 1, label: "s1", path: "/no/such/local/video.mp4", frames: ["1-start.png", "1-mid.png", "1-end.png"] },
    ], null, 2));

    const { result, workspaceDir } = await invokeWatch(project, runId, "samples", [
      { type: "sample_set", relPath: "input/samples", kind: "directory", src: samplesDir },
    ]);
    expect(result.outcome, JSON.stringify(result)).toBe("succeeded");

    const watchIndex = JSON.parse(readFileSync(join(workspaceDir, "output", "watch", "watch.json"), "utf8")) as
      { videos: { label: string; duration_seconds: number; frames: { file: string }[]; sheets: string[] }[] };
    expect(watchIndex.videos.map((v) => v.label).sort()).toEqual(["s0", "s1"]);

    const watched = watchIndex.videos.find((v) => v.label === "s0")!;
    expect(watched.duration_seconds).toBeGreaterThan(0);
    expect(watched.frames.length).toBeGreaterThan(0);
    expect(watched.sheets.length).toBeGreaterThan(0);
    for (const f of watched.frames) expect(existsSync(join(workspaceDir, "output", "watch", f.file))).toBe(true);

    const fallback = watchIndex.videos.find((v) => v.label === "s1")!;
    expect(fallback.frames).toHaveLength(3);
    expect(fallback.sheets).toEqual([]);
  });

  it("transcribe hook: scripts.yaml declares a transcribe script, and the transcript comes back with segments", async () => {
    const project = freshProject();
    declareTranscribeScript(project);
    const runId = planRun(project);
    const dir = mkdtempSync(join(tmpdir(), "ep-media-"));
    const episode = join(dir, "episode.mp4");
    makeVideo(episode, { seconds: 2 });

    const { result, workspaceDir } = await invokeWatch(project, runId, "episode", [
      { type: "episode_video", relPath: "input/episode/episode.mp4", src: episode },
    ]);
    expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
    const watchIndex = JSON.parse(readFileSync(join(workspaceDir, "output", "watch", "watch.json"), "utf8")) as { videos: { transcript: { segments: unknown[] } | null; transcript_error?: string }[] };
    expect(watchIndex.videos[0]?.transcript_error).toBeUndefined();
    expect(watchIndex.videos[0]?.transcript?.segments).toEqual([{ start: 0, end: 1, text: "xin chào" }]);
  });

  it("mode episode: fails contract when the episode_video input is missing", async () => {
    const project = freshProject();
    const runId = planRun(project);
    const { result } = await invokeWatch(project, runId, "episode", []);
    expect(result.outcome).toBe("failed");
    expect(result.errors[0]?.kind).toBe("contract");
    expect(result.errors[0]?.message).toContain("episode_video");
  });

  it("fails contract on an unknown --mode", async () => {
    const project = freshProject();
    const runId = planRun(project);
    const { result } = await invokeWatch(project, runId, "bogus", []);
    expect(result.outcome).toBe("failed");
    expect(result.errors[0]?.kind).toBe("contract");
    expect(result.errors[0]?.message).toContain("bogus");
  });
});
