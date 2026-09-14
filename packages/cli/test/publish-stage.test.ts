import { createHash } from "node:crypto";
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { newId, type ClaimResult, type PackageReceipt, type StageInput, type StageResult, type UploadReceipt } from "@harness/contracts";
import { HARNESS_ROOT, buildStageRequest, canonicalDigest, eventFor, mimeTypesFor, sha256File, stageDefinitionDigest, stageDefinitionFor, transitionPublication } from "@harness/core";
import { buildContext, type AppContext } from "../src/composition.js";
import { cli, freshLibraryWorld, librarySync, type LibraryWorld } from "../../../tests/integration/library-helpers.js";

// Task 8: `harness publish stage fetch|build-package|upload|schedule`. These built-in stages are only ever run
// as a re-invoked CLI subcommand inside a `ScriptExecutor`-provided workspace, so the tests drive that shape
// directly: a real run/content (via `plan`+`enqueue`), a real `store.claim()` for the stage under test, a
// hand-built `stage-request.json`, a spawned `harness publish stage <name>` subprocess, and (for the stages
// worth chaining) a `Controller.commit()` back in-process to unblock the next stage's claim. Only the four
// built-in stages are under test: the workflow's `package` stage (an agent) is faked by writing its expected
// `channel_package_draft` output directly and committing it, since `FakeAgentRuntime` writes generic notes and
// there is no real `channel-package` skill yet (that lands with the agent runtime work, not this task).

const LEGACY_REPO_FIXTURE = join(HARNESS_ROOT, "fixtures", "legacy-channel-repo");
const CHANNEL_ID = "c1";
const SECRET_ENV = { HARNESS_SECRET_YOUTUBE_C1_EMAIL: "owner@example.com" };

function sha256Hex(buf: Buffer | string): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

/** Fresh temp copy of `fixtures/legacy-channel-repo`, so each test file run gets its own `outputs/`. */
function setupChannelRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "legacy-repo-"));
  cpSync(LEGACY_REPO_FIXTURE, dir, { recursive: true });
  return dir;
}

/** Adds `adapters`/`resources` to the temp channel project's `project.yaml` and a `channels/c1/channel.yaml`
 * pointing at `repoDir`. `episode.start: 15` makes the first package's episode number a fixed, assertable 15. */
function addChannel(project: string, repoDir: string): void {
  const cfgPath = join(project, "project.yaml");
  const cfg = parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  cfg.adapters = { publisher: "playwright", agent: "fake" };
  // several tests below deliberately never commit their `upload`/`schedule` claim (only the outcome the
  // stage-result.json reports matters, not DAG progression), so their lease on `browser` is held forever;
  // a generous capacity keeps later tests' claims from starving on it.
  cfg.resources = { browser: 20 };
  writeFileSync(cfgPath, stringify(cfg));

  const channelDir = join(project, "channels", CHANNEL_ID);
  mkdirSync(channelDir, { recursive: true });
  const channelYaml = {
    schema_version: "harness.channel-config/v1",
    channel_id: CHANNEL_ID,
    display_name: "Channel One",
    portfolio_id: "portfolio-channel",
    repo_dir: repoDir.split("\\").join("/"),
    legacy_project_id: "project-01",
    youtube: { expected_channel_id: "UCfake000000000000000001", account_email_ref: `secret://youtube-${CHANNEL_ID}/email` },
    publication: { timezone: "Asia/Ho_Chi_Minh", publish_times: ["09:00", "18:00"], max_daily_uploads: 3, min_gap_hours: 1 },
    episode: { start: 15, dir_pattern: "episode-{nn}" },
    overlay: { enabled: true, side: "right" },
  };
  writeFileSync(join(channelDir, "channel.yaml"), stringify(channelYaml));
}

/** A kho item with an `episode.mp4` and one `image/png` thumbnail (so `build-package` has a real thumbnail
 * candidate to work with) -- `tests/integration/library-helpers.ts`'s shared `writeLibraryItem` only writes the
 * video, so this is a local variant rather than a change to that shared helper. */
function writeApprovedItem(lib: string, itemId: string): void {
  const dir = join(lib, "items", itemId);
  mkdirSync(dir, { recursive: true });
  const videoBody = `fake episode bytes for ${itemId}\n`;
  const thumbBody = `fake png bytes for ${itemId}`;
  writeFileSync(join(dir, "episode.mp4"), videoBody);
  writeFileSync(join(dir, "thumb1.png"), thumbBody);
  const item = {
    schema_version: "harness.library-item/v1", item_id: itemId, status: "approved", title_hint: `Ep ${itemId}`, summary: "seed summary",
    style: { style_id: newId("edit_style"), revision: 1 }, duration_seconds: 5, media: null,
    files: [
      { path: "episode.mp4", checksum: sha256Hex(videoBody), size_bytes: Buffer.byteLength(videoBody), mime_type: "video/mp4" },
      { path: "thumb1.png", checksum: sha256Hex(thumbBody), size_bytes: Buffer.byteLength(thumbBody), mime_type: "image/png" },
    ],
    lineage: { project_id: "project-studio", run_id: newId("run"), content_id: newId("content_item"), source_ids: [] },
    review: { note: "" }, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(item, null, 2) + "\n");
}

function sampleDraft(overlayLines: string[] = ["Big Reveal", "Watch Now"]): unknown {
  return {
    schema_version: "harness.channel-package-draft/v1",
    metadata: { title: "Episode Title", description: "desc", tags: ["a", "b"], playlists: [], hashtags: ["#shorts"], pinned_comment: "", language: "en" },
    hypothesis: {
      schema_version: "harness.hypothesis/v1", hypothesis_id: newId("hypothesis"),
      basis: [{ kind: "manual", note: "seed" }],
      chosen: { title: "Episode Title", thumbnail_candidate: "thumb1.png", overlay_text: overlayLines, angle: "" },
      rejected: [{ title: "Other angle", angle: "", why: "weaker" }],
      expected: { metric: "ctr", target: 0.1, horizon_hours: 48 },
      status: "open", created_at: "2026-09-14T00:00:00.000Z",
    },
  };
}

function approvedContentId(project: string, lib: string, itemId: string): string {
  writeApprovedItem(lib, itemId);
  librarySync(project);
  const r = cli(project, ["library", "pick", itemId, "--channel", CHANNEL_ID, "--json"], SECRET_ENV);
  if (r.code !== 0) throw new Error(`library pick failed: ${r.err}\n${r.out}`);
  return (JSON.parse(r.out) as { content_id: string }).content_id;
}

function planPublishRun(project: string, contentId: string): string {
  const p = cli(project, ["plan", "--workflow", "channel-publish@1.0.0", "--profile", "channel", "--content", contentId, "--json"], SECRET_ENV);
  if (p.code !== 0) throw new Error(`plan failed: ${p.err}\n${p.out}`);
  const runId = (JSON.parse(p.out) as { run_id: string }).run_id;
  const e = cli(project, ["enqueue", runId], SECRET_ENV);
  if (e.code !== 0) throw new Error(`enqueue failed: ${e.err}\n${e.out}`);
  return runId;
}

/** Claims a stage_run by key and (mirroring `worker.ts`) moves the attempt/stage_run CLAIMED -> RUNNING, since
 * `Controller.commit` expects both to already be RUNNING. */
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

/** `Controller.commit` *moves* (renames) each declared output out of the workspace and into the artifact
 * store, so a workspace's `output/` is empty after a successful commit. Any downstream input this test file
 * copies from a committed stage's workspace must be snapshotted first. */
function snapshotOutputs(workspaceDir: string): string {
  const snapshot = mkdtempSync(join(tmpdir(), "snap-"));
  cpSync(join(workspaceDir, "output"), join(snapshot, "output"), { recursive: true });
  return snapshot;
}

function fakeInput(type: string, path: string, kind: "file" | "directory"): StageInput {
  return { artifact_id: newId("artifact"), checksum: "sha256:" + "0".repeat(64), path, type, kind };
}

interface InputSpec { type: string; relPath: string; kind?: "file" | "directory"; src: string }

/** Claims (unless `claimOverride` reuses an earlier claim -- the built-in stages never look at `stage_run`
 * state themselves, only `run_id`/inputs, so replaying a stage against the same claim is a legitimate way to
 * test its own idempotency without fighting the terminal `SUCCEEDED` state), hand-builds a `stage-request.json`
 * with `inputSpecs` materialized as fake inputs, and spawns `harness publish stage <cliName>`. */
async function invokeStage(project: string, runId: string, stageKey: string, cliName: string, inputSpecs: InputSpec[], envExtra: Record<string, string> = {}, claimOverride?: ClaimResult): Promise<{ result: StageResult; workspaceDir: string; claim: ClaimResult }> {
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
    else copyFileSync(s.src, dest);
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

  const r = cli(project, ["publish", "stage", cliName], { ...SECRET_ENV, ...envExtra, HARNESS_WORKSPACE: workspaceDir });
  const resultPath = join(workspaceDir, "stage-result.json");
  if (!existsSync(resultPath)) throw new Error(`publish stage ${cliName} wrote no stage-result.json (exit ${r.code}): ${r.err}\n${r.out}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as StageResult;
  return { result, workspaceDir, claim };
}

/** Progresses the workflow DAG (so the next stage's `claim()` can find a READY row) by committing a stage's
 * result through the real `Controller`, with a fabricated pass-through `verify` -- the checkers themselves are
 * exercised elsewhere; this file is about the built-in stage scripts. */
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

/** Fakes the `package` agent stage: claims it for real, but writes its `channel_package_draft` output by hand
 * and commits a hand-built `StageResult` instead of running any executor (see file header comment). */
async function fabricatePackageStage(project: string, runId: string, draft: unknown): Promise<{ workspaceDir: string }> {
  let claim: ClaimResult;
  {
    const ctx = buildContext({ projectDir: project });
    try { claim = claimStage(ctx, runId, "package"); } finally { ctx.close(); }
  }
  const workspaceDir = mkdtempSync(join(tmpdir(), "ws-package-"));
  const draftPath = join(workspaceDir, "output", "package.json");
  mkdirSync(dirname(draftPath), { recursive: true });
  writeFileSync(draftPath, JSON.stringify(draft, null, 2));
  const { checksum, size_bytes } = await sha256File(draftPath);
  const result: StageResult = {
    schema_version: "harness.stage-result/v1", attempt_id: claim.attempt.attempt_id, outcome: "succeeded",
    outputs: [{ path: "output/package.json", type: "channel_package_draft", checksum, size_bytes, kind: "file" }],
    checks: [], usage: { wall_seconds: 0.1, cost_usd: 0 }, external_operations: [], errors: [],
  };
  const snapshot = snapshotOutputs(workspaceDir);
  await commitResult(project, runId, claim, workspaceDir, result);
  return { workspaceDir: snapshot };
}

/** Full run through `fetch-library-item` (real subprocess) and `package` (fabricated), landing the run at the
 * point where `build-package`'s stage_run is READY. */
async function toBuildPackageReady(project: string, lib: string, draft: unknown): Promise<{ runId: string; fetchWorkspace: string; packageWorkspace: string }> {
  const itemId = newId("library_item");
  const contentId = approvedContentId(project, lib, itemId);
  const runId = planPublishRun(project, contentId);

  const fetch = await invokeStage(project, runId, "fetch-library-item", "fetch", []);
  if (fetch.result.outcome !== "succeeded") throw new Error(`fetch failed: ${JSON.stringify(fetch.result)}`);
  const fetchSnapshot = snapshotOutputs(fetch.workspaceDir);
  await commitResult(project, runId, fetch.claim, fetch.workspaceDir, fetch.result);

  const pkg = await fabricatePackageStage(project, runId, draft);
  return { runId, fetchWorkspace: fetchSnapshot, packageWorkspace: pkg.workspaceDir };
}

function buildPackageInputs(fetchWorkspace: string, packageWorkspace: string): InputSpec[] {
  return [
    { type: "channel_package_draft", relPath: "input/package/package.json", src: join(packageWorkspace, "output", "package.json") },
    { type: "episode_video", relPath: "input/episode/episode.mp4", src: join(fetchWorkspace, "output", "episode.mp4") },
    { type: "thumbnail_set", relPath: "input/thumbnails", kind: "directory", src: join(fetchWorkspace, "output", "thumbnails") },
  ];
}

/** Full run through `build-package` too, landing on a `READY` publication job. */
async function toReadyJob(project: string, lib: string, draft: unknown): Promise<{ runId: string; receipt: PackageReceipt; buildPackageWorkspace: string }> {
  const { runId, fetchWorkspace, packageWorkspace } = await toBuildPackageReady(project, lib, draft);
  const bp = await invokeStage(project, runId, "build-package", "build-package", buildPackageInputs(fetchWorkspace, packageWorkspace));
  if (bp.result.outcome !== "succeeded") throw new Error(`build-package failed: ${JSON.stringify(bp.result)}`);
  const receipt = JSON.parse(readFileSync(join(bp.workspaceDir, "output", "package-receipt.json"), "utf8")) as PackageReceipt;
  const snapshot = snapshotOutputs(bp.workspaceDir);
  await commitResult(project, runId, bp.claim, bp.workspaceDir, bp.result);
  return { runId, receipt, buildPackageWorkspace: snapshot };
}

describe("harness publish stage", () => {
  let world: LibraryWorld;
  let repoDir: string;

  beforeAll(() => {
    world = freshLibraryWorld({ media: false });
    repoDir = setupChannelRepo();
    addChannel(world.channel, repoDir);
  });

  describe("fetch", () => {
    it("succeeds for an approved, claimed item and copies files with matching checksums", async () => {
      const itemId = newId("library_item");
      const contentId = approvedContentId(world.channel, world.lib, itemId);
      const runId = planPublishRun(world.channel, contentId);

      const { result, workspaceDir } = await invokeStage(world.channel, runId, "fetch-library-item", "fetch", []);
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");

      const episodePath = join(workspaceDir, "output", "episode.mp4");
      expect(existsSync(episodePath)).toBe(true);
      const manifestItem = JSON.parse(readFileSync(join(world.lib, "items", itemId, "manifest.json"), "utf8")) as { files: { path: string; checksum: string }[] };
      const expectedChecksum = manifestItem.files.find((f) => f.path === "episode.mp4")!.checksum;
      expect((await sha256File(episodePath)).checksum).toBe(expectedChecksum);

      expect(existsSync(join(workspaceDir, "output", "thumbnails", "thumb1.png"))).toBe(true);
      const brief = JSON.parse(readFileSync(join(workspaceDir, "output", "brief.json"), "utf8")) as { item_id: string };
      expect(brief.item_id).toBe(itemId);

      const outputTypes = result.outputs.map((o) => o.type).sort();
      expect(outputTypes).toEqual(["episode_video", "library_brief", "thumbnail_set"]);
    });

    it("fails contract when the item was withdrawn after being picked", async () => {
      const itemId = newId("library_item");
      const contentId = approvedContentId(world.channel, world.lib, itemId);
      const w = cli(world.studio, ["library", "withdraw", itemId], SECRET_ENV);
      expect(w.code, w.err).toBe(0);

      const runId = planPublishRun(world.channel, contentId);
      const { result } = await invokeStage(world.channel, runId, "fetch-library-item", "fetch", []);
      expect(result.outcome).toBe("failed");
      expect(result.errors[0]?.kind).toBe("contract");
      expect(result.errors[0]?.message).toContain("withdrawn");
    });

    it("fails contract when the channel never claimed the item", async () => {
      const itemId = newId("library_item");
      const contentId = approvedContentId(world.channel, world.lib, itemId);
      const runId = planPublishRun(world.channel, contentId);

      const ctx = buildContext({ projectDir: world.channel });
      try {
        const content = ctx.store.getContentItem(contentId)!;
        ctx.store.updateContentItem({ ...content, library_channel_id: "c2" }); // c2 never picked this item -> no claim file
      } finally { ctx.close(); }

      const { result } = await invokeStage(world.channel, runId, "fetch-library-item", "fetch", []);
      expect(result.outcome).toBe("failed");
      expect(result.errors[0]?.kind).toBe("contract");
      expect(result.errors[0]?.message).toContain("claim");
    });
  });

  describe("build-package", () => {
    it("commits a package at episode 15 with a valid manifest and runs the overlay script", async () => {
      const { runId, fetchWorkspace, packageWorkspace } = await toBuildPackageReady(world.channel, world.lib, sampleDraft());
      const { result, workspaceDir } = await invokeStage(world.channel, runId, "build-package", "build-package", buildPackageInputs(fetchWorkspace, packageWorkspace));
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");

      const receipt = JSON.parse(readFileSync(join(workspaceDir, "output", "package-receipt.json"), "utf8")) as PackageReceipt;
      expect(receipt.episode_no).toBe(15);

      const episodeDir = receipt.episode_dir;
      expect(existsSync(join(episodeDir, "full-episode", "episode-15-full-episode.mp4"))).toBe(true);
      expect(existsSync(join(episodeDir, ".harness-package-id"))).toBe(true);

      const manifestPath = join(episodeDir, receipt.manifest_path);
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { videoPath: string; thumbnailPath: string; title: string };
      expect(manifest.videoPath).not.toContain("\\");
      expect(manifest.videoPath.startsWith("/") || /^[A-Za-z]:\//.test(manifest.videoPath)).toBe(true);
      expect(manifest.title).toBe("Episode Title");

      const argsPath = join(episodeDir, "thumbnails", "opt1.png.args.json");
      expect(existsSync(argsPath)).toBe(true);
      const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
      expect(args).toContain("--line1");
      expect(args).toContain("Big Reveal");
    });

    it("rerunning the same run stays on the same package (no new episode number)", async () => {
      const { runId, fetchWorkspace, packageWorkspace } = await toBuildPackageReady(world.channel, world.lib, sampleDraft());
      const inputs = buildPackageInputs(fetchWorkspace, packageWorkspace);
      const first = await invokeStage(world.channel, runId, "build-package", "build-package", inputs);
      expect(first.result.outcome, JSON.stringify(first.result)).toBe("succeeded");
      const receipt1 = JSON.parse(readFileSync(join(first.workspaceDir, "output", "package-receipt.json"), "utf8")) as PackageReceipt;

      const second = await invokeStage(world.channel, runId, "build-package", "build-package", inputs, {}, first.claim);
      expect(second.result.outcome, JSON.stringify(second.result)).toBe("succeeded");
      const receipt2 = JSON.parse(readFileSync(join(second.workspaceDir, "output", "package-receipt.json"), "utf8")) as PackageReceipt;

      expect(receipt2.package_id).toBe(receipt1.package_id);
      expect(receipt2.episode_no).toBe(receipt1.episode_no);
    });

    it("fails contract when the episode directory exists but was not created by this package", async () => {
      const { runId, fetchWorkspace, packageWorkspace } = await toBuildPackageReady(world.channel, world.lib, sampleDraft());
      const inputs = buildPackageInputs(fetchWorkspace, packageWorkspace);
      const first = await invokeStage(world.channel, runId, "build-package", "build-package", inputs);
      expect(first.result.outcome, JSON.stringify(first.result)).toBe("succeeded");
      const receipt = JSON.parse(readFileSync(join(first.workspaceDir, "output", "package-receipt.json"), "utf8")) as PackageReceipt;
      writeFileSync(join(receipt.episode_dir, ".harness-package-id"), "pkg_someoneElseEntirelyXXXXXXXXXXXX");

      const second = await invokeStage(world.channel, runId, "build-package", "build-package", inputs, {}, first.claim);
      expect(second.result.outcome).toBe("failed");
      expect(second.result.errors[0]?.kind).toBe("contract");
      expect(second.result.errors[0]?.message).toContain("already exists");
    });
  });

  describe("upload", () => {
    it("ok: succeeds, job PROCESSING, operation CONFIRMED with the video id as provider_ref", async () => {
      const { runId, receipt, buildPackageWorkspace } = await toReadyJob(world.channel, world.lib, sampleDraft());
      const up = await invokeStage(world.channel, runId, "upload", "upload", [
        { type: "channel_package", relPath: "input/package-receipt/package-receipt.json", src: join(buildPackageWorkspace, "output", "package-receipt.json") },
      ], { FAKE_UPLOAD_MODE: "ok" });
      expect(up.result.outcome, JSON.stringify(up.result)).toBe("succeeded");
      const uploadReceipt = JSON.parse(readFileSync(join(up.workspaceDir, "output", "upload-receipt.json"), "utf8")) as UploadReceipt;
      expect(uploadReceipt.state).toBe("PROCESSING");
      expect(uploadReceipt.video_id).toMatch(/^fk/);

      const ctx = buildContext({ projectDir: world.channel });
      try {
        const job = ctx.store.getPublicationJob(receipt.publication_job_id)!;
        expect(job.state).toBe("PROCESSING");
        expect(job.youtube_video_id).toBe(uploadReceipt.video_id);
        const op = ctx.store.getExternalOperation(job.operation_id!)!;
        expect(op.status).toBe("CONFIRMED");
        expect(op.provider_ref).toBe(uploadReceipt.video_id);

        // the operation must pass through DISPATCHED *before* the (up to 45-minute) publisher call returns,
        // so a crash mid-upload leaves something a reconciler can act on rather than a stuck INTENT_RECORDED.
        const events = ctx.store.listEvents({ run_id: runId, limit: 500 }).filter((e) => e.payload.operation_id === job.operation_id);
        const dispatchedIdx = events.findIndex((e) => e.event_type === "external_operation.dispatched");
        const confirmedIdx = events.findIndex((e) => e.event_type === "external_operation.confirmed");
        expect(dispatchedIdx, JSON.stringify(events.map((e) => e.event_type))).toBeGreaterThanOrEqual(0);
        expect(confirmedIdx).toBeGreaterThan(dispatchedIdx);
      } finally { ctx.close(); }
    });

    it("recovers a job a crashed attempt left UPLOADING: unknown outcome, job and operation NEEDS_RECONCILIATION", async () => {
      const { runId, receipt, buildPackageWorkspace } = await toReadyJob(world.channel, world.lib, sampleDraft());

      // Simulate a process dying between "recordIntent" and the publisher call returning: the durable state
      // the real upload stage leaves at that point is job=UPLOADING with its operation already DISPATCHED
      // (never INTENT_RECORDED alone, precisely because the stage dispatches before calling the publisher).
      {
        const ctx = buildContext({ projectDir: world.channel });
        try {
          const job = ctx.store.getPublicationJob(receipt.publication_job_id)!;
          const run = ctx.store.getRun(runId)!;
          const intent = ctx.journal.recordIntent({
            request: { run_id: runId, stage_run_id: newId("stage_run"), attempt_id: newId("attempt") },
            provider: ctx.publisher.name, kind: "youtube-upload", target: job.channel_id, payload: { idempotency_key: job.idempotency_key },
          });
          ctx.store.transition("external_operation", intent.operation_id, "INTENT_RECORDED", "DISPATCHED", eventFor(run, null, null, "external_operation.dispatched", "info", { operation_id: intent.operation_id }));
          ctx.store.updatePublicationJob({ ...job, operation_id: intent.operation_id });
          transitionPublication(ctx.store, job.publication_job_id, "READY", "UPLOADING");
        } finally { ctx.close(); }
      }

      // FAKE_UPLOAD_MODE=refused as a canary: if the recovery branch failed to short-circuit and fell through
      // to a real publisher call, the outcome below would be a "contract" failure instead of "unknown".
      const up = await invokeStage(world.channel, runId, "upload", "upload", [
        { type: "channel_package", relPath: "input/package-receipt/package-receipt.json", src: join(buildPackageWorkspace, "output", "package-receipt.json") },
      ], { FAKE_UPLOAD_MODE: "refused" });
      expect(up.result.outcome, JSON.stringify(up.result)).toBe("unknown");

      const ctx = buildContext({ projectDir: world.channel });
      try {
        const job = ctx.store.getPublicationJob(receipt.publication_job_id)!;
        expect(job.state).toBe("NEEDS_RECONCILIATION");
        const op = ctx.store.getExternalOperation(job.operation_id!)!;
        expect(op.status).toBe("NEEDS_RECONCILIATION");
      } finally { ctx.close(); }
    });

    it("lost: unknown outcome, job NEEDS_RECONCILIATION, operation NEEDS_RECONCILIATION", async () => {
      const { runId, receipt, buildPackageWorkspace } = await toReadyJob(world.channel, world.lib, sampleDraft());
      const up = await invokeStage(world.channel, runId, "upload", "upload", [
        { type: "channel_package", relPath: "input/package-receipt/package-receipt.json", src: join(buildPackageWorkspace, "output", "package-receipt.json") },
      ], { FAKE_UPLOAD_MODE: "lost" });
      expect(up.result.outcome, JSON.stringify(up.result)).toBe("unknown");

      const ctx = buildContext({ projectDir: world.channel });
      try {
        const job = ctx.store.getPublicationJob(receipt.publication_job_id)!;
        expect(job.state).toBe("NEEDS_RECONCILIATION");
        const op = ctx.store.getExternalOperation(job.operation_id!)!;
        expect(op.status).toBe("NEEDS_RECONCILIATION");
      } finally { ctx.close(); }
    });

    it("refused: contract failure, job back to READY, operation FAILED", async () => {
      const { runId, receipt, buildPackageWorkspace } = await toReadyJob(world.channel, world.lib, sampleDraft());
      const up = await invokeStage(world.channel, runId, "upload", "upload", [
        { type: "channel_package", relPath: "input/package-receipt/package-receipt.json", src: join(buildPackageWorkspace, "output", "package-receipt.json") },
      ], { FAKE_UPLOAD_MODE: "refused" });
      expect(up.result.outcome).toBe("failed");
      expect(up.result.errors[0]?.kind).toBe("contract");

      const ctx = buildContext({ projectDir: world.channel });
      try {
        const job = ctx.store.getPublicationJob(receipt.publication_job_id)!;
        expect(job.state).toBe("READY");
        const op = ctx.store.getExternalOperation(job.operation_id!)!;
        expect(op.status).toBe("FAILED");
      } finally { ctx.close(); }
    });

    it("busy: transient failure, job back to READY", async () => {
      const { runId, receipt, buildPackageWorkspace } = await toReadyJob(world.channel, world.lib, sampleDraft());
      const up = await invokeStage(world.channel, runId, "upload", "upload", [
        { type: "channel_package", relPath: "input/package-receipt/package-receipt.json", src: join(buildPackageWorkspace, "output", "package-receipt.json") },
      ], { FAKE_UPLOAD_MODE: "busy" });
      expect(up.result.outcome).toBe("failed");
      expect(up.result.errors[0]?.kind).toBe("transient");

      const ctx = buildContext({ projectDir: world.channel });
      try {
        const job = ctx.store.getPublicationJob(receipt.publication_job_id)!;
        expect(job.state).toBe("READY");
      } finally { ctx.close(); }
    });
  });

  describe("schedule", () => {
    /** Runs the pipeline through a successful upload (committing every stage along the way) so `schedule`'s
     * own stage_run is READY, and returns the upload workspace `schedule` reads its input from. */
    async function toScheduleReady(): Promise<{ runId: string; uploadWorkspace: string }> {
      const { runId, buildPackageWorkspace } = await toReadyJob(world.channel, world.lib, sampleDraft());
      const up = await invokeStage(world.channel, runId, "upload", "upload", [
        { type: "channel_package", relPath: "input/package-receipt/package-receipt.json", src: join(buildPackageWorkspace, "output", "package-receipt.json") },
      ], { FAKE_UPLOAD_MODE: "ok" });
      expect(up.result.outcome, JSON.stringify(up.result)).toBe("succeeded");
      const snapshot = snapshotOutputs(up.workspaceDir);
      await commitResult(world.channel, runId, up.claim, up.workspaceDir, up.result);
      return { runId, uploadWorkspace: snapshot };
    }

    it("ok: schedules at nextSlot, and the fake script records the slot", async () => {
      const { runId, uploadWorkspace } = await toScheduleReady();
      const sc = await invokeStage(world.channel, runId, "schedule", "schedule", [
        { type: "upload_receipt", relPath: "input/upload-receipt/upload-receipt.json", src: join(uploadWorkspace, "output", "upload-receipt.json") },
      ], { FAKE_SCHEDULE_MODE: "ok" });
      expect(sc.result.outcome, JSON.stringify(sc.result)).toBe("succeeded");
      const scheduleReceipt = JSON.parse(readFileSync(join(sc.workspaceDir, "output", "schedule-receipt.json"), "utf8")) as { scheduled_at: string; video_id: string };
      expect(scheduleReceipt.scheduled_at).toBeTruthy();

      const schedulesFile = join(repoDir, "outputs", "project-01", "schedules", `${scheduleReceipt.video_id}.json`);
      expect(existsSync(schedulesFile)).toBe(true);
      const onDisk = JSON.parse(readFileSync(schedulesFile, "utf8")) as { at: string };
      expect(onDisk.at).toBe(scheduleReceipt.scheduled_at);
    });

    it("idempotent rerun after SCHEDULED returns the same slot without calling the publisher again", async () => {
      const { runId, uploadWorkspace } = await toScheduleReady();
      const inputs = [
        { type: "upload_receipt", relPath: "input/upload-receipt/upload-receipt.json", src: join(uploadWorkspace, "output", "upload-receipt.json") },
      ];
      const first = await invokeStage(world.channel, runId, "schedule", "schedule", inputs, { FAKE_SCHEDULE_MODE: "ok" });
      expect(first.result.outcome, JSON.stringify(first.result)).toBe("succeeded");
      const receipt1 = JSON.parse(readFileSync(join(first.workspaceDir, "output", "schedule-receipt.json"), "utf8")) as { scheduled_at: string };

      // a second call would refuse if the publisher were invoked again -- proves the idempotent short-circuit
      const second = await invokeStage(world.channel, runId, "schedule", "schedule", inputs, { FAKE_SCHEDULE_MODE: "refused" }, first.claim);
      expect(second.result.outcome, JSON.stringify(second.result)).toBe("succeeded");
      const receipt2 = JSON.parse(readFileSync(join(second.workspaceDir, "output", "schedule-receipt.json"), "utf8")) as { scheduled_at: string };
      expect(receipt2.scheduled_at).toBe(receipt1.scheduled_at);
    });
  });
});
