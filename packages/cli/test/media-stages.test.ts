import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EdlSchema, ShotsIndexSchema, TimelineSchema, TranscriptSchema, newId,
  type ClaimResult, type Edl, type NarrationTiming, type StageInput, type StageRequest, type StageResult,
} from "@harness/contracts";
import {
  BUILTIN_CHECKERS, HARNESS_ROOT, buildStageRequest, canonicalDigest, eventFor, libraryCheckers, mediaCheckers,
  mimeTypesFor, sha256File, stageDefinitionDigest, stageDefinitionFor, Verifier, type VerifyOutcome,
} from "@harness/core";
import { buildContext, type AppContext } from "../src/composition.js";
import { cli, freshLibraryWorld, librarySync, writeActiveStyle, type LibraryWorld } from "../../../tests/integration/library-helpers.js";
import { hasFfmpeg, makeVideo } from "../../../tests/media.js";

// Sub-project 5A Task 8: the four built-in `media index|transcribe|tts|fit-edl` stages, driven the same way
// `learning-stages.test.ts`/`publish-stage.test.ts` drive SP3/SP3B's own built-in stages -- a real
// run/content (via `plan`+`enqueue`), a real `store.claim()` per stage, a hand-built `stage-request.json`, a
// spawned `harness media <name>` (or `harness library stage intake` / `harness media watch`) subprocess, and
// `Controller.commit()` back in-process to unblock the next stage's claim. `survey-source`/`plan-edit` are
// agent stages with no real skill exercised here (that is `fake-agent-outputs.test.ts`'s job) -- they are
// fabricated the same way `learning-stages.test.ts` fabricates `propose-topics`: claimed for real, their
// expected output written by hand, committed as a hand-built `StageResult`.
//
// Fix round (task 8 review, Important 3): `commitResult` below always committed with a canned
// `verify: { results: [], allRequiredPassed: true, missing: [] }`, so none of the real checkers
// (`tts-valid`, `edl-valid`, `survey-valid`, `output-exists`, `checksum-match`, ...) ever actually ran
// against what a stage wrote -- which is how CRITICAL 1 (media-fit-edl reading the wrong survey input type)
// and CRITICAL 2 (`survey-valid` filtering on the wrong output type) both passed a fully green suite despite
// making a real `library-production@1.2.0` run impossible. `verifyStage` below runs the REAL `Verifier`,
// built the same way `composition.ts` builds it, with the checker set the workflow actually declares for
// that stage -- used for `media-tts` and `media-fit-edl`'s success cases, and (via `runFakeAgent`) for a
// `survey-source` result the real `fake-agent-cli.mjs` produces, to pin CRITICAL 2 specifically.
const FAKE_AGENT_CLI = join(HARNESS_ROOT, "fixtures", "fake-agent-cli.mjs");
const SHA = "sha256:" + "0".repeat(64);

const STYLE_ID = newId("edit_style");
const VOICE_CHECKSUM = "sha256:" + "a".repeat(64);

function claimStage(ctx: AppContext, runId: string, stageKey: string): ClaimResult {
  const stageRun = ctx.store.listStageRuns(runId).find((s) => s.stage_key === stageKey);
  if (!stageRun) throw new Error(`stage ${stageKey} not found on run ${runId} (state search failed)`);
  const claim = ctx.store.claim({ owner: "test", capabilities: stageRun.required_capabilities, now: ctx.clock.now(), leaseSeconds: 600, stageRunId: stageRun.stage_run_id, resourceCapacity: ctx.resourceCapacity });
  if (!claim) throw new Error(`could not claim ${stageKey} on run ${runId} (state ${stageRun.state})`);
  const run = ctx.store.getRun(runId)!;
  ctx.store.transaction(() => {
    ctx.store.transition("attempt", claim.attempt.attempt_id, "CLAIMED", "RUNNING", eventFor(run, claim.stageRun, claim.attempt, "attempt.started"));
    ctx.store.transition("stage_run", claim.stageRun.stage_run_id, "CLAIMED", "RUNNING", eventFor(run, claim.stageRun, claim.attempt, "stage.started"));
  });
  return claim;
}

function snapshotOutputs(workspaceDir: string): string {
  const snapshot = mkdtempSync(join(tmpdir(), "snap-"));
  cpSync(join(workspaceDir, "output"), join(snapshot, "output"), { recursive: true });
  return snapshot;
}

function fakeInput(type: string, path: string, kind: "file" | "directory"): StageInput {
  return { artifact_id: newId("artifact"), checksum: SHA, path, type, kind };
}

/** Real `Verifier`, built the same set of checkers `composition.ts` builds (`BUILTIN_CHECKERS` +
 * `mediaCheckers` + `libraryCheckers`), run against a stage's ACTUAL `stage-request.json`/`StageResult`/
 * workspace with the required-checks list the workflow itself declares for `stageKey` -- task 8 review,
 * Important 3. Must be called BEFORE `commitResult` moves the workspace's `output/` files out. */
async function verifyStage(project: string, runId: string, stageKey: string, workspaceDir: string, result: StageResult): Promise<VerifyOutcome> {
  const ctx = buildContext({ projectDir: project });
  try {
    const request = JSON.parse(readFileSync(join(workspaceDir, "stage-request.json"), "utf8")) as StageRequest;
    const run = ctx.store.getRun(runId)!;
    const def = stageDefinitionFor(ctx.workflows, run, stageKey);
    const verifier = new Verifier([...BUILTIN_CHECKERS, ...mediaCheckers(ctx.prober, { available: ctx.proberAvailable }), ...libraryCheckers(ctx.prober, { available: ctx.proberAvailable })]);
    return await verifier.verify({ request, result, workspaceDir }, def?.required_checks ?? []);
  } finally { ctx.close(); }
}

/** Asserts every required check passed (no missing checker, no failing/skipped-when-it-shouldn't-be verdict
 * for a check id that should have real evidence to check) -- printed evidence on failure names exactly which
 * checker/output/reason. */
function expectAllRequiredPassed(outcome: VerifyOutcome): void {
  expect(outcome.missing, `missing checkers: ${JSON.stringify(outcome)}`).toEqual([]);
  expect(outcome.allRequiredPassed, `not all required checks passed: ${JSON.stringify(outcome.results, null, 2)}`).toBe(true);
}

/** Spawns the REAL `fixtures/fake-agent-cli.mjs` (not `FakeAgentRuntime`) directly against a hand-built
 * workspace, the same technique `fake-agent-outputs.test.ts` uses for its own fixture spawns -- used here
 * only for the `survey-source` real-fake-agent-output pinning CRITICAL 2 (Important 3). */
function runFakeAgent(ws: string, request: StageRequest, env: Record<string, string> = {}): { status: number | null; out: string; err: string } {
  writeFileSync(join(ws, "agent-prompt.md"), "fake prompt for tests\n");
  writeFileSync(join(ws, "stage-request.json"), JSON.stringify(request, null, 2));
  const r = spawnSync(process.execPath, [FAKE_AGENT_CLI], { cwd: ws, env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
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

/** Claims a stage for real, then commits a hand-built `StageResult` in its place -- for the two agent stages
 * (`survey-source`, `plan-edit`) task 8's own fake-agent behaviour is covered elsewhere
 * (`fake-agent-outputs.test.ts`); here only their *shape* matters, to unblock the built-in stages downstream. */
async function fabricateAndCommit(project: string, runId: string, stageKey: string, outputs: { relPath: string; type: string; value: unknown }[]): Promise<void> {
  let claim: ClaimResult;
  {
    const ctx = buildContext({ projectDir: project });
    try { claim = claimStage(ctx, runId, stageKey); } finally { ctx.close(); }
  }
  const workspaceDir = mkdtempSync(join(tmpdir(), `ws-${stageKey}-`));
  const resultOutputs: StageResult["outputs"] = [];
  for (const o of outputs) {
    const abs = join(workspaceDir, "output", o.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(o.value, null, 2) + "\n");
    const { checksum, size_bytes } = await sha256File(abs);
    resultOutputs.push({ path: `output/${o.relPath}`, type: o.type, checksum, size_bytes, kind: "file" });
  }
  const result: StageResult = {
    schema_version: "harness.stage-result/v1", attempt_id: claim.attempt.attempt_id, outcome: "succeeded",
    outputs: resultOutputs, checks: [], usage: { wall_seconds: 0.1, cost_usd: 0 }, external_operations: [], errors: [],
  };
  await commitResult(project, runId, claim, workspaceDir, result);
}

function planRun(project: string, workflow: string, profile: string, contentId: string): string {
  const p = cli(project, ["plan", "--workflow", workflow, "--profile", profile, "--content", contentId, "--json"]);
  if (p.code !== 0) throw new Error(`plan failed: ${p.err}\n${p.out}`);
  const runId = (JSON.parse(p.out) as { run_id: string }).run_id;
  const e = cli(project, ["enqueue", runId]);
  if (e.code !== 0) throw new Error(`enqueue failed: ${e.err}\n${e.out}`);
  return runId;
}

function seedVoiceProfile(project: string, checksum = VOICE_CHECKSUM): string {
  const voiceId = newId("voice_profile");
  const ctx = buildContext({ projectDir: project });
  try {
    ctx.store.upsertVoiceProfile({
      schema_version: "harness.voice/v1", voice_id: voiceId, display_name: "Narrator", language: "vi",
      origin: "own", origin_note: "", ref_audio: { path: "ref.wav", checksum, duration_seconds: 5 },
      ref_text: "hi", params: { speed: 1, num_step: 32 }, revision: 1, status: "active",
      created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
    });
  } finally { ctx.close(); }
  return voiceId;
}

function briefJson(o: Partial<{ voice: "none" | "tts" | "original"; voice_id: string; voice_checksum: string; target_duration_seconds: [number, number] }> = {}): Record<string, unknown> {
  return {
    topic: "test topic", style_id: STYLE_ID, style_revision: 1, language: "vi",
    voice: o.voice ?? "tts", ...(o.voice_id ? { voice_id: o.voice_id } : {}), ...(o.voice_checksum ? { voice_checksum: o.voice_checksum } : {}),
    ...(o.target_duration_seconds ? { target_duration_seconds: o.target_duration_seconds } : {}),
  };
}

function writeTempJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  return path;
}

describe.skipIf(!hasFfmpeg())("harness media index|transcribe|tts|fit-edl (sub-project 5A task 8)", () => {
  let world: LibraryWorld;
  let runId: string;
  let sourceIds: string[];
  let voiceId: string;

  let indexSnap: string;
  let transcribeSnap: string;
  let watchSourceSnap: string;
  let mediaTtsClaim: { claim: ClaimResult; runId: string };
  let mediaFitEdlClaim: { claim: ClaimResult; runId: string };

  beforeAll(async () => {
    world = freshLibraryWorld({ media: false });
    writeActiveStyle(world.lib, STYLE_ID);
    librarySync(world.studio);
    voiceId = seedVoiceProfile(world.studio);

    const rawDir = join(world.studio, "raw");
    mkdirSync(rawDir, { recursive: true });
    const clip1 = join(rawDir, "clip1.mp4");
    const clip2 = join(rawDir, "clip2.mp4");
    makeVideo(clip1, { seconds: 3, audio: true });
    makeVideo(clip2, { seconds: 4, audio: true });

    const ing1 = JSON.parse(cli(world.studio, ["source", "ingest", clip1, "--collection", "main", "--rights", "cleared", "--language", "vi", "--json"]).out) as { source_id: string };
    const ing2 = JSON.parse(cli(world.studio, ["source", "ingest", clip2, "--collection", "main", "--rights", "cleared", "--language", "vi", "--json"]).out) as { source_id: string };
    sourceIds = [ing1.source_id, ing2.source_id];

    let contentId: string;
    {
      const ctx = buildContext({ projectDir: world.studio });
      try {
        // `voice: none` here on purpose: intake's own voice-checksum gate only applies to *its own* brief,
        // and each `media tts` scenario below supplies its own hand-built brief.json regardless of what
        // intake produced -- this run only needs to progress the DAG through intake/media-index/etc.
        const content = ctx.catalog.createContent({
          source_ids: sourceIds, title: "media stages test",
          library_brief: { topic: "test topic", style_id: STYLE_ID, style_revision: 1, voice: "none", language: "vi", target_duration_seconds: [3, 30] },
        });
        contentId = content.content_id;
      } finally { ctx.close(); }
    }

    runId = planRun(world.studio, "library-production@1.2.0", "studio", contentId);

    await runAndCommit(world.studio, runId, "intake", ["library", "stage", "intake"]);
    const indexResult = await runAndCommit(world.studio, runId, "media-index", ["media", "index"]);
    indexSnap = indexResult.workspaceSnapshot;
    const transcribeResult = await runAndCommit(world.studio, runId, "media-transcribe", ["media", "transcribe"], [
      { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
    ]);
    transcribeSnap = transcribeResult.workspaceSnapshot;
    const watchResult = await runAndCommit(world.studio, runId, "watch-source", ["media", "watch", "--mode", "source"], [
      { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
      { type: "proxy_set", relPath: "input/proxy/proxy", kind: "directory", src: join(indexSnap, "output", "proxy") },
      { type: "transcript", relPath: "input/transcript/transcript.json", src: join(transcribeSnap, "output", "transcript.json") },
    ]);
    watchSourceSnap = watchResult.workspaceSnapshot;

    const shots = JSON.parse(readFileSync(join(indexSnap, "output", "shots.json"), "utf8"));

    // survey-source (fabricated): every shot usable, score 3, speech "none" -- matches the fake-agent's own
    // baseline (fake-agent-outputs.test.ts exercises the fake agent's real generation logic).
    const surveyShots = shots.sources.flatMap((s: { source_id: string; shots: { shot_id: string; in: number; out: number }[] }) =>
      s.shots.map((sh) => ({ source_id: s.source_id, shot_id: sh.shot_id, in: sh.in, out: sh.out, score: 3, tags: [], usable: true, note: "", speech: "none" })),
    );
    await fabricateAndCommit(world.studio, runId, "survey-source", [
      { relPath: "survey.json", type: "survey_index", value: { schema_version: "harness.survey-index/v2", shots: surveyShots } },
    ]);

    // plan-edit (fabricated): one EDL entry per source's first shot, a single narration line long enough
    // that fit-edl must append more footage to cover it (acceptance: "lời dài -> fit-report.json có appended").
    const edl: Edl = {
      schema_version: "harness.edl/v1",
      entries: shots.sources.map((s: { source_id: string; shots: { in: number; out: number }[] }, i: number) => ({
        source_id: s.source_id, in: s.shots[0].in, out: Math.min(s.shots[0].in + 0.5, s.shots[0].out), order: i, overlay: null, note: "",
      })),
    };
    await fabricateAndCommit(world.studio, runId, "plan-edit", [
      { relPath: "edl.json", type: "edl", value: edl },
      { relPath: "edit-plan.json", type: "edit_plan", value: { schema_version: "harness.edit-plan/v1", notes: "" } },
      { relPath: "narration.json", type: "narration", value: { schema_version: "harness.narration/v1", language: "vi", lines: [{ line_id: "L001", edl_order: 0, text: "x".repeat(120) }] } },
    ]);

    // Claim media-tts and media-fit-edl once each (for real); individual `it()`s below reuse these claims
    // via `claimOverride` to exercise several input scenarios without re-claiming (mirrors
    // `learning-stages.test.ts`'s idempotent-rerun trick).
    {
      const ctx = buildContext({ projectDir: world.studio });
      try { mediaTtsClaim = { claim: claimStage(ctx, runId, "media-tts"), runId }; } finally { ctx.close(); }
    }
  });

  it("media index: 2 sources -> shots.json (harness.shots/v2) with 2 sources, 2 proxy files", () => {
    const shotsRaw = JSON.parse(readFileSync(join(indexSnap, "output", "shots.json"), "utf8"));
    const shots = ShotsIndexSchema.parse(shotsRaw);
    expect(shots.sources).toHaveLength(2);
    expect(shots.sources.map((s) => s.source_id).sort()).toEqual([...sourceIds].sort());
    for (const s of shots.sources) expect(s.shots.length).toBeGreaterThan(0);
    const proxyFiles = readdirSync(join(indexSnap, "output", "proxy"));
    expect(proxyFiles.sort()).toEqual(sourceIds.map((id) => `${id}.mp4`).sort());
  });

  it("media transcribe: transcript.json parses against TranscriptSchema, one entry per source", () => {
    const raw = JSON.parse(readFileSync(join(transcribeSnap, "output", "transcript.json"), "utf8"));
    const transcript = TranscriptSchema.parse(raw);
    expect(transcript.sources.map((s) => s.source_id).sort()).toEqual([...sourceIds].sort());
  });

  it("media watch --mode source (multi-source): watch.json has one directory per source, no zero-frame failure", () => {
    const watchJson = JSON.parse(readFileSync(join(watchSourceSnap, "output", "watch", "watch.json"), "utf8"));
    expect(watchJson.videos).toHaveLength(2);
    expect(watchJson.videos.map((v: { label: string }) => v.label).sort()).toEqual(["000", "001"]);
  });

  describe("media tts", () => {
    it("voice: tts with a voice profile in the kho -> voice/ wavs + narration-timing.json, not cached; rerun -> all cached", async () => {
      const dir = mkdtempSync(join(tmpdir(), "tts-brief-"));
      const briefPath = writeTempJson(dir, "brief.json", briefJson({ voice: "tts", voice_id: voiceId, voice_checksum: VOICE_CHECKSUM }));
      const narrationPath = writeTempJson(dir, "narration.json", { schema_version: "harness.narration/v1", language: "vi", lines: [{ line_id: "L001", edl_order: 0, text: "hello world this is a test line" }] });
      const inputs: InputSpec[] = [
        { type: "brief", relPath: "input/brief/brief.json", src: briefPath },
        { type: "narration", relPath: "input/narration/narration.json", src: narrationPath },
      ];

      const first = await invokeStage(world.studio, runId, "media-tts", ["media", "tts"], inputs, {}, mediaTtsClaim.claim);
      expect(first.result.outcome, JSON.stringify(first.result)).toBe("succeeded");
      const timing1 = JSON.parse(readFileSync(join(first.workspaceDir, "output", "narration-timing.json"), "utf8")) as NarrationTiming;
      expect(timing1.lines).toHaveLength(1);
      expect(timing1.lines[0]!.cached).toBe(false);
      expect(timing1.voice_id).toBe(voiceId);
      const voiceFiles = readdirSync(join(first.workspaceDir, "output", "voice"));
      expect(voiceFiles).toContain("L001.wav");

      // Important 3: the REAL verifier, with media-tts's own required_checks (includes tts-valid) --
      // pre-fix-round this never ran at all (commitResult always faked a passing verify outcome).
      expectAllRequiredPassed(await verifyStage(world.studio, runId, "media-tts", first.workspaceDir, first.result));

      const second = await invokeStage(world.studio, runId, "media-tts", ["media", "tts"], inputs, {}, mediaTtsClaim.claim);
      expect(second.result.outcome, JSON.stringify(second.result)).toBe("succeeded");
      const timing2 = JSON.parse(readFileSync(join(second.workspaceDir, "output", "narration-timing.json"), "utf8")) as NarrationTiming;
      expect(timing2.lines.every((l) => l.cached)).toBe(true);
    });

    it("voice: none -> empty timing, empty voice/ directory, no engine call needed", async () => {
      const dir = mkdtempSync(join(tmpdir(), "tts-brief-none-"));
      const briefPath = writeTempJson(dir, "brief.json", briefJson({ voice: "none" }));
      const narrationPath = writeTempJson(dir, "narration.json", { schema_version: "harness.narration/v1", language: "vi", lines: [] });
      const inputs: InputSpec[] = [
        { type: "brief", relPath: "input/brief/brief.json", src: briefPath },
        { type: "narration", relPath: "input/narration/narration.json", src: narrationPath },
      ];
      const r = await invokeStage(world.studio, runId, "media-tts", ["media", "tts"], inputs, {}, mediaTtsClaim.claim);
      expect(r.result.outcome, JSON.stringify(r.result)).toBe("succeeded");
      const timing = JSON.parse(readFileSync(join(r.workspaceDir, "output", "narration-timing.json"), "utf8")) as NarrationTiming;
      expect(timing.lines).toEqual([]);
      expect(timing.voice_id).toBeNull();
      expect(existsSync(join(r.workspaceDir, "output", "voice"))).toBe(true);
    });

    it("voice checksum mismatch (kho drift since intake) -> contract failure", async () => {
      const dir = mkdtempSync(join(tmpdir(), "tts-brief-mismatch-"));
      const briefPath = writeTempJson(dir, "brief.json", briefJson({ voice: "tts", voice_id: voiceId, voice_checksum: "sha256:" + "f".repeat(64) }));
      const narrationPath = writeTempJson(dir, "narration.json", { schema_version: "harness.narration/v1", language: "vi", lines: [{ line_id: "L001", edl_order: 0, text: "mismatch check line" }] });
      const inputs: InputSpec[] = [
        { type: "brief", relPath: "input/brief/brief.json", src: briefPath },
        { type: "narration", relPath: "input/narration/narration.json", src: narrationPath },
      ];
      const r = await invokeStage(world.studio, runId, "media-tts", ["media", "tts"], inputs, {}, mediaTtsClaim.claim);
      expect(r.result.outcome, JSON.stringify(r.result)).toBe("failed");
      expect(r.result.errors[0]?.kind).toBe("contract");
      expect(r.result.errors[0]?.message).toContain("checksum");
    });
  });

  describe("media fit-edl", () => {
    beforeAll(async () => {
      // Commit a "voice: none" media-tts result for real, purely to satisfy media-fit-edl's own DAG
      // readiness (depends_on: media-tts) -- the individual fit-edl scenarios below supply their own
      // hand-built narration_timing input regardless of what this commits.
      const dir = mkdtempSync(join(tmpdir(), "tts-commit-"));
      const briefPath = writeTempJson(dir, "brief.json", briefJson({ voice: "none" }));
      const narrationPath = writeTempJson(dir, "narration.json", { schema_version: "harness.narration/v1", language: "vi", lines: [] });
      const inputs: InputSpec[] = [
        { type: "brief", relPath: "input/brief/brief.json", src: briefPath },
        { type: "narration", relPath: "input/narration/narration.json", src: narrationPath },
      ];
      const r = await invokeStage(world.studio, runId, "media-tts", ["media", "tts"], inputs, {}, mediaTtsClaim.claim);
      if (r.result.outcome !== "succeeded") throw new Error(`media-tts commit-pass failed: ${JSON.stringify(r.result)}`);
      await commitResult(world.studio, runId, mediaTtsClaim.claim, r.workspaceDir, r.result);

      const ctx = buildContext({ projectDir: world.studio });
      try { mediaFitEdlClaim = { claim: claimStage(ctx, runId, "media-fit-edl"), runId }; } finally { ctx.close(); }
    });

    it("a narration line longer than the picked shot -> fit-report.json has an appended entry; edl.json/timeline.json validate; exit 0", async () => {
      const shots = JSON.parse(readFileSync(join(indexSnap, "output", "shots.json"), "utf8"));
      const edl: Edl = {
        schema_version: "harness.edl/v1",
        entries: [{ source_id: shots.sources[0].source_id, in: shots.sources[0].shots[0].in, out: Math.min(shots.sources[0].shots[0].in + 0.5, shots.sources[0].shots[0].out), order: 0, overlay: null, note: "" }],
      };
      const timing: NarrationTiming = {
        schema_version: "harness.narration-timing/v1", voice_id: voiceId, voice_revision: 1, total_seconds: 6,
        lines: [{ line_id: "L001", edl_order: 0, text: "x".repeat(90), wav: "voice/L001.wav", duration_seconds: 6, chunks: [{ text: "x".repeat(90), start: 0, end: 6 }], words: [], alignment: "chunk", cached: false }],
      };
      const dir = mkdtempSync(join(tmpdir(), "fit-edl-"));
      const inputs: InputSpec[] = [
        { type: "brief", relPath: "input/brief/brief.json", src: writeTempJson(dir, "brief.json", briefJson({ voice: "tts", target_duration_seconds: [1, 60] })) },
        { type: "edl", relPath: "input/edl/edl.json", src: writeTempJson(dir, "edl.json", edl) },
        { type: "narration_timing", relPath: "input/narration_timing/narration-timing.json", src: writeTempJson(dir, "narration-timing.json", timing) },
        { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
      ];
      const r = await invokeStage(world.studio, runId, "media-fit-edl", ["media", "fit-edl"], inputs, {}, mediaFitEdlClaim.claim);
      expect(r.result.outcome, JSON.stringify(r.result)).toBe("succeeded");

      const edlOut = EdlSchema.parse(JSON.parse(readFileSync(join(r.workspaceDir, "output", "edl.json"), "utf8")));
      expect(edlOut.entries.length).toBeGreaterThan(0);
      const report = JSON.parse(readFileSync(join(r.workspaceDir, "output", "fit-report.json"), "utf8"));
      expect(report.entries.some((e: { action: string }) => e.action === "appended")).toBe(true);
      const timeline = TimelineSchema.parse(JSON.parse(readFileSync(join(r.workspaceDir, "output", "timeline.json"), "utf8")));
      expect(timeline.narration).toHaveLength(1);

      // Important 3: the REAL verifier, with media-fit-edl's own required_checks (includes edl-valid) --
      // pinned here so a future edl-valid regression on the fitted output is caught, not only on the
      // agent-authored EDL plan-edit hands in.
      expectAllRequiredPassed(await verifyStage(world.studio, runId, "media-fit-edl", r.workspaceDir, r.result));
    });

    it("a narration need far beyond every source's footage -> succeeds anyway (exit 0), fit-report.json carries shortfalls", async () => {
      const shots = JSON.parse(readFileSync(join(indexSnap, "output", "shots.json"), "utf8"));
      const edl: Edl = {
        schema_version: "harness.edl/v1",
        entries: [{ source_id: shots.sources[0].source_id, in: shots.sources[0].shots[0].in, out: Math.min(shots.sources[0].shots[0].in + 0.3, shots.sources[0].shots[0].out), order: 0, overlay: null, note: "" }],
      };
      const timing: NarrationTiming = {
        schema_version: "harness.narration-timing/v1", voice_id: voiceId, voice_revision: 1, total_seconds: 600,
        lines: [{ line_id: "L001", edl_order: 0, text: "x".repeat(90), wav: "voice/L001.wav", duration_seconds: 600, chunks: [{ text: "x".repeat(90), start: 0, end: 600 }], words: [], alignment: "chunk", cached: false }],
      };
      const dir = mkdtempSync(join(tmpdir(), "fit-edl-shortfall-"));
      const inputs: InputSpec[] = [
        { type: "brief", relPath: "input/brief/brief.json", src: writeTempJson(dir, "brief.json", briefJson({ voice: "tts" })) },
        { type: "edl", relPath: "input/edl/edl.json", src: writeTempJson(dir, "edl.json", edl) },
        { type: "narration_timing", relPath: "input/narration_timing/narration-timing.json", src: writeTempJson(dir, "narration-timing.json", timing) },
        { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
      ];
      const r = await invokeStage(world.studio, runId, "media-fit-edl", ["media", "fit-edl"], inputs, {}, mediaFitEdlClaim.claim);
      expect(r.result.outcome, JSON.stringify(r.result)).toBe("succeeded");
      const report = JSON.parse(readFileSync(join(r.workspaceDir, "output", "fit-report.json"), "utf8"));
      expect(report.shortfalls.length).toBeGreaterThan(0);

      const ctx = buildContext({ projectDir: world.studio });
      try {
        const events = ctx.store.listEvents({ event_type: "media.fit_shortfall" });
        expect(events.length).toBeGreaterThan(0);
      } finally { ctx.close(); }
    });

    // Important 5(a): a real v2 survey_index input, with a transcript input alongside it, actually steers
    // rule 4's ("best unused shot anywhere") choice by score -- not just parsed and ignored. Two same-length
    // candidate shots on a second source, scored 1 and 5; the base entry already fills its own shot exactly
    // (so rules 2/3 have no room to grow it), forcing the deficit onto rule 4 across both candidates.
    it("with a real v2 survey_index + transcript input: the appended shot is the higher-scored candidate, not just the first one", async () => {
      const srcA = newId("source_item");
      const srcB = newId("source_item");
      const shots = {
        schema_version: "harness.shots/v2",
        sources: [
          { source_id: srcA, index: 0, file_name: "a.mp4", duration_seconds: 30, has_audio: true, shots: [{ shot_id: "s000-000", in: 0, out: 5 }] },
          { source_id: srcB, index: 1, file_name: "b.mp4", duration_seconds: 30, has_audio: true, shots: [
            { shot_id: "s001-000", in: 0, out: 5 },
            { shot_id: "s001-001", in: 5, out: 10 },
          ] },
        ],
      };
      const surveyIndex = {
        schema_version: "harness.survey-index/v2",
        shots: [
          { source_id: srcA, shot_id: "s000-000", in: 0, out: 5, score: 3, tags: [], usable: true, note: "", speech: "none" },
          { source_id: srcB, shot_id: "s001-000", in: 0, out: 5, score: 1, tags: [], usable: true, note: "low score", speech: "none" },
          { source_id: srcB, shot_id: "s001-001", in: 5, out: 10, score: 5, tags: [], usable: true, note: "high score", speech: "none" },
        ],
      };
      const transcript = { schema_version: "harness.transcript/v1", engine: "fake", sources: [
        { source_id: srcA, language: "vi", alignment: "word", segments: [] },
        { source_id: srcB, language: "vi", alignment: "word", segments: [] },
      ] };
      const edl: Edl = { schema_version: "harness.edl/v1", entries: [{ source_id: srcA, in: 0, out: 5, order: 0, overlay: null, note: "" }] };
      const timing: NarrationTiming = {
        schema_version: "harness.narration-timing/v1", voice_id: voiceId, voice_revision: 1, total_seconds: 8,
        lines: [{ line_id: "L001", edl_order: 0, text: "x".repeat(90), wav: "voice/L001.wav", duration_seconds: 8, chunks: [{ text: "x".repeat(90), start: 0, end: 8 }], words: [], alignment: "chunk", cached: false }],
      };

      const dir = mkdtempSync(join(tmpdir(), "fit-edl-survey-v2-"));
      const inputs: InputSpec[] = [
        { type: "brief", relPath: "input/brief/brief.json", src: writeTempJson(dir, "brief.json", briefJson({ voice: "tts", target_duration_seconds: [1, 60] })) },
        { type: "edl", relPath: "input/edl/edl.json", src: writeTempJson(dir, "edl.json", edl) },
        { type: "narration_timing", relPath: "input/narration_timing/narration-timing.json", src: writeTempJson(dir, "narration-timing.json", timing) },
        { type: "shots", relPath: "input/shots/shots.json", src: writeTempJson(dir, "shots.json", shots) },
        { type: "survey_index", relPath: "input/survey_index/survey.json", src: writeTempJson(dir, "survey.json", surveyIndex) },
        { type: "transcript", relPath: "input/transcript/transcript.json", src: writeTempJson(dir, "transcript.json", transcript) },
      ];
      const r = await invokeStage(world.studio, runId, "media-fit-edl", ["media", "fit-edl"], inputs, {}, mediaFitEdlClaim.claim);
      expect(r.result.outcome, JSON.stringify(r.result)).toBe("succeeded");
      const report = JSON.parse(readFileSync(join(r.workspaceDir, "output", "fit-report.json"), "utf8"));
      const appended = report.entries.filter((e: { action: string }) => e.action === "appended");
      expect(appended, JSON.stringify(report)).toHaveLength(1);
      expect(appended[0].source_id).toBe(srcB);
      expect(appended[0].after.in).toBe(5); // the score-5 shot (s001-001, in=5..10) beat the score-1 shot (in=0..5)
    });

    // Important 5(b): a v1 (single-source) survey input under type survey_index still parses (AnySurveyIndexSchema
    // accepts it), but folds to `null` for fitEdl -- the stage must still succeed (natural shot order/default
    // score-0 usable-true, same as no survey input at all).
    it("with a v1-shaped survey_index input: folds to null (no schema_version harness.survey-index/v2), stage still succeeds", async () => {
      const shots = JSON.parse(readFileSync(join(indexSnap, "output", "shots.json"), "utf8"));
      const edl: Edl = {
        schema_version: "harness.edl/v1",
        entries: [{ source_id: shots.sources[0].source_id, in: shots.sources[0].shots[0].in, out: shots.sources[0].shots[0].out, order: 0, overlay: null, note: "" }],
      };
      const timing: NarrationTiming = {
        schema_version: "harness.narration-timing/v1", voice_id: voiceId, voice_revision: 1, total_seconds: 1,
        lines: [{ line_id: "L001", edl_order: 0, text: "short line", wav: "voice/L001.wav", duration_seconds: 1, chunks: [{ text: "short line", start: 0, end: 1 }], words: [], alignment: "chunk", cached: false }],
      };
      const v1Survey = { schema_version: "harness.survey-index/v1", shots: [{ in: 0, out: 1, score: 5, tags: [], usable: true, note: "" }] };
      const dir = mkdtempSync(join(tmpdir(), "fit-edl-survey-v1-"));
      const inputs: InputSpec[] = [
        { type: "brief", relPath: "input/brief/brief.json", src: writeTempJson(dir, "brief.json", briefJson({ voice: "tts" })) },
        { type: "edl", relPath: "input/edl/edl.json", src: writeTempJson(dir, "edl.json", edl) },
        { type: "narration_timing", relPath: "input/narration_timing/narration-timing.json", src: writeTempJson(dir, "narration-timing.json", timing) },
        { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
        { type: "survey_index", relPath: "input/survey_index/survey.json", src: writeTempJson(dir, "survey.json", v1Survey) },
      ];
      const r = await invokeStage(world.studio, runId, "media-fit-edl", ["media", "fit-edl"], inputs, {}, mediaFitEdlClaim.claim);
      expect(r.result.outcome, JSON.stringify(r.result)).toBe("succeeded");
    });

    // Important 5(c): a survey_index input that fails AnySurveyIndexSchema entirely must fail the stage as
    // `contract`, with a message naming the offending file/input -- not a transient failure, not a silent
    // fold-to-null.
    it("with a malformed survey_index input: fails contract, message names the survey input", async () => {
      const shots = JSON.parse(readFileSync(join(indexSnap, "output", "shots.json"), "utf8"));
      const edl: Edl = {
        schema_version: "harness.edl/v1",
        entries: [{ source_id: shots.sources[0].source_id, in: shots.sources[0].shots[0].in, out: shots.sources[0].shots[0].out, order: 0, overlay: null, note: "" }],
      };
      const timing: NarrationTiming = {
        schema_version: "harness.narration-timing/v1", voice_id: voiceId, voice_revision: 1, total_seconds: 1,
        lines: [{ line_id: "L001", edl_order: 0, text: "short line", wav: "voice/L001.wav", duration_seconds: 1, chunks: [{ text: "short line", start: 0, end: 1 }], words: [], alignment: "chunk", cached: false }],
      };
      const dir = mkdtempSync(join(tmpdir(), "fit-edl-survey-malformed-"));
      const inputs: InputSpec[] = [
        { type: "brief", relPath: "input/brief/brief.json", src: writeTempJson(dir, "brief.json", briefJson({ voice: "tts" })) },
        { type: "edl", relPath: "input/edl/edl.json", src: writeTempJson(dir, "edl.json", edl) },
        { type: "narration_timing", relPath: "input/narration_timing/narration-timing.json", src: writeTempJson(dir, "narration-timing.json", timing) },
        { type: "shots", relPath: "input/shots/shots.json", src: join(indexSnap, "output", "shots.json") },
        { type: "survey_index", relPath: "input/survey_index/survey.json", src: writeTempJson(dir, "survey.json", { schema_version: "harness.survey-index/v2", shots: "not an array" }) },
      ];
      const r = await invokeStage(world.studio, runId, "media-fit-edl", ["media", "fit-edl"], inputs, {}, mediaFitEdlClaim.claim);
      expect(r.result.outcome, JSON.stringify(r.result)).toBe("failed");
      expect(r.result.errors[0]?.kind).toBe("contract");
      expect(r.result.errors[0]?.message).toContain("survey.json");
    });
  });
});

// Important 3 (task 8 review): pins CRITICAL 2 specifically -- the REAL fake-agent-cli.mjs (not
// FakeAgentRuntime, not a hand-fabricated result) must produce a `survey.md` + `survey.json` pair that the
// REAL `survey-valid` checker (and the other required checks `survey-source` declares in
// library-production@1.2.0) actually accept. Standalone: needs no run/claim/DAG progression, only a real
// project (for `app.prober`/`app.proberAvailable`) to build the same `Verifier` `composition.ts` builds.
describe.skipIf(!hasFfmpeg())("fake-agent-cli.mjs survey-source output passes the real survey-valid checker (pins CRITICAL 2)", () => {
  it("survey.md (type survey) + survey.json (type survey_index) from a real fake-agent-cli.mjs run pass schema-valid/output-exists/checksum-match/survey-valid", async () => {
    const world = freshLibraryWorld({ media: false });
    const ws = mkdtempSync(join(tmpdir(), "survey-source-real-"));

    const sourceId = newId("source_item");
    const shots = {
      schema_version: "harness.shots/v2",
      sources: [{ source_id: sourceId, index: 0, file_name: "a.mp4", duration_seconds: 10, has_audio: true, shots: [{ shot_id: "s000-000", in: 0, out: 5 }, { shot_id: "s000-001", in: 5, out: 10 }] }],
    };
    const transcript = { schema_version: "harness.transcript/v1", engine: "fake", sources: [{ source_id: sourceId, language: "vi", alignment: "word", segments: [] }] };
    const shotsAbs = join(ws, "input", "shots", "shots.json");
    mkdirSync(dirname(shotsAbs), { recursive: true });
    writeFileSync(shotsAbs, JSON.stringify(shots));
    const transcriptAbs = join(ws, "input", "transcript", "transcript.json");
    mkdirSync(dirname(transcriptAbs), { recursive: true });
    writeFileSync(transcriptAbs, JSON.stringify(transcript));
    const briefAbs = join(ws, "input", "brief", "brief.json");
    mkdirSync(dirname(briefAbs), { recursive: true });
    writeFileSync(briefAbs, JSON.stringify({ topic: "x", style_id: newId("edit_style"), style_revision: 1, voice: "none", language: "vi", request_notes: "" }));

    const request: StageRequest = {
      schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
      project_id: "p", portfolio_id: "pf", stage_key: "survey-source",
      workflow: { id: "library-production", version: "1.2.0", digest: SHA },
      profile_snapshot: { id: "studio", revision: 3 },
      inputs: [
        { artifact_id: "a_shots", checksum: SHA, path: "input/shots/shots.json", type: "shots", kind: "file" },
        { artifact_id: "a_transcript", checksum: SHA, path: "input/transcript/transcript.json", type: "transcript", kind: "file" },
        { artifact_id: "a_brief", checksum: SHA, path: "input/brief/brief.json", type: "brief", kind: "file" },
      ],
      workspace_uri: ws, stage_config: {}, options: {}, source_items: [], resources: [],
      expected_outputs: [
        { type: "survey", mime_type: "text/markdown", kind: "file", name: "survey.md" },
        { type: "survey_index", mime_type: "application/json", kind: "file", name: "survey.json" },
      ],
      policy: {}, limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 3 },
      capabilities: [], fencing_token: 1,
    };

    const spawned = runFakeAgent(ws, request);
    expect(spawned.status, `stderr: ${spawned.err}`).toBe(0);

    const outputs: StageResult["outputs"] = [];
    for (const [name, type] of [["survey.md", "survey"], ["survey.json", "survey_index"]] as const) {
      const { checksum, size_bytes } = await sha256File(join(ws, "output", name));
      outputs.push({ path: `output/${name}`, type, checksum, size_bytes, kind: "file" });
    }
    const result: StageResult = {
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "succeeded",
      outputs, checks: [], usage: { wall_seconds: 0.1, cost_usd: 0 }, external_operations: [], errors: [],
    };

    const ctx = buildContext({ projectDir: world.studio });
    try {
      const verifier = new Verifier([...BUILTIN_CHECKERS, ...mediaCheckers(ctx.prober, { available: ctx.proberAvailable }), ...libraryCheckers(ctx.prober, { available: ctx.proberAvailable })]);
      const outcome = await verifier.verify({ request, result, workspaceDir: ws }, ["schema-valid", "output-exists", "checksum-match", "survey-valid"]);
      expectAllRequiredPassed(outcome);
    } finally { ctx.close(); }
  });
});
