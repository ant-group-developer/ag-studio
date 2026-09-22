import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CompositionSchema, EdlSchema, newId, RenderReportSchema,
  type ClaimResult, type Composition, type ContentRequest, type StageInput, type StageRequest, type StageResult,
} from "@harness/contracts";
import {
  BUILTIN_CHECKERS, buildStageRequest, canonicalDigest, compositionCheckers, eventFor, libraryCheckers, mediaCheckers,
  mimeTypesFor, sha256File, stageDefinitionDigest, stageDefinitionFor, Verifier, type VerifyOutcome,
} from "@harness/core";
import { buildContext, type AppContext } from "../src/composition.js";
import {
  addTrack, cli, freshLibraryWorld, librarySync, requestCreate, requestStatus, setBrand, writeActiveStyle, type LibraryWorld,
} from "../../../tests/integration/library-helpers.js";
import { hasFfmpeg, makeVideo, systemFontPath } from "../../../tests/media.js";

// Sub-project 5B Task 8: the two built-in composition stages (`media compose`, `media render`), the brand
// check `intake` gained (spec §7) and `library-export`'s captions directory -- driven exactly the way
// `media-stages.test.ts` drives 5A's four stages: a real run/content (via `plan` + `enqueue`), a real
// `store.claim()` per stage, a hand-built `stage-request.json`, a spawned `harness media <name>` subprocess,
// the REAL `Verifier` over the workflow's own `required_checks`, and `Controller.commit()` to unblock the
// next stage. `survey-source`/`plan-edit` are agent stages whose own behaviour is covered in
// `fake-agent-outputs.test.ts`; here their outputs are fabricated, as in `media-stages.test.ts`.

const SHA = "sha256:" + "0".repeat(64);
const STYLE_ID = newId("edit_style");
const CHANNEL_ID = "channel-one";
const hasFont = systemFontPath() !== undefined;

function claimStage(ctx: AppContext, runId: string, stageKey: string): ClaimResult {
  const stageRun = ctx.store.listStageRuns(runId).find((s) => s.stage_key === stageKey);
  if (!stageRun) throw new Error(`stage ${stageKey} not found on run ${runId}`);
  const claim = ctx.store.claim({ owner: "test", capabilities: stageRun.required_capabilities, now: ctx.clock.now(), leaseSeconds: 3600, stageRunId: stageRun.stage_run_id, resourceCapacity: ctx.resourceCapacity });
  if (!claim) throw new Error(`could not claim ${stageKey} on run ${runId} (state ${stageRun.state})`);
  const run = ctx.store.getRun(runId)!;
  ctx.store.transaction(() => {
    ctx.store.transition("attempt", claim.attempt.attempt_id, "CLAIMED", "RUNNING", eventFor(run, claim.stageRun, claim.attempt, "attempt.started"));
    ctx.store.transition("stage_run", claim.stageRun.stage_run_id, "CLAIMED", "RUNNING", eventFor(run, claim.stageRun, claim.attempt, "stage.started"));
  });
  return claim;
}

/** Claims a stage whose upstream dependencies were deliberately never run, for the scenarios about one
 * stage's own behaviour rather than the DAG around it. */
function forceClaim(project: string, runId: string, stageKey: string): ClaimResult {
  const ctx = buildContext({ projectDir: project });
  try {
    const stageRun = ctx.store.listStageRuns(runId).find((s) => s.stage_key === stageKey)!;
    const run = ctx.store.getRun(runId)!;
    if (stageRun.state === "PENDING") {
      ctx.store.transition("stage_run", stageRun.stage_run_id, "PENDING", "READY", eventFor(run, stageRun, null, "stage.ready"));
    }
    return claimStage(ctx, runId, stageKey);
  } finally { ctx.close(); }
}

function snapshotOutputs(workspaceDir: string): string {
  const snapshot = mkdtempSync(join(tmpdir(), "snap-"));
  cpSync(join(workspaceDir, "output"), join(snapshot, "output"), { recursive: true });
  return snapshot;
}

function fakeInput(type: string, path: string, kind: "file" | "directory"): StageInput {
  return { artifact_id: newId("artifact"), checksum: SHA, path, type, kind };
}

/** Real `Verifier`, built with the same checker set `composition.ts` builds -- now including
 * `compositionCheckers`, which owns `overlays-valid`/`composition-valid`/`render-valid` -- run against a
 * stage's ACTUAL request/result/workspace with the required-checks list the workflow declares for it. Must
 * be called BEFORE `commitResult` moves `output/` out of the workspace. */
async function verifyStage(project: string, runId: string, stageKey: string, workspaceDir: string, result: StageResult): Promise<VerifyOutcome> {
  const ctx = buildContext({ projectDir: project });
  try {
    const request = JSON.parse(readFileSync(join(workspaceDir, "stage-request.json"), "utf8")) as StageRequest;
    const run = ctx.store.getRun(runId)!;
    const def = stageDefinitionFor(ctx.workflows, run, stageKey);
    const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
    const verifier = new Verifier([
      ...BUILTIN_CHECKERS,
      ...mediaCheckers(ctx.prober, { available: ctx.proberAvailable, ffmpeg }),
      ...libraryCheckers(ctx.prober, { available: ctx.proberAvailable }),
      ...compositionCheckers({ prober: ctx.prober, available: ctx.proberAvailable, ffmpeg }),
    ]);
    return await verifier.verify({ request, result, workspaceDir }, def?.required_checks ?? []);
  } finally { ctx.close(); }
}

function expectAllRequiredPassed(outcome: VerifyOutcome): void {
  expect(outcome.missing, `missing checkers: ${JSON.stringify(outcome)}`).toEqual([]);
  expect(outcome.allRequiredPassed, `not all required checks passed: ${JSON.stringify(outcome.results, null, 2)}`).toBe(true);
}

interface InputSpec { type: string; relPath: string; kind?: "file" | "directory"; src: string }

async function invokeStage(
  project: string, runId: string, stageKey: string, cliArgs: string[], inputSpecs: InputSpec[],
  envExtra: Record<string, string> = {}, claimOverride?: ClaimResult,
): Promise<{ result: StageResult; workspaceDir: string; claim: ClaimResult; stdout: string; stderr: string }> {
  let claim: ClaimResult;
  {
    const ctx = buildContext({ projectDir: project });
    try { claim = claimOverride ?? claimStage(ctx, runId, stageKey); }
    finally { ctx.close(); }
  }

  const workspaceDir = mkdtempSync(join(tmpdir(), `ws-${stageKey}-`));
  mkdirSync(join(workspaceDir, "output"), { recursive: true });
  const inputs = inputSpecs.map((s) => fakeInput(s.type, s.relPath, s.kind ?? "file"));
  for (const s of inputSpecs) {
    const dest = join(workspaceDir, s.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    if ((s.kind ?? "file") === "directory") cpSync(s.src, dest, { recursive: true });
    else cpSync(s.src, dest);
  }

  {
    const ctx = buildContext({ projectDir: project });
    try {
      const run = ctx.store.getRun(runId)!;
      const request = buildStageRequest({ store: ctx.store, clock: ctx.clock, harness: ctx.harness, profiles: ctx.profiles, workflows: ctx.workflows }, {
        run, stageRun: claim.stageRun, attempt: claim.attempt, lease: claim.lease, inputs, workspaceDir, capabilities: claim.stageRun.required_capabilities,
      });
      writeFileSync(join(workspaceDir, "stage-request.json"), JSON.stringify(request, null, 2));
    } finally { ctx.close(); }
  }

  const r = cli(project, cliArgs, { ...envExtra, HARNESS_WORKSPACE: workspaceDir });
  const resultPath = join(workspaceDir, "stage-result.json");
  if (!existsSync(resultPath)) throw new Error(`${cliArgs.join(" ")} wrote no stage-result.json (exit ${r.code}): ${r.err}\n${r.out}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as StageResult;
  return { result, workspaceDir, claim, stdout: r.out, stderr: r.err };
}

async function commitResult(project: string, runId: string, claim: ClaimResult, workspaceDir: string, result: StageResult): Promise<void> {
  const ctx = buildContext({ projectDir: project });
  try {
    const run = ctx.store.getRun(runId)!;
    const def = stageDefinitionFor(ctx.workflows, run, claim.stageRun.stage_key);
    await ctx.controller.commit({
      stageRun: claim.stageRun, attempt: claim.attempt, fencingToken: claim.lease.fencing_token, result,
      verify: { results: [], allRequiredPassed: true, missing: [] }, workspaceDir, executorVersion: "test-harness",
      inputArtifactIds: [], mimeTypes: mimeTypesFor(def), stageDefinitionDigest: def ? stageDefinitionDigest(def) : canonicalDigest({ key: claim.stageRun.stage_key }),
    });
  } finally { ctx.close(); }
}

async function runAndCommit(project: string, runId: string, stageKey: string, cliArgs: string[], inputSpecs: InputSpec[] = []): Promise<{ workspaceSnapshot: string; result: StageResult }> {
  const r = await invokeStage(project, runId, stageKey, cliArgs, inputSpecs);
  if (r.result.outcome !== "succeeded") throw new Error(`${stageKey} failed: ${JSON.stringify(r.result, null, 2)}\n${r.stdout}\n${r.stderr}`);
  const snapshot = snapshotOutputs(r.workspaceDir);
  await commitResult(project, runId, r.claim, r.workspaceDir, r.result);
  return { workspaceSnapshot: snapshot, result: r.result };
}

interface FabricatedStage { claim: ClaimResult; workspaceDir: string; result: StageResult }

/** Claims a stage for real and writes a hand-built `StageResult` into a real workspace WITHOUT committing
 * it -- so the real `Verifier` can be run over it first. */
async function fabricateStage(project: string, runId: string, stageKey: string, outputs: { relPath: string; type: string; value: unknown }[], inputSpecs: InputSpec[] = []): Promise<FabricatedStage> {
  const claim = (() => {
    const ctx = buildContext({ projectDir: project });
    try { return claimStage(ctx, runId, stageKey); } finally { ctx.close(); }
  })();
  const workspaceDir = mkdtempSync(join(tmpdir(), `ws-${stageKey}-`));
  const inputs = inputSpecs.map((s) => fakeInput(s.type, s.relPath, s.kind ?? "file"));
  for (const s of inputSpecs) {
    const dest = join(workspaceDir, s.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    if ((s.kind ?? "file") === "directory") cpSync(s.src, dest, { recursive: true });
    else cpSync(s.src, dest);
  }
  const resultOutputs: StageResult["outputs"] = [];
  for (const o of outputs) {
    const abs = join(workspaceDir, "output", o.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(o.value, null, 2) + "\n");
    const { checksum, size_bytes } = await sha256File(abs);
    resultOutputs.push({ path: `output/${o.relPath}`, type: o.type, checksum, size_bytes, kind: "file" });
  }
  {
    const ctx = buildContext({ projectDir: project });
    try {
      const run = ctx.store.getRun(runId)!;
      const request = buildStageRequest({ store: ctx.store, clock: ctx.clock, harness: ctx.harness, profiles: ctx.profiles, workflows: ctx.workflows }, {
        run, stageRun: claim.stageRun, attempt: claim.attempt, lease: claim.lease, inputs, workspaceDir, capabilities: claim.stageRun.required_capabilities,
      });
      writeFileSync(join(workspaceDir, "stage-request.json"), JSON.stringify(request, null, 2));
    } finally { ctx.close(); }
  }
  const result: StageResult = {
    schema_version: "harness.stage-result/v1", attempt_id: claim.attempt.attempt_id, outcome: "succeeded",
    outputs: resultOutputs, checks: [], usage: { wall_seconds: 0.1, cost_usd: 0 }, external_operations: [], errors: [],
  };
  return { claim, workspaceDir, result };
}

async function fabricateAndCommit(project: string, runId: string, stageKey: string, outputs: { relPath: string; type: string; value: unknown }[]): Promise<string> {
  const f = await fabricateStage(project, runId, stageKey, outputs);
  const snapshot = snapshotOutputs(f.workspaceDir);
  await commitResult(project, runId, f.claim, f.workspaceDir, f.result);
  return snapshot;
}

/** Commits a stage result with the verification outcome the REAL verifier produced (not the canned passing
 * one `commitResult` uses), so a failing required check takes the stage/run down the same path the worker
 * would. */
async function commitWithVerify(project: string, runId: string, claim: ClaimResult, workspaceDir: string, result: StageResult, verify: VerifyOutcome): Promise<void> {
  const ctx = buildContext({ projectDir: project });
  try {
    const run = ctx.store.getRun(runId)!;
    const def = stageDefinitionFor(ctx.workflows, run, claim.stageRun.stage_key);
    await ctx.controller.commit({
      stageRun: claim.stageRun, attempt: claim.attempt, fencingToken: claim.lease.fencing_token, result,
      verify, workspaceDir, executorVersion: "test-harness",
      inputArtifactIds: [], mimeTypes: mimeTypesFor(def), stageDefinitionDigest: def ? stageDefinitionDigest(def) : canonicalDigest({ key: claim.stageRun.stage_key }),
    });
  } finally { ctx.close(); }
}

function planRun(project: string, workflow: string, profile: string, contentId: string): string {
  const p = cli(project, ["plan", "--workflow", workflow, "--profile", profile, "--content", contentId, "--json"]);
  if (p.code !== 0) throw new Error(`plan failed: ${p.err}\n${p.out}`);
  const runId = (JSON.parse(p.out) as { run_id: string }).run_id;
  const e = cli(project, ["enqueue", runId]);
  if (e.code !== 0) throw new Error(`enqueue failed: ${e.err}\n${e.out}`);
  return runId;
}

/** Pins `media.render.*` in a temp project's project.yaml: every render in this file uses the CPU encoder
 * and a fixed fps, so nothing here depends on the host having NVENC or on the fps election. */
function setRenderConfig(project: string, render: Record<string, unknown>): void {
  const path = join(project, "project.yaml");
  const cfg = parse(readFileSync(path, "utf8")) as { media?: Record<string, unknown> };
  cfg.media = { ...cfg.media, render: { ...(cfg.media?.render as Record<string, unknown> | undefined), ...render } };
  writeFileSync(path, stringify(cfg));
}

function writeTempJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  return path;
}

function briefJson(requestId: string, topic = "chợ nổi"): Record<string, unknown> {
  return { request_id: requestId, topic, style_id: STYLE_ID, style_revision: 1, voice: "none", language: "vi", target_duration_seconds: [1, 60] };
}

/** A studio+channel world with a style, a request and `n` ingested clips, ready to plan a 1.3.0 run on. */
function seedWorld(o: { topic: string; clips: { seconds: number; size?: string }[] }): { world: LibraryWorld; requestId: string; sourceIds: string[] } {
  const world = freshLibraryWorld({ media: false });
  setRenderConfig(world.studio, { encoder: "cpu", fps: 25 });
  writeActiveStyle(world.lib, STYLE_ID);
  librarySync(world.studio);
  const requestId = requestCreate(world, { topic: o.topic, style: STYLE_ID, duration: [1, 60], language: "vi" });
  librarySync(world.studio);

  const rawDir = join(world.studio, "raw");
  mkdirSync(rawDir, { recursive: true });
  const sourceIds = o.clips.map((c, i) => {
    const clip = join(rawDir, `clip${i}.mp4`);
    makeVideo(clip, { seconds: c.seconds, audio: true, ...(c.size ? { size: c.size } : {}) });
    const r = cli(world.studio, ["source", "ingest", clip, "--collection", "main", "--rights", "cleared", "--language", "vi", "--json"]);
    if (r.code !== 0) throw new Error(`source ingest failed: ${r.err}\n${r.out}`);
    return (JSON.parse(r.out) as { source_id: string }).source_id;
  });
  return { world, requestId, sourceIds };
}

function createContent(project: string, sourceIds: string[], requestId: string, title: string): string {
  const ctx = buildContext({ projectDir: project });
  try {
    return ctx.catalog.createContent({ source_ids: sourceIds, title, library_brief: briefJson(requestId, title) as never }).content_id;
  } finally { ctx.close(); }
}

describe.skipIf(!hasFfmpeg() || !hasFont)("harness media compose|render (sub-project 5B task 8)", () => {
  let world: LibraryWorld;
  let runId: string;
  let requestId: string;
  let indexSnap: string;
  let planEditSnap: string;
  let ttsSnap: string;
  let fitEdlSnap: string;
  let composeSnap: string;
  let composeOutcome: VerifyOutcome;
  let briefPath: string;

  beforeAll(async () => {
    const seeded = seedWorld({ topic: "chợ nổi", clips: [{ seconds: 5 }, { seconds: 6, size: "352x198" }] });
    world = seeded.world;
    requestId = seeded.requestId;

    // Brand + one music track, both written by the CHANNEL role (the only role allowed to write under
    // brands/** and music/**), then mirrored into the studio DB. The brand names the track, so the track
    // has to exist first.
    addTrack(world, "calm-01", { mood: ["calm"] });
    expect(setBrand(world, CHANNEL_ID, { withLogo: true, tracks: ["calm-01"], subtitles: "burn-in" })).toBe(true);
    librarySync(world.studio);

    const contentId = createContent(world.studio, seeded.sourceIds, requestId, "chợ nổi");
    runId = planRun(world.studio, "library-production@1.3.0", "studio", contentId);

    await runAndCommit(world.studio, runId, "intake", ["library", "stage", "intake"]);
    indexSnap = (await runAndCommit(world.studio, runId, "media-index", ["media", "index"])).workspaceSnapshot;
    const transcribeSnap = (await runAndCommit(world.studio, runId, "media-transcribe", ["media", "transcribe"], [
      { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
    ])).workspaceSnapshot;
    await runAndCommit(world.studio, runId, "watch-source", ["media", "watch", "--mode", "source"], [
      { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
      { type: "proxy_set", relPath: "input/proxy/proxy", kind: "directory", src: join(indexSnap, "output", "proxy") },
      { type: "transcript", relPath: "input/transcript/transcript.json", src: join(transcribeSnap, "output", "transcript.json") },
    ]);

    const shots = JSON.parse(readFileSync(join(indexSnap, "output", "shots.json"), "utf8")) as {
      sources: { source_id: string; duration_seconds: number; shots: { shot_id: string; in: number; out: number }[] }[];
    };
    await fabricateAndCommit(world.studio, runId, "survey-source", [{
      relPath: "survey.json", type: "survey_index",
      value: {
        schema_version: "harness.survey-index/v2",
        shots: shots.sources.flatMap((s) => s.shots.map((sh) => ({ source_id: s.source_id, shot_id: sh.shot_id, in: sh.in, out: sh.out, score: 3, tags: [], usable: true, note: "", speech: "none" }))),
      },
    }]);

    // plan-edit (fabricated): three 2 s segments over two sources -- long enough for a stable two-pass
    // loudnorm measurement, short enough for a 4K CPU encode in a test.
    const [a, b] = [shots.sources[0]!, shots.sources[1]!];
    const planEdl = {
      schema_version: "harness.edl/v1",
      entries: [
        { source_id: a.source_id, in: 0, out: 2, order: 0, overlay: null, note: "" },
        { source_id: b.source_id, in: 0, out: 2, order: 1, overlay: null, note: "" },
        { source_id: a.source_id, in: 2, out: 4, order: 2, overlay: null, note: "" },
      ],
    };
    planEditSnap = await fabricateAndCommit(world.studio, runId, "plan-edit", [
      { relPath: "edl.json", type: "edl", value: planEdl },
      { relPath: "edit-plan.json", type: "edit_plan", value: { schema_version: "harness.edit-plan/v1", notes: "" } },
      { relPath: "narration.json", type: "narration", value: { schema_version: "harness.narration/v1", language: "vi", lines: [] } },
      {
        relPath: "overlays.json", type: "overlays",
        value: {
          schema_version: "harness.overlays/v1",
          items: [
            { id: "OV01", kind: "title", text: "Chợ nổi 5 giờ sáng", anchor: { edl_order: 0 }, seconds: 2 },
            { id: "OV02", kind: "callout", text: "30 nghìn/kg", anchor: { edl_order: 2 }, seconds: 2 },
          ],
          transitions: [],
          music: { mood: "calm" },
        },
      },
    ]);

    briefPath = writeTempJson(mkdtempSync(join(tmpdir(), "brief-")), "brief.json", briefJson(requestId));
    ttsSnap = (await runAndCommit(world.studio, runId, "media-tts", ["media", "tts"], [
      { type: "brief", relPath: "input/brief/brief.json", src: briefPath },
      { type: "narration", relPath: "input/narration/narration.json", src: join(planEditSnap, "output", "narration.json") },
    ])).workspaceSnapshot;

    fitEdlSnap = (await runAndCommit(world.studio, runId, "media-fit-edl", ["media", "fit-edl"], [
      { type: "brief", relPath: "input/brief/brief.json", src: briefPath },
      { type: "edl", relPath: "input/edl/edl.json", src: join(planEditSnap, "output", "edl.json") },
      { type: "narration_timing", relPath: "input/timing/narration-timing.json", src: join(ttsSnap, "output", "narration-timing.json") },
      { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
      { type: "transcript", relPath: "input/transcript/transcript.json", src: join(transcribeSnap, "output", "transcript.json") },
    ])).workspaceSnapshot;

    // The input order `media-compose` really sees: `plan-edit`'s PRE-FIT edl first (stage order), then
    // `media-fit-edl`'s fitted one. The stage must compose against the fitted one.
    const composeInputs: InputSpec[] = [
      { type: "brief", relPath: "input/brief/brief.json", src: briefPath },
      { type: "edl", relPath: "input/edl-plan/edl.json", src: join(planEditSnap, "output", "edl.json") },
      { type: "narration", relPath: "input/narration/narration.json", src: join(planEditSnap, "output", "narration.json") },
      { type: "overlays", relPath: "input/overlays/overlays.json", src: join(planEditSnap, "output", "overlays.json") },
      { type: "voice_set", relPath: "input/voice/voice", kind: "directory", src: join(ttsSnap, "output", "voice") },
      { type: "edl", relPath: "input/edl-fit/edl.json", src: join(fitEdlSnap, "output", "edl.json") },
      { type: "timeline", relPath: "input/timeline/timeline.json", src: join(fitEdlSnap, "output", "timeline.json") },
      { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
    ];
    const compose = await invokeStage(world.studio, runId, "media-compose", ["media", "compose"], composeInputs);
    if (compose.result.outcome !== "succeeded") throw new Error(`media-compose failed: ${JSON.stringify(compose.result, null, 2)}\n${compose.stdout}\n${compose.stderr}`);
    composeOutcome = await verifyStage(world.studio, runId, "media-compose", compose.workspaceDir, compose.result);
    composeSnap = snapshotOutputs(compose.workspaceDir);
    await commitResult(world.studio, runId, compose.claim, compose.workspaceDir, compose.result);
  }, 900_000);

  it("media compose: composition.json mirrors the FITTED timeline and resolves brand, logo, music and overlays", () => {
    const composition = CompositionSchema.parse(JSON.parse(readFileSync(join(composeSnap, "output", "composition.json"), "utf8")));
    const timeline = JSON.parse(readFileSync(join(fitEdlSnap, "output", "timeline.json"), "utf8")) as {
      video: { order: number; source_id: string; in: number; out: number; start: number; end: number }[]; total_seconds: number;
    };

    const shape = (v: { order: number; source_id: string; in: number; out: number; start: number; end: number }) =>
      ({ order: v.order, source_id: v.source_id, in: v.in, out: v.out, start: v.start, end: v.end });
    expect(composition.segments.map(shape)).toEqual([...timeline.video].sort((a, b) => a.order - b.order).map(shape));
    expect(composition.total_seconds).toBe(timeline.total_seconds);
    expect(composition.request_id).toBe(requestId);
    expect(composition.output).toMatchObject({ width: 3840, height: 2160, fps: 25 });

    expect(composition.brand?.channel_id).toBe(CHANNEL_ID);
    // The run carries the profile default `subtitles: "true"` == "the brand decides", and the brand says
    // burn-in -- the whole option -> brand chain, end to end.
    expect(composition.captions.mode).toBe("burn-in");
    expect(composition.logo).not.toBeNull();
    expect(composition.music?.track_id).toBe("calm-01");
    expect(composition.text_events.map((e) => e.id).sort()).toEqual(["OV01", "OV02"]);
    expect(composition.text_dropped).toEqual([]);
  });

  it("media compose: writes captions/ (srt + vtt) and overlay.ass at 4K", () => {
    expect(readdirSync(join(composeSnap, "output", "captions")).sort()).toEqual(["captions.srt", "captions.vtt"]);
    expect(readFileSync(join(composeSnap, "output", "captions", "captions.vtt"), "utf8").startsWith("WEBVTT")).toBe(true);
    const ass = readFileSync(join(composeSnap, "output", "overlay.ass"), "utf8");
    expect(ass).toContain("PlayResX: 3840");
    expect(ass).toContain("PlayResY: 2160");
  });

  it("media compose: every required check of the stage passes through the real Verifier (composition-valid included)", () => {
    expectAllRequiredPassed(composeOutcome);
  });

  it("media render (cpu): 4K episode + cuts/ + render-report.json, all required checks pass, and a rerun is served entirely from the mezzanine cache", async () => {
    const inputs: InputSpec[] = [
      { type: "composition", relPath: "input/composition/composition.json", src: join(composeSnap, "output", "composition.json") },
      { type: "overlay_ass", relPath: "input/ass/overlay.ass", src: join(composeSnap, "output", "overlay.ass") },
      { type: "captions", relPath: "input/captions/captions", kind: "directory", src: join(composeSnap, "output", "captions") },
      { type: "edl", relPath: "input/edl/edl.json", src: join(fitEdlSnap, "output", "edl.json") },
      { type: "voice_set", relPath: "input/voice/voice", kind: "directory", src: join(ttsSnap, "output", "voice") },
      { type: "brief", relPath: "input/brief/brief.json", src: briefPath },
      { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
    ];

    const first = await invokeStage(world.studio, runId, "media-render", ["media", "render"], inputs);
    expect(first.result.outcome, `${JSON.stringify(first.result, null, 2)}\n${first.stdout}\n${first.stderr}`).toBe("succeeded");

    const report = RenderReportSchema.parse(JSON.parse(readFileSync(join(first.workspaceDir, "output", "render-report.json"), "utf8")));
    expect(report.encoder).toBe("cpu");
    expect(report.output.width).toBe(3840);
    expect(report.output.height).toBe(2160);
    expect(report.segments.cached).toBe(0);
    expect(report.segments.rendered).toBe(report.segments.total);
    // `encoder: cpu` is configured outright here, not resolved from `auto`, so the fallback warning the
    // dashboard reads must NOT be present.
    expect(report.warnings).not.toContain("encoder_cpu");

    const edl = EdlSchema.parse(JSON.parse(readFileSync(join(fitEdlSnap, "output", "edl.json"), "utf8")));
    for (const entry of edl.entries) {
      expect(existsSync(join(first.workspaceDir, "output", "cuts", `${String(entry.order).padStart(3, "0")}.mp4`)), `cuts/${entry.order}`).toBe(true);
    }
    expect(existsSync(join(first.workspaceDir, "output", "cuts", "manifest.json"))).toBe(true);
    expect(existsSync(join(first.workspaceDir, "output", "tmp"))).toBe(false);

    expectAllRequiredPassed(await verifyStage(world.studio, runId, "media-render", first.workspaceDir, first.result));
    // Taken before `commitResult`, which moves `output/` into the artifact store.
    const renderSnap = snapshotOutputs(first.workspaceDir);

    // Second render of the same composition, same claim: every mezzanine is a hit in the content-addressed
    // cache under `<data_root>/cache/mezz`.
    const second = await invokeStage(world.studio, runId, "media-render", ["media", "render"], inputs, {}, first.claim);
    expect(second.result.outcome, JSON.stringify(second.result, null, 2)).toBe("succeeded");
    const report2 = RenderReportSchema.parse(JSON.parse(readFileSync(join(second.workspaceDir, "output", "render-report.json"), "utf8")));
    expect(report2.segments.cached).toBe(report2.segments.total);
    expect(report2.segments.rendered).toBe(0);

    await commitResult(world.studio, runId, first.claim, first.workspaceDir, first.result);

    // library-export: the `captions` INPUT is now a directory, so the kho item carries captions.srt/.vtt
    // instead of the captions.json the older releases declared (and no stage ever wrote).
    const thumbDir = mkdtempSync(join(tmpdir(), "thumbs-"));
    writeFileSync(join(thumbDir, "thumbnail-1.png"), "fake thumbnail bytes");
    const exportInputs: InputSpec[] = [
      { type: "brief", relPath: "input/brief/brief.json", src: briefPath },
      { type: "episode_video", relPath: "input/episode/full-episode.mp4", src: join(renderSnap, "output", "full-episode.mp4") },
      { type: "thumbnail_set", relPath: "input/thumbnails/thumbnails", kind: "directory", src: thumbDir },
      { type: "edit_plan", relPath: "input/plan/edit-plan.json", src: join(planEditSnap, "output", "edit-plan.json") },
      { type: "captions", relPath: "input/captions/captions", kind: "directory", src: join(composeSnap, "output", "captions") },
    ];
    const exported = await invokeStage(world.studio, runId, "library-export", ["library", "stage", "export"], exportInputs, {}, forceClaim(world.studio, runId, "library-export"));
    expect(exported.result.outcome, JSON.stringify(exported.result, null, 2)).toBe("succeeded");
    const receipt = JSON.parse(readFileSync(join(exported.workspaceDir, "output", "export-receipt.json"), "utf8")) as { item_id: string; files: { path: string }[] };
    expect(receipt.files.map((f) => f.path)).toContain("captions.srt");
    expect(receipt.files.map((f) => f.path)).toContain("captions.vtt");
    expect(existsSync(join(world.lib, "items", receipt.item_id, "captions.srt"))).toBe(true);
    expect(existsSync(join(world.lib, "items", receipt.item_id, "captions.vtt"))).toBe(true);
  }, 1_200_000);
});

describe.skipIf(!hasFfmpeg() || !hasFont)("intake brand check (spec §7)", () => {
  it("a brand whose font bytes drifted from brand.json fails intake as contract, and the request stays open", async () => {
    const seeded = seedWorld({ topic: "brand hỏng", clips: [{ seconds: 2 }] });
    expect(setBrand(seeded.world, CHANNEL_ID, {})).toBe(true);
    librarySync(seeded.world.studio);

    // Tamper with the kho copy of the font AFTER `library brands set` recorded its checksum.
    const fontPath = join(seeded.world.lib, "brands", CHANNEL_ID, "fonts", "Regular.ttf");
    expect(existsSync(fontPath)).toBe(true);
    writeFileSync(fontPath, "not a font any more");

    const contentId = createContent(seeded.world.studio, seeded.sourceIds, seeded.requestId, "brand hỏng");
    const runId = planRun(seeded.world.studio, "library-production@1.3.0", "studio", contentId);
    const r = await invokeStage(seeded.world.studio, runId, "intake", ["library", "stage", "intake"], []);

    expect(r.result.outcome, JSON.stringify(r.result, null, 2)).toBe("failed");
    expect(r.result.errors[0]?.kind).toBe("contract");
    expect(r.result.errors[0]?.message).toContain("checksum mismatch");

    // The whole point of checking before `claimRequest`: the request must still be pickable by a replan.
    const request: ContentRequest = requestStatus(seeded.world, seeded.requestId);
    expect(request.status).toBe("open");
    expect(request.claimed_by_run).toBeUndefined();
  }, 300_000);

  it("an intact brand lets intake through and claims the request", async () => {
    const seeded = seedWorld({ topic: "brand tốt", clips: [{ seconds: 2 }] });
    expect(setBrand(seeded.world, CHANNEL_ID, {})).toBe(true);
    librarySync(seeded.world.studio);

    const contentId = createContent(seeded.world.studio, seeded.sourceIds, seeded.requestId, "brand tốt");
    const runId = planRun(seeded.world.studio, "library-production@1.3.0", "studio", contentId);
    const r = await invokeStage(seeded.world.studio, runId, "intake", ["library", "stage", "intake"], []);

    expect(r.result.outcome, JSON.stringify(r.result, null, 2)).toBe("succeeded");
    expect(requestStatus(seeded.world, seeded.requestId).status).toBe("claimed");
  }, 300_000);
});

describe.skipIf(!hasFfmpeg() || !hasFont)("media compose re-checks the brand (spec §7)", () => {
  it("a brand whose font file has gone missing from the kho fails the stage as contract", async () => {
    const seeded = seedWorld({ topic: "brand mất font", clips: [{ seconds: 4 }] });
    expect(setBrand(seeded.world, CHANNEL_ID, {})).toBe(true);
    librarySync(seeded.world.studio);

    const contentId = createContent(seeded.world.studio, seeded.sourceIds, seeded.requestId, "brand mất font");
    const runId = planRun(seeded.world.studio, "library-production@1.3.0", "studio", contentId);
    await runAndCommit(seeded.world.studio, runId, "intake", ["library", "stage", "intake"]);
    const indexSnap = (await runAndCommit(seeded.world.studio, runId, "media-index", ["media", "index"])).workspaceSnapshot;
    const shots = JSON.parse(readFileSync(join(indexSnap, "output", "shots.json"), "utf8")) as { sources: { source_id: string }[] };
    const sourceId = shots.sources[0]!.source_id;

    // Deleted AFTER intake, so only `media-compose`'s own re-check can catch it.
    rmSync(join(seeded.world.lib, "brands", CHANNEL_ID, "fonts", "Bold.ttf"));

    const dir = mkdtempSync(join(tmpdir(), "brand-nofont-"));
    const inputs: InputSpec[] = [
      { type: "brief", relPath: "input/brief/brief.json", src: writeTempJson(dir, "brief.json", briefJson(seeded.requestId, "brand mất font")) },
      { type: "edl", relPath: "input/edl/edl.json", src: writeTempJson(dir, "edl.json", { schema_version: "harness.edl/v1", entries: [{ source_id: sourceId, in: 0, out: 2, order: 0, overlay: null, note: "" }] }) },
      {
        type: "timeline", relPath: "input/timeline/timeline.json",
        src: writeTempJson(dir, "timeline.json", {
          schema_version: "harness.timeline/v1", voice: "none", language: "vi", total_seconds: 2,
          video: [{ order: 0, source_id: sourceId, in: 0, out: 2, start: 0, end: 2 }], narration: [], speech: [],
        }),
      },
      { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
    ];

    const r = await invokeStage(seeded.world.studio, runId, "media-compose", ["media", "compose"], inputs, {}, forceClaim(seeded.world.studio, runId, "media-compose"));
    expect(r.result.outcome, JSON.stringify(r.result, null, 2)).toBe("failed");
    expect(r.result.errors[0]?.kind).toBe("contract");
    expect(r.result.errors[0]?.message).toContain("Bold.ttf");
  }, 300_000);
});

// Integration test 48 (Task 10) relies on an `overlays-valid` failure at `plan-edit` entering the SP4
// replan path the same way an `edl-valid` failure does. Both live on the same stage and the same
// `required_checks` list, so the question is whether they produce the same run outcome -- asserted here
// side by side on two otherwise-identical runs.
describe.skipIf(!hasFfmpeg())("plan-edit: overlays-valid fails the run exactly like edl-valid", () => {
  it("a too-dense overlays.json and a broken edl.json both fail the stage and the run identically", async () => {
    const seeded = seedWorld({ topic: "replan", clips: [{ seconds: 4 }] });

    /** Runs a fresh 1.3.0 run (on its own request, since `intake` claims one per run) up to `plan-edit`,
     * commits the given plan-edit outputs through the REAL verifier, and reports which required check
     * failed plus the resulting stage/run states. */
    async function outcomeFor(label: string, planEdit: { edl: unknown; overlays: unknown }): Promise<{ failed: string[]; stageState: string; runState: string }> {
      const requestId = requestCreate(seeded.world, { topic: label, style: STYLE_ID, duration: [1, 60], language: "vi" });
      librarySync(seeded.world.studio);
      const contentId = createContent(seeded.world.studio, seeded.sourceIds, requestId, label);
      const runId = planRun(seeded.world.studio, "library-production@1.3.0", "studio", contentId);
      await runAndCommit(seeded.world.studio, runId, "intake", ["library", "stage", "intake"]);
      const indexSnap = (await runAndCommit(seeded.world.studio, runId, "media-index", ["media", "index"])).workspaceSnapshot;
      const transcribeSnap = (await runAndCommit(seeded.world.studio, runId, "media-transcribe", ["media", "transcribe"], [
        { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
      ])).workspaceSnapshot;
      await runAndCommit(seeded.world.studio, runId, "watch-source", ["media", "watch", "--mode", "source"], [
        { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
        { type: "proxy_set", relPath: "input/proxy/proxy", kind: "directory", src: join(indexSnap, "output", "proxy") },
        { type: "transcript", relPath: "input/transcript/transcript.json", src: join(transcribeSnap, "output", "transcript.json") },
      ]);
      const shots = JSON.parse(readFileSync(join(indexSnap, "output", "shots.json"), "utf8")) as {
        sources: { source_id: string; shots: { shot_id: string; in: number; out: number }[] }[];
      };
      await fabricateAndCommit(seeded.world.studio, runId, "survey-source", [{
        relPath: "survey.json", type: "survey_index",
        value: {
          schema_version: "harness.survey-index/v2",
          shots: shots.sources.flatMap((s) => s.shots.map((sh) => ({ source_id: s.source_id, shot_id: sh.shot_id, in: sh.in, out: sh.out, score: 3, tags: [], usable: true, note: "", speech: "none" }))),
        },
      }]);

      const f = await fabricateStage(seeded.world.studio, runId, "plan-edit", [
        { relPath: "edl.json", type: "edl", value: planEdit.edl },
        { relPath: "edit-plan.json", type: "edit_plan", value: { schema_version: "harness.edit-plan/v1", notes: "" } },
        { relPath: "narration.json", type: "narration", value: { schema_version: "harness.narration/v1", language: "vi", lines: [] } },
        { relPath: "overlays.json", type: "overlays", value: planEdit.overlays },
      ], [{ type: "brief", relPath: "input/brief/brief.json", src: writeTempJson(mkdtempSync(join(tmpdir(), "brief-replan-")), "brief.json", briefJson(requestId, label)) }]);

      const verify = await verifyStage(seeded.world.studio, runId, "plan-edit", f.workspaceDir, f.result);
      await commitWithVerify(seeded.world.studio, runId, f.claim, f.workspaceDir, f.result, verify);

      const ctx = buildContext({ projectDir: seeded.world.studio });
      try {
        const stage = ctx.store.listStageRuns(runId).find((s) => s.stage_key === "plan-edit")!;
        return {
          failed: verify.results.filter((r) => r.verdict !== "pass").map((r) => r.check_id).sort(),
          stageState: stage.state,
          runState: ctx.store.getRun(runId)!.state,
        };
      } finally { ctx.close(); }
    }

    const sourceId = seeded.sourceIds[0]!;
    const goodEdl = { schema_version: "harness.edl/v1", entries: [{ source_id: sourceId, in: 0, out: 2, order: 0, overlay: null, note: "" }] };
    const goodOverlays = { schema_version: "harness.overlays/v1", items: [{ id: "OV01", kind: "title", text: "Tiêu đề", anchor: { edl_order: 0 }, seconds: 3 }], transitions: [], music: { mood: "calm" } };

    // (a) overlays that anchor at an edl_order the EDL does not have
    const badOverlays = await outcomeFor("neo sai", {
      edl: goodEdl,
      overlays: { schema_version: "harness.overlays/v1", items: [{ id: "OV01", kind: "title", text: "Neo sai", anchor: { edl_order: 99 }, seconds: 3 }], transitions: [], music: { mood: "calm" } },
    });
    expect(badOverlays.failed).toEqual(["overlays-valid"]);

    // (b) an EDL whose entry points at a source this run does not carry
    const badEdl = await outcomeFor("edl sai", {
      edl: { schema_version: "harness.edl/v1", entries: [{ source_id: newId("source_item"), in: 0, out: 2, order: 0, overlay: null, note: "" }] },
      overlays: goodOverlays,
    });
    // `overlays-valid` reads the stage's own `edl` output too, so a broken EDL trips it as well -- the
    // point here is only that `edl-valid` is among the failures.
    expect(badEdl.failed).toContain("edl-valid");

    // The point of the comparison: the two land the run in exactly the same place, so the SP4 replan loop
    // treats a bad overlay plan the same way it already treats a bad EDL.
    expect(badOverlays.stageState).toBe(badEdl.stageState);
    expect(badOverlays.runState).toBe(badEdl.runState);
    expect(badEdl.runState).toBe("FAILED");
  }, 600_000);
});

describe.skipIf(!hasFfmpeg())("media compose with no brand at all", () => {
  it("still composes: brand null, captions.mode none, no logo, no music, exit 0", async () => {
    const seeded = seedWorld({ topic: "không brand", clips: [{ seconds: 4 }] });
    const contentId = createContent(seeded.world.studio, seeded.sourceIds, seeded.requestId, "không brand");
    const runId = planRun(seeded.world.studio, "library-production@1.3.0", "studio", contentId);

    await runAndCommit(seeded.world.studio, runId, "intake", ["library", "stage", "intake"]);
    const indexSnap = (await runAndCommit(seeded.world.studio, runId, "media-index", ["media", "index"])).workspaceSnapshot;
    const shots = JSON.parse(readFileSync(join(indexSnap, "output", "shots.json"), "utf8")) as { sources: { source_id: string }[] };
    const sourceId = shots.sources[0]!.source_id;

    const dir = mkdtempSync(join(tmpdir(), "nobrand-"));
    const inputs: InputSpec[] = [
      { type: "brief", relPath: "input/brief/brief.json", src: writeTempJson(dir, "brief.json", briefJson(seeded.requestId, "không brand")) },
      { type: "edl", relPath: "input/edl/edl.json", src: writeTempJson(dir, "edl.json", { schema_version: "harness.edl/v1", entries: [{ source_id: sourceId, in: 0, out: 2, order: 0, overlay: null, note: "" }] }) },
      {
        type: "timeline", relPath: "input/timeline/timeline.json",
        src: writeTempJson(dir, "timeline.json", {
          schema_version: "harness.timeline/v1", voice: "none", language: "vi", total_seconds: 2,
          video: [{ order: 0, source_id: sourceId, in: 0, out: 2, start: 0, end: 2 }], narration: [], speech: [],
        }),
      },
      { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
    ];

    const r = await invokeStage(seeded.world.studio, runId, "media-compose", ["media", "compose"], inputs, {}, forceClaim(seeded.world.studio, runId, "media-compose"));
    expect(r.result.outcome, `${JSON.stringify(r.result, null, 2)}\n${r.stdout}\n${r.stderr}`).toBe("succeeded");

    const composition: Composition = CompositionSchema.parse(JSON.parse(readFileSync(join(r.workspaceDir, "output", "composition.json"), "utf8")));
    expect(composition.brand).toBeNull();
    expect(composition.captions.mode).toBe("none");
    expect(composition.logo).toBeNull();
    expect(composition.music).toBeNull();
    expect(composition.music_reason).toBe("no_brand");
  }, 300_000);
});
