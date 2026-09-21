import { createHash } from "node:crypto";
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { newId, type ChannelBrief, type ClaimResult, type Demand, type RequestsReceipt, type StageInput, type StageResult, type TopicProposal } from "@harness/contracts";
import { HARNESS_ROOT, buildStageRequest, canonicalDigest, eventFor, mimeTypesFor, sha256File, stageDefinitionDigest, stageDefinitionFor } from "@harness/core";
import { buildContext, type AppContext } from "../src/composition.js";
import { cli, freshLibraryWorld, librarySync, writeActiveStyle, type LibraryWorld } from "../../../tests/integration/library-helpers.js";

// Task 5: `harness publish stage channel-brief|demand|create-requests` (spec §4.2), driven the same way
// `publish-stage.test.ts` drives the SP3 built-in stages -- a real run/content, a real `store.claim()`, a
// hand-built `stage-request.json`, a spawned `harness publish stage <name>` subprocess. `propose-topics` (an
// agent stage) is faked by writing its expected `topic_proposal` output by hand and committing it, exactly
// like `publish-stage.test.ts` fakes the `package` stage: `FakeAgentRuntime` writes generic notes, and driving
// the real `channel-plan` skill needs a real agent CLI.

const LEGACY_REPO_FIXTURE = join(HARNESS_ROOT, "fixtures", "legacy-channel-repo");
const CHANNEL_ID = "c1";
const SECRET_ENV = { HARNESS_SECRET_YOUTUBE_C1_EMAIL: "owner@example.com" };

function sha256Hex(buf: Buffer | string): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

function setupChannelRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "legacy-repo-"));
  cpSync(LEGACY_REPO_FIXTURE, dir, { recursive: true });
  return dir;
}

/** Adds `channels/c1/channel.yaml` with `planning.lookahead_slots: 2` -- with nothing else covering the
 * channel's publish slots, `channelDemand` computes `needed: 2` deterministically, matching the brief's own
 * worked example ("demand.needed 2"). `voiceId`, when given, sets `voice: { voice_id }` (sub-project 5A Task
 * 4 fix round 1: the channel's own configured TTS voice `create-requests` resolves a "tts" topic against). */
function addChannel(project: string, repoDir: string, voiceId?: string): void {
  const cfgPath = join(project, "project.yaml");
  const cfg = parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  cfg.adapters = { publisher: "playwright", agent: "fake" };
  cfg.resources = { browser: 5 };
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
    episode: { start: 1, dir_pattern: "episode-{nn}" },
    overlay: { enabled: true, side: "right" },
    seo: { niche: "chợ nổi miền Tây", audience: "khán giả trẻ thích du lịch", language: "vi" },
    planning: { enabled: true, lookahead_slots: 2, topics_per_run: 3, max_open_requests: 3, check_seconds: 3600 },
    ...(voiceId ? { voice: { voice_id: voiceId } } : {}),
  };
  writeFileSync(join(channelDir, "channel.yaml"), stringify(channelYaml));
}

/** Seeds a schema-valid `VoiceProfile` straight into a project's own local store mirror -- standing in for a
 * real `library voices add` (which needs ffmpeg) the same way this file fakes `propose-topics` instead of
 * running a real agent. `status` lets a test exercise the "configured but retired" case. */
function seedVoiceProfile(project: string, status: "active" | "retired" = "active"): string {
  const voiceId = newId("voice_profile");
  const ctx = buildContext({ projectDir: project });
  try {
    ctx.store.upsertVoiceProfile({
      schema_version: "harness.voice/v1", voice_id: voiceId, display_name: "Narrator", language: "vi",
      origin: "own", origin_note: "", ref_audio: { path: "ref.wav", checksum: "sha256:" + "a".repeat(64), duration_seconds: 5 },
      ref_text: "hi", params: { speed: 1, num_step: 32 }, revision: 1, status,
      created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
    });
  } finally {
    ctx.close();
  }
  return voiceId;
}

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

function approvedContentId(project: string, lib: string, itemId: string): string {
  writeApprovedItem(lib, itemId);
  librarySync(project);
  const r = cli(project, ["library", "pick", itemId, "--channel", CHANNEL_ID, "--json"], SECRET_ENV);
  if (r.code !== 0) throw new Error(`library pick failed: ${r.err}\n${r.out}`);
  return (JSON.parse(r.out) as { content_id: string }).content_id;
}

/** Content for a `channel-planning` run: no `library_item_id`, only `library_channel_id` -- exactly what
 * `planRequestsRun` (packages/core/src/learning/planning.ts) creates via `catalog.createContent`. */
function createPlanningContent(project: string, title: string): string {
  const ctx = buildContext({ projectDir: project });
  try {
    const c = ctx.catalog.createContent({ source_ids: [], title, library_channel_id: CHANNEL_ID });
    return c.content_id;
  } finally { ctx.close(); }
}

function planRun(project: string, workflow: string, profile: string, contentId: string): string {
  const p = cli(project, ["plan", "--workflow", workflow, "--profile", profile, "--content", contentId, "--json"], SECRET_ENV);
  if (p.code !== 0) throw new Error(`plan failed: ${p.err}\n${p.out}`);
  const runId = (JSON.parse(p.out) as { run_id: string }).run_id;
  const e = cli(project, ["enqueue", runId], SECRET_ENV);
  if (e.code !== 0) throw new Error(`enqueue failed: ${e.err}\n${e.out}`);
  return runId;
}

/** Mirrors `publish-stage.test.ts`'s own `claimStage`: claims a stage_run by key and moves attempt/stage_run
 * CLAIMED -> RUNNING, since `Controller.commit` expects both already RUNNING. */
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

/** `Controller.commit` moves each declared output out of the workspace into the artifact store, so a
 * workspace's `output/` is empty after a successful commit -- snapshot first. */
function snapshotOutputs(workspaceDir: string): string {
  const snapshot = mkdtempSync(join(tmpdir(), "snap-"));
  cpSync(join(workspaceDir, "output"), join(snapshot, "output"), { recursive: true });
  return snapshot;
}

function fakeInput(type: string, path: string, kind: "file" | "directory"): StageInput {
  return { artifact_id: newId("artifact"), checksum: "sha256:" + "0".repeat(64), path, type, kind };
}

interface InputSpec { type: string; relPath: string; kind?: "file" | "directory"; src: string }

async function invokeStage(project: string, runId: string, stageKey: string, cliName: string, inputSpecs: InputSpec[], envExtra: Record<string, string> = {}, claimOverride?: ClaimResult): Promise<{ result: StageResult; workspaceDir: string; claim: ClaimResult; stdout: string; stderr: string }> {
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

/** Runs a real script stage and commits it in one step, returning a snapshot of its `output/`. */
async function runAndCommit(project: string, runId: string, stageKey: string, cliName: string, inputSpecs: InputSpec[] = []): Promise<{ workspaceSnapshot: string; result: StageResult }> {
  const r = await invokeStage(project, runId, stageKey, cliName, inputSpecs);
  if (r.result.outcome !== "succeeded") throw new Error(`${stageKey} failed: ${JSON.stringify(r.result)}`);
  const snapshot = snapshotOutputs(r.workspaceDir);
  await commitResult(project, runId, r.claim, r.workspaceDir, r.result);
  return { workspaceSnapshot: snapshot, result: r.result };
}

/** Fakes the `propose-topics` agent stage (see file header): claims for real, writes `topics.json` by hand,
 * commits a hand-built `StageResult` instead of running any executor. */
async function fabricateProposeTopics(project: string, runId: string, proposal: TopicProposal): Promise<{ workspaceSnapshot: string }> {
  let claim: ClaimResult;
  {
    const ctx = buildContext({ projectDir: project });
    try { claim = claimStage(ctx, runId, "propose-topics"); } finally { ctx.close(); }
  }
  const workspaceDir = mkdtempSync(join(tmpdir(), "ws-propose-topics-"));
  const outPath = join(workspaceDir, "output", "topics.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(proposal, null, 2));
  const { checksum, size_bytes } = await sha256File(outPath);
  const result: StageResult = {
    schema_version: "harness.stage-result/v1", attempt_id: claim.attempt.attempt_id, outcome: "succeeded",
    outputs: [{ path: "output/topics.json", type: "topic_proposal", checksum, size_bytes, kind: "file" }],
    checks: [], usage: { wall_seconds: 0.1, cost_usd: 0 }, external_operations: [], errors: [],
  };
  const snapshot = snapshotOutputs(workspaceDir);
  await commitResult(project, runId, claim, workspaceDir, result);
  return { workspaceSnapshot: snapshot };
}

const SAMPLE_PROPOSAL = (): TopicProposal => ({
  schema_version: "harness.topic-proposal/v1",
  topics: [
    { topic: "Khám phá chợ nổi Cái Răng lúc bình minh", angle: "góc quay flycam", why: "recent_metrics tập gần nhất đạt views cao với mở đầu flycam" },
    { topic: "Ẩm thực đường phố miền Tây mùa nước nổi", angle: "trải nghiệm ăn uống", why: "giả thuyết hyp cũ supported hướng ẩm thực" },
    { topic: "Một ngày làm thương lái trên sông Hậu", angle: "theo chân nhân vật", why: "video cùng ngách tìm được trên web đang lên xu hướng" },
  ],
});

/** 5 distinct topics -- for the `room`/`topics_per_run` capping tests, which need more candidates than
 * `SAMPLE_PROPOSAL()`'s 3. */
const SAMPLE_PROPOSAL_5 = (): TopicProposal => ({
  schema_version: "harness.topic-proposal/v1",
  topics: [
    { topic: "Khám phá chợ nổi Cái Răng lúc bình minh", angle: "góc quay flycam", why: "recent_metrics tập gần nhất đạt views cao với mở đầu flycam" },
    { topic: "Ẩm thực đường phố miền Tây mùa nước nổi", angle: "trải nghiệm ăn uống", why: "giả thuyết hyp cũ supported hướng ẩm thực" },
    { topic: "Một ngày làm thương lái trên sông Hậu", angle: "theo chân nhân vật", why: "video cùng ngách tìm được trên web đang lên xu hướng" },
    { topic: "Nghề đóng ghe truyền thống ở Cần Thơ", angle: "làng nghề", why: "chưa có tập nào khai thác nghề thủ công" },
    { topic: "Trẻ em miền Tây đi học bằng xuồng mỗi ngày", angle: "góc nhìn đời thường", why: "video cùng ngách tìm được trên web đang lên xu hướng" },
  ],
});

/** One "tts" topic and one "none" topic -- for the voice-downgrade tests (sub-project 5A Task 4 fix round 1,
 * Important #2): `create-requests` must never fail the stage for a proposed "tts" topic when the channel has
 * no active voice to resolve it against, and must leave a topic that never asked for "tts" untouched. */
const TTS_MIX_PROPOSAL = (): TopicProposal => ({
  schema_version: "harness.topic-proposal/v1",
  topics: [
    { topic: "Giọng đọc tự động cho tập chợ nổi buổi sáng", angle: "tường thuật", why: "kênh muốn thử giọng đọc tự động mới", voice: "tts" },
    { topic: "Một ngày quan sát không cần tường thuật gì cả", angle: "quan sát", why: "tập này không cần giọng đọc nào hết", voice: "none" },
  ],
});

/** Standalone (not scoped to any one `world`) equivalent of the `create-requests` describe block's own
 * `writeDemandFixture`, for the voice-downgrade tests below, which each need their own isolated channel
 * project. */
function writeDemandJson(d: Partial<Demand>): string {
  const dir = mkdtempSync(join(tmpdir(), "demand-fixture-"));
  const demand: Demand = {
    schema_version: "harness.demand/v1", channel_id: CHANNEL_ID, needed: 0, slots: [],
    covered: { jobs: 0, runs: 0, items: 0, requests: 0 }, open_requests: 0, max_open_requests: 3, topics_per_run: 3,
    ...d,
  };
  mkdirSync(join(dir, "output"), { recursive: true });
  writeFileSync(join(dir, "output", "demand.json"), JSON.stringify(demand, null, 2));
  return dir;
}

describe("harness publish stage: channel-brief / demand / create-requests", () => {
  let world: LibraryWorld;
  let repoDir: string;
  let styleId: string;

  beforeAll(() => {
    world = freshLibraryWorld({ media: false });
    repoDir = setupChannelRepo();
    addChannel(world.channel, repoDir);
    styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    librarySync(world.channel);
  });

  describe("channel-brief", () => {
    // Its own isolated world: a `channel-publish` run left non-terminal (this test never drives it past
    // `channel-brief`) would otherwise count as an "active channel-publish run" and shift every later
    // `demand`/`create-requests` test's `needed` -- see `channelWorkflowRuns`/`activeChannelPublishRuns` in
    // packages/core/src/learning/planning.ts.
    it("channel-publish@1.1.0: after fetch-library-item, item is the picked kho item, seo is present, no secret leaks", async () => {
      const pubWorld = freshLibraryWorld({ media: false });
      const pubRepoDir = setupChannelRepo();
      addChannel(pubWorld.channel, pubRepoDir);

      const itemId = newId("library_item");
      const contentId = approvedContentId(pubWorld.channel, pubWorld.lib, itemId);
      const runId = planRun(pubWorld.channel, "channel-publish@1.1.0", "channel", contentId);

      await runAndCommit(pubWorld.channel, runId, "fetch-library-item", "fetch");
      const { result, workspaceDir } = await invokeStage(pubWorld.channel, runId, "channel-brief", "channel-brief", []);
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");

      const raw = readFileSync(join(workspaceDir, "output", "channel-brief.json"), "utf8");
      expect(raw).not.toContain("secret://");
      const brief = JSON.parse(raw) as ChannelBrief;
      expect(brief.item?.item_id).toBe(itemId);
      expect(brief.channel.channel_id).toBe(CHANNEL_ID);
      expect(brief.channel.seo.niche).toBe("chợ nổi miền Tây");
    });

    it("channel-planning: content has no library_item_id, item is null", async () => {
      const contentId = createPlanningContent(world.channel, "planning c1 brief-null-item");
      const runId = planRun(world.channel, "channel-planning@1.0.0", "channel-planning", contentId);
      const { result, workspaceDir } = await invokeStage(world.channel, runId, "channel-brief", "channel-brief", []);
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
      const brief = JSON.parse(readFileSync(join(workspaceDir, "output", "channel-brief.json"), "utf8")) as ChannelBrief;
      expect(brief.item).toBeNull();
    });
  });

  describe("demand", () => {
    it("needed reflects lookahead_slots with nothing else covering the channel's schedule", async () => {
      const contentId = createPlanningContent(world.channel, "planning c1 demand-needed");
      const runId = planRun(world.channel, "channel-planning@1.0.0", "channel-planning", contentId);
      const { result, workspaceDir } = await invokeStage(world.channel, runId, "demand", "demand", []);
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
      const demand = JSON.parse(readFileSync(join(workspaceDir, "output", "demand.json"), "utf8")) as Demand;
      expect(demand.channel_id).toBe(CHANNEL_ID);
      expect(demand.needed).toBe(2);
    });
  });

  describe("create-requests", () => {
    async function toCreateRequestsReady(title: string, proposal: TopicProposal = SAMPLE_PROPOSAL()): Promise<{ runId: string; briefSnap: string; demandSnap: string; topicsSnap: string }> {
      const contentId = createPlanningContent(world.channel, title);
      const runId = planRun(world.channel, "channel-planning@1.0.0", "channel-planning", contentId);
      const brief = await runAndCommit(world.channel, runId, "channel-brief", "channel-brief");
      const demand = await runAndCommit(world.channel, runId, "demand", "demand");
      const propose = await fabricateProposeTopics(world.channel, runId, proposal);
      return { runId, briefSnap: brief.workspaceSnapshot, demandSnap: demand.workspaceSnapshot, topicsSnap: propose.workspaceSnapshot };
    }

    /** Writes a hand-built `demand.json` (the stage only reads the `demand` input file, so this is a
     * deterministic way to exercise a specific `needed`/`max_open_requests`/`open_requests`/`topics_per_run`
     * combination without reconstructing that exact channel state for real). */
    function writeDemandFixture(d: Partial<Demand>): string {
      const dir = mkdtempSync(join(tmpdir(), "demand-fixture-"));
      const demand: Demand = {
        schema_version: "harness.demand/v1", channel_id: CHANNEL_ID, needed: 0, slots: [],
        covered: { jobs: 0, runs: 0, items: 0, requests: 0 }, open_requests: 0, max_open_requests: 3, topics_per_run: 3,
        ...d,
      };
      mkdirSync(join(dir, "output"), { recursive: true });
      writeFileSync(join(dir, "output", "demand.json"), JSON.stringify(demand, null, 2));
      return dir;
    }

    function createRequestsInputs(briefSnap: string, demandSnap: string, topicsSnap: string): InputSpec[] {
      return [
        { type: "topic_proposal", relPath: "input/topics/topics.json", src: join(topicsSnap, "output", "topics.json") },
        { type: "demand", relPath: "input/demand/demand.json", src: join(demandSnap, "output", "demand.json") },
        { type: "channel_brief", relPath: "input/channel-brief/channel-brief.json", src: join(briefSnap, "output", "channel-brief.json") },
      ];
    }

    it("3 proposed topics + demand.needed 2 -> 2 requests in the kho, notes carry the run id; a rerun creates no more", async () => {
      const { runId, briefSnap, demandSnap, topicsSnap } = await toCreateRequestsReady("planning c1 create-requests");
      const inputs = createRequestsInputs(briefSnap, demandSnap, topicsSnap);

      const first = await invokeStage(world.channel, runId, "create-requests", "create-requests", inputs);
      expect(first.result.outcome, JSON.stringify(first.result)).toBe("succeeded");
      const receipt1 = JSON.parse(readFileSync(join(first.workspaceDir, "output", "requests-receipt.json"), "utf8")) as RequestsReceipt;
      expect(receipt1.request_ids).toHaveLength(2);

      const ctx = buildContext({ projectDir: world.channel });
      try {
        for (const id of receipt1.request_ids) {
          const req = ctx.store.getContentRequest(id)!;
          expect(req.notes).toContain(runId);
          expect(req.requested_by.channel_id).toBe(CHANNEL_ID);
        }
        const countBefore = ctx.store.listContentRequests({}).length;
        // rerun on the same claim: idempotent, no new requests
        const second = await invokeStage(world.channel, runId, "create-requests", "create-requests", inputs, {}, first.claim);
        expect(second.result.outcome, JSON.stringify(second.result)).toBe("succeeded");
        const receipt2 = JSON.parse(readFileSync(join(second.workspaceDir, "output", "requests-receipt.json"), "utf8")) as RequestsReceipt;
        expect([...receipt2.request_ids].sort()).toEqual([...receipt1.request_ids].sort());
        expect(ctx.store.listContentRequests({}).length).toBe(countBefore);
      } finally { ctx.close(); }
    });

    it("demand.needed 0 -> empty receipt, still succeeds", async () => {
      // A channel-planning content whose demand is fully covered: plan twice for the same title so the second
      // run's content shares nothing, but reuse toCreateRequestsReady's `demand` stage against a channel whose
      // lookahead is already covered by requests created in the previous test -- simplest deterministic way is
      // to hand-write a demand.json with needed: 0 directly (this stage only reads the `demand` input file).
      const { runId, briefSnap, topicsSnap } = await toCreateRequestsReady("planning c1 zero-needed");
      const zeroDemandDir = writeDemandFixture({ needed: 0 });

      const inputs = createRequestsInputs(briefSnap, zeroDemandDir, topicsSnap);
      const { result, workspaceDir } = await invokeStage(world.channel, runId, "create-requests", "create-requests", inputs);
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
      const receipt = JSON.parse(readFileSync(join(workspaceDir, "output", "requests-receipt.json"), "utf8")) as RequestsReceipt;
      expect(receipt.request_ids).toEqual([]);
    });

    it("demand.needed 5, max_open_requests 3, open_requests 2, 5 proposed topics -> exactly 1 request created (room, not needed, is the binding limit)", async () => {
      const { runId, briefSnap, topicsSnap } = await toCreateRequestsReady("planning c1 room-capped", SAMPLE_PROPOSAL_5());
      // room = max_open_requests(3) - open_requests(2) = 1; cap = min(needed=5, room=1, topics_per_run=3) = 1
      const demandDir = writeDemandFixture({ needed: 5, max_open_requests: 3, open_requests: 2, topics_per_run: 3 });

      const inputs = createRequestsInputs(briefSnap, demandDir, topicsSnap);
      const { result, workspaceDir } = await invokeStage(world.channel, runId, "create-requests", "create-requests", inputs);
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
      const receipt = JSON.parse(readFileSync(join(workspaceDir, "output", "requests-receipt.json"), "utf8")) as RequestsReceipt;
      expect(receipt.request_ids).toHaveLength(1);
    });

    it("demand.needed 5, room plenty, topics_per_run 2, 5 proposed topics -> exactly 2 requests created (topics_per_run is the binding limit)", async () => {
      const { runId, briefSnap, topicsSnap } = await toCreateRequestsReady("planning c1 topics-per-run-capped", SAMPLE_PROPOSAL_5());
      // room = max_open_requests(10) - open_requests(0) = 10; cap = min(needed=5, room=10, topics_per_run=2) = 2
      const demandDir = writeDemandFixture({ needed: 5, max_open_requests: 10, open_requests: 0, topics_per_run: 2 });

      const inputs = createRequestsInputs(briefSnap, demandDir, topicsSnap);
      const { result, workspaceDir } = await invokeStage(world.channel, runId, "create-requests", "create-requests", inputs);
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
      const receipt = JSON.parse(readFileSync(join(workspaceDir, "output", "requests-receipt.json"), "utf8")) as RequestsReceipt;
      expect(receipt.request_ids).toHaveLength(2);
    });

    // Sub-project 5A Task 4 fix round 1, Important #2: `world.channel` has no `voice:` block (the default --
    // see `beforeAll` above), so a proposed "tts" topic must downgrade instead of failing the whole stage.
    it("a \"tts\" topic on a channel with no configured voice downgrades to \"none\" instead of failing the stage", async () => {
      const { runId, briefSnap, topicsSnap } = await toCreateRequestsReady("planning c1 voice-no-channel-voice", TTS_MIX_PROPOSAL());
      const demandDir = writeDemandFixture({ needed: 2, max_open_requests: 10, open_requests: 0, topics_per_run: 5 });

      const inputs = createRequestsInputs(briefSnap, demandDir, topicsSnap);
      const { result, workspaceDir } = await invokeStage(world.channel, runId, "create-requests", "create-requests", inputs);
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
      const receipt = JSON.parse(readFileSync(join(workspaceDir, "output", "requests-receipt.json"), "utf8")) as RequestsReceipt;
      expect(receipt.request_ids).toHaveLength(2);
      expect(receipt.downgraded_voice).toHaveLength(1);

      const ctx = buildContext({ projectDir: world.channel });
      try {
        const downgradedId = receipt.downgraded_voice![0]!;
        const downgraded = ctx.store.getContentRequest(downgradedId)!;
        expect(downgraded.voice).toBe("none");
        expect(downgraded.voice_id).toBeUndefined();
        expect(downgraded.notes).toContain("voice: tts→none");
        expect(downgraded.topic).toContain("Giọng đọc tự động");

        const untouchedId = receipt.request_ids.find((id) => id !== downgradedId)!;
        const untouched = ctx.store.getContentRequest(untouchedId)!;
        expect(untouched.voice).toBe("none");
        expect(untouched.notes).not.toContain("voice: tts→none");
      } finally { ctx.close(); }
    });
  });

  describe("create-requests: voice downgrade with a configured channel voice (sub-project 5A Task 4 fix round 1)", () => {
    it("an active channel voice: the \"tts\" topic's request carries voice: tts and the channel's voice_id, no downgrade", async () => {
      const voiceWorld = freshLibraryWorld({ media: false });
      const voiceRepoDir = setupChannelRepo();
      const voiceId = seedVoiceProfile(voiceWorld.channel, "active");
      addChannel(voiceWorld.channel, voiceRepoDir, voiceId);
      const voiceStyleId = newId("edit_style");
      writeActiveStyle(voiceWorld.lib, voiceStyleId);
      librarySync(voiceWorld.channel);

      const contentId = createPlanningContent(voiceWorld.channel, "planning c1 voice-active");
      const runId = planRun(voiceWorld.channel, "channel-planning@1.0.0", "channel-planning", contentId);
      const brief = await runAndCommit(voiceWorld.channel, runId, "channel-brief", "channel-brief");
      // The real `demand` stage still has to run and commit (it's a `depends_on` of create-requests, and this
      // harness has no planner/worker loop driving stages to READY on its own) -- only the *content* fed to
      // create-requests as its `demand` input is swapped for a deterministic fixture, same trick the
      // "demand.needed 0"/"room-capped"/"topics-per-run-capped" tests above use via `writeDemandFixture`.
      await runAndCommit(voiceWorld.channel, runId, "demand", "demand");
      const demandDir = writeDemandJson({ needed: 2, max_open_requests: 10, open_requests: 0, topics_per_run: 5 });
      const propose = await fabricateProposeTopics(voiceWorld.channel, runId, TTS_MIX_PROPOSAL());

      const inputs = [
        { type: "topic_proposal", relPath: "input/topics/topics.json", src: join(propose.workspaceSnapshot, "output", "topics.json") },
        { type: "demand", relPath: "input/demand/demand.json", src: join(demandDir, "output", "demand.json") },
        { type: "channel_brief", relPath: "input/channel-brief/channel-brief.json", src: join(brief.workspaceSnapshot, "output", "channel-brief.json") },
      ];
      const { result, workspaceDir } = await invokeStage(voiceWorld.channel, runId, "create-requests", "create-requests", inputs);
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
      const receipt = JSON.parse(readFileSync(join(workspaceDir, "output", "requests-receipt.json"), "utf8")) as RequestsReceipt;
      expect(receipt.request_ids).toHaveLength(2);
      expect(receipt.downgraded_voice ?? []).toEqual([]);

      const ctx = buildContext({ projectDir: voiceWorld.channel });
      try {
        const ttsRequest = ctx.store.listContentRequests({}).find((r) => r.topic.includes("Giọng đọc tự động"))!;
        expect(ttsRequest.voice).toBe("tts");
        expect(ttsRequest.voice_id).toBe(voiceId);
        expect(ttsRequest.notes).not.toContain("voice: tts→none");
      } finally { ctx.close(); }
    });

    it("a retired channel voice: the \"tts\" topic still downgrades to \"none\" (retired is not active)", async () => {
      const retiredWorld = freshLibraryWorld({ media: false });
      const retiredRepoDir = setupChannelRepo();
      const voiceId = seedVoiceProfile(retiredWorld.channel, "retired");
      addChannel(retiredWorld.channel, retiredRepoDir, voiceId);
      const retiredStyleId = newId("edit_style");
      writeActiveStyle(retiredWorld.lib, retiredStyleId);
      librarySync(retiredWorld.channel);

      const contentId = createPlanningContent(retiredWorld.channel, "planning c1 voice-retired");
      const runId = planRun(retiredWorld.channel, "channel-planning@1.0.0", "channel-planning", contentId);
      const brief = await runAndCommit(retiredWorld.channel, runId, "channel-brief", "channel-brief");
      await runAndCommit(retiredWorld.channel, runId, "demand", "demand");
      const demandDir = writeDemandJson({ needed: 2, max_open_requests: 10, open_requests: 0, topics_per_run: 5 });
      const propose = await fabricateProposeTopics(retiredWorld.channel, runId, TTS_MIX_PROPOSAL());

      const inputs = [
        { type: "topic_proposal", relPath: "input/topics/topics.json", src: join(propose.workspaceSnapshot, "output", "topics.json") },
        { type: "demand", relPath: "input/demand/demand.json", src: join(demandDir, "output", "demand.json") },
        { type: "channel_brief", relPath: "input/channel-brief/channel-brief.json", src: join(brief.workspaceSnapshot, "output", "channel-brief.json") },
      ];
      const { result, workspaceDir } = await invokeStage(retiredWorld.channel, runId, "create-requests", "create-requests", inputs);
      expect(result.outcome, JSON.stringify(result)).toBe("succeeded");
      const receipt = JSON.parse(readFileSync(join(workspaceDir, "output", "requests-receipt.json"), "utf8")) as RequestsReceipt;
      expect(receipt.downgraded_voice).toHaveLength(1);

      const ctx = buildContext({ projectDir: retiredWorld.channel });
      try {
        const downgraded = ctx.store.getContentRequest(receipt.downgraded_voice![0]!)!;
        expect(downgraded.voice).toBe("none");
        expect(downgraded.notes).toContain("voice: tts→none");
      } finally { ctx.close(); }
    });
  });

  describe("create-requests: no active edit style anywhere", () => {
    it("fails contract", async () => {
      const noStyleWorld = freshLibraryWorld({ media: false });
      const noStyleRepoDir = setupChannelRepo();
      addChannel(noStyleWorld.channel, noStyleRepoDir);
      // no writeActiveStyle/librarySync here: the kho has no styles at all

      const contentId = createPlanningContent(noStyleWorld.channel, "planning c1 no-style");
      const runId = planRun(noStyleWorld.channel, "channel-planning@1.0.0", "channel-planning", contentId);
      const brief = await runAndCommit(noStyleWorld.channel, runId, "channel-brief", "channel-brief");
      const demand = await runAndCommit(noStyleWorld.channel, runId, "demand", "demand");
      const propose = await fabricateProposeTopics(noStyleWorld.channel, runId, SAMPLE_PROPOSAL());

      const inputs = [
        { type: "topic_proposal", relPath: "input/topics/topics.json", src: join(propose.workspaceSnapshot, "output", "topics.json") },
        { type: "demand", relPath: "input/demand/demand.json", src: join(demand.workspaceSnapshot, "output", "demand.json") },
        { type: "channel_brief", relPath: "input/channel-brief/channel-brief.json", src: join(brief.workspaceSnapshot, "output", "channel-brief.json") },
      ];
      const { result } = await invokeStage(noStyleWorld.channel, runId, "create-requests", "create-requests", inputs);
      expect(result.outcome, JSON.stringify(result)).toBe("failed");
      expect(result.errors[0]?.kind).toBe("contract");
      expect(result.errors[0]?.message).toContain("active edit style");
    });
  });
});
