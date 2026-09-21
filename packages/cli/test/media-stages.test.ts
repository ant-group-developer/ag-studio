import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EdlSchema, ShotsIndexSchema, TimelineSchema, TranscriptSchema, newId,
  type ClaimResult, type Edl, type NarrationTiming, type StageInput, type StageResult,
} from "@harness/contracts";
import { HARNESS_ROOT, buildStageRequest, canonicalDigest, eventFor, mimeTypesFor, sha256File, stageDefinitionDigest, stageDefinitionFor } from "@harness/core";
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
  return { artifact_id: newId("artifact"), checksum: "sha256:" + "0".repeat(64), path, type, kind };
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
  });
});
