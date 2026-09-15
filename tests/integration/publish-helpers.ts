import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { newId, type ChannelPackage, type ContentRequest, type Hypothesis, type PublicationJob, type StatsOutcome } from "@harness/contracts";
import { HARNESS_ROOT, SqliteStateStore, SystemClock } from "@harness/core";
import { CHANNEL_FIXTURE, freshLibraryWorld, librarySync, writeActiveStyle, writeLibraryItem, type LibraryWorld } from "./library-helpers.js";
import { cli } from "./footage-helpers.js";

export { cli, drain, stageId, status } from "./footage-helpers.js";
// Re-exported so a test that drives *both* machines of a `{ learning: true }` world (the channel worker and
// the studio worker on one shared kho) imports its whole vocabulary from this one module.
export { librarySync, studioWorkerUntil, writeActiveStyle, writeLibraryItem } from "./library-helpers.js";

// Task 11: a shared kho with two channels wired to their own temp copy of fixtures/legacy-channel-repo, both
// pointed at fixtures/fake-agent-cli.mjs as their agent CLI and PlaywrightPublisher as their publisher --
// everything publish-pipeline.test.ts and acceptance 21-26 need to drive `channel-publish@1.0.0` for real.

const LEGACY_REPO_FIXTURE = join(HARNESS_ROOT, "fixtures", "legacy-channel-repo");
const FAKE_AGENT_CLI = join(HARNESS_ROOT, "fixtures", "fake-agent-cli.mjs");
const CHANNEL_IDS = ["channel-one", "channel-two"] as const;

const posix = (p: string): string => p.split("\\").join("/");

export interface PublishWorld extends LibraryWorld {
  /** channel_id -> temp copy of fixtures/legacy-channel-repo that channel's channel.yaml `repo_dir` points at. */
  repos: Record<string, string>;
  /** The one approved kho item both channels pick from (a channel-publish run is otherwise identical whether
   * a channel is publishing its own or a shared item -- one item keeps every test's setup to a single call).
   * Empty string in a `{ learning: true }` world: that world starts with an *empty* kho on purpose (the
   * channel has to plan a request and the studio has to build the item), and a pre-seeded approved item would
   * both cover the demand being measured and be the item auto-pick grabbed first. */
  itemId: string;
  styleId: string;
  /** JSON `{ [video_id]: StatsOutcome }` that `FakeStatsCollector` re-reads on every collect -- already
   * exported as `HARNESS_FAKE_STATS_FILE` in `secretsEnv`, written/rewritten with `statsFile()`. */
  statsPath: string;
  /** Every env var `cli()`/`drain()` need for a channel-publish run to work end to end: both channels'
   * resolved YouTube account email secrets, plus `HARNESS_PUBLISHER_LOOKUP_FILE` pointing at a `lookup.json`
   * this world already wrote (starting as `o.lookup ?? {}`, so `publish reconcile`/`publish verify` never hit
   * the network). `FAKE_UPLOAD_MODE`/`FAKE_SCHEDULE_MODE`/`FAKE_AGENT_MODE` are only set here when `o` asked
   * for them -- a caller that needs a different mode mid-test just spreads `world.secretsEnv` with its own
   * override (`{ ...world.secretsEnv, FAKE_UPLOAD_MODE: "lost" }`), same as every other call site of `cli`. */
  secretsEnv: Record<string, string>;
}

/** Fresh temp copy of `fixtures/legacy-channel-repo`, matching `packages/cli/test/publish-stage.test.ts`'s
 * `setupChannelRepo` -- each world gets two independent repos (one per channel) so their `outputs/` never
 * collide, even though both start from the same `legacy_project_id: project-01`. */
function copyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "legacy-repo-"));
  cpSync(LEGACY_REPO_FIXTURE, dir, { recursive: true });
  return dir;
}

/** `channels/<id>/channel.yaml`, copied from the committed fixture with `repo_dir` repointed at `repoDir` --
 * the committed relative value only resolves from inside the fixture directory itself (see that file's own
 * comment), never from a temp project.
 *
 * `learning: false` (the default) additionally strips the sub-project 3B blocks the fixture now ships
 * (`learning`/`planning`/`auto_pick`), reproducing the pre-3B channel exactly -- the same trick
 * `library-helpers.ts`'s `writeProjectYaml` plays with the studio fixture's `autopilot`. Without it every
 * sub-project 3 test would silently gain a planning sweep and an auto-pick sweep on each idle `worker --once`
 * poll, which would plan channel-planning runs and claim kho items none of those tests ever asked for. */
function writeChannelYaml(project: string, channelId: string, repoDir: string, o: { learning?: boolean } = {}): void {
  const src = join(CHANNEL_FIXTURE, "channels", channelId, "channel.yaml");
  const cfg = parse(readFileSync(src, "utf8")) as Record<string, unknown>;
  cfg.repo_dir = posix(repoDir);
  if (!o.learning) {
    delete cfg.learning;
    delete cfg.planning;
    delete cfg.auto_pick;
  }
  const dir = join(project, "channels", channelId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "channel.yaml"), stringify(cfg));
}

/** Rewrites the temp channel project's `adapters.agent_argv` to absolute paths (see the fixture project.yaml's
 * own comment): `node` -> `process.execPath`, `../fake-agent-cli.mjs` -> its absolute path. Everything else in
 * `project.yaml` (workflows scope, resources, adapters.publisher/agent) already came through unchanged from
 * the committed fixture via `freshLibraryWorld`'s own `writeProjectYaml`. */
function fixAgentArgv(project: string): void {
  const path = join(project, "project.yaml");
  const cfg = parse(readFileSync(path, "utf8")) as { adapters?: { agent_argv?: string[] } };
  cfg.adapters = { ...cfg.adapters, agent_argv: [process.execPath, posix(FAKE_AGENT_CLI), "{prompt}"] };
  writeFileSync(path, stringify(cfg));
}

/**
 * `freshLibraryWorld({ media: false })` plus everything `channel-publish@1.0.0` needs to actually run: two
 * temp legacy-repo copies wired to `channels/channel-one` and `channels/channel-two`, `project.yaml`'s
 * `adapters.agent_argv` pointed at the real `fake-agent-cli.mjs`, one approved kho item with two thumbnail
 * candidates (`thumb-01.png`, `thumb-02.png`) both channels can pick from, and `secretsEnv` covering both
 * channels' YouTube account-email secrets plus a `HARNESS_PUBLISHER_LOOKUP_FILE`.
 */
export function freshPublishWorld(o: { uploadMode?: string; scheduleMode?: string; agentMode?: string; lookup?: Record<string, unknown>; learning?: boolean } = {}): PublishWorld {
  const learning = o.learning ?? false;
  // A learning world drives the *whole* two-machine loop, so its studio half has to be the sub-project 4
  // autopilot studio (real agent CLI, `library.auto_accept` on) with the raw media a library-production run
  // actually cuts from; a plain publish world still gets the cheap media-less studio it always had.
  const world = freshLibraryWorld({ media: learning, autopilot: learning }) as PublishWorld;
  fixAgentArgv(world.channel);

  const repos: Record<string, string> = {};
  for (const id of CHANNEL_IDS) {
    const repoDir = copyRepo();
    repos[id] = repoDir;
    writeChannelYaml(world.channel, id, repoDir, { learning });
  }
  world.repos = repos;

  const styleId = newId("edit_style");
  writeActiveStyle(world.lib, styleId);
  world.styleId = styleId;
  world.itemId = "";
  if (!learning) {
    const itemId = newId("library_item");
    writeLibraryItem(world.lib, {
      itemId, styleId, status: "approved", titleHint: "Chợ nổi Cái Răng buổi sáng",
      extraFiles: [
        { path: "thumb-01.png", body: "fake png bytes for thumb 1", mime_type: "image/png" },
        { path: "thumb-02.png", body: "fake png bytes for thumb 2", mime_type: "image/png" },
      ],
    });
    world.itemId = itemId;
  }
  librarySync(world.channel);

  const lookupFile = join(world.channel, "lookup.json");
  writeFileSync(lookupFile, JSON.stringify(o.lookup ?? {}));
  world.statsPath = join(world.channel, "fake-stats.json");
  writeFileSync(world.statsPath, "{}");
  world.secretsEnv = {
    HARNESS_SECRET_YOUTUBE_CHANNEL_ONE_EMAIL: "owner@example.com",
    HARNESS_SECRET_YOUTUBE_CHANNEL_TWO_EMAIL: "owner@example.com",
    HARNESS_PUBLISHER_LOOKUP_FILE: lookupFile,
    HARNESS_FAKE_STATS_FILE: world.statsPath,
    ...(o.uploadMode ? { FAKE_UPLOAD_MODE: o.uploadMode } : {}),
    ...(o.scheduleMode ? { FAKE_SCHEDULE_MODE: o.scheduleMode } : {}),
    ...(o.agentMode ? { FAKE_AGENT_MODE: o.agentMode } : {}),
  };

  return world;
}

/** `library pick` (claims `itemId`, default `world.itemId`, into a fresh `ContentItem` for `channelId`) ->
 * `plan channel-publish@1.0.0` / profile `channel` -> `enqueue`. The workflow release is pinned explicitly
 * (not taken from the profile, which points at 1.1.0 since sub-project 3B): every caller of this helper is a
 * sub-project 3 test, and acceptance 40 depends on 1.0.0 still being what they drive. */
export function pickAndPlan(world: PublishWorld, channelId: string, itemId = world.itemId): { contentId: string; runId: string } {
  const pick = cli(world.channel, ["library", "pick", itemId, "--channel", channelId, "--json"], world.secretsEnv);
  if (pick.code !== 0) throw new Error(`library pick failed: ${pick.err}\n${pick.out}`);
  const { content_id } = JSON.parse(pick.out) as { content_id: string };

  const plan = cli(world.channel, ["plan", "--workflow", "channel-publish@1.0.0", "--profile", "channel", "--content", content_id, "--json"], world.secretsEnv);
  if (plan.code !== 0) throw new Error(`plan failed: ${plan.err}\n${plan.out}`);
  const { run_id } = JSON.parse(plan.out) as { run_id: string };

  const enq = cli(world.channel, ["enqueue", run_id], world.secretsEnv);
  if (enq.code !== 0) throw new Error(`enqueue failed: ${enq.err}\n${enq.out}`);

  return { contentId: content_id, runId: run_id };
}

/** `harness publish list --json`, optionally filtered to one channel. */
export function jobs(world: PublishWorld, channelId?: string): PublicationJob[] {
  const args = ["publish", "list", "--json", ...(channelId ? ["--channel", channelId] : [])];
  const r = cli(world.channel, args, world.secretsEnv);
  if (r.code !== 0) throw new Error(`publish list failed: ${r.err}\n${r.out}`);
  return JSON.parse(r.out) as PublicationJob[];
}

/** `<repo>/outputs/project-01/publish-queue.json`, the legacy upload script's own append-only log -- `[]`
 * when the file does not exist yet (no upload has ever run against this repo). */
export function readQueue(repo: string): { ep: string; videoId: string }[] {
  const path = join(repo, "outputs", "project-01", "publish-queue.json");
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { ep: string; videoId: string }[];
  return raw.map((r) => ({ ep: r.ep, videoId: r.videoId }));
}

/** A short-lived read/write handle on a temp project's own `data/state/harness.db`, for the handful of
 * things no CLI command exposes (a `ChannelPackage`'s full `hypothesis`, or hand-backdating a real job's
 * `scheduled_at` the same way the acceptance briefs "ghi tay" a job into a NEEDS_RECONCILIATION/overdue
 * state) -- closed again before returning, so it never overlaps a concurrent `cli()`/`drain()` subprocess. */
export function withStore<T>(project: string, fn: (store: SqliteStateStore) => T): T {
  const store = new SqliteStateStore(join(project, "data", "state", "harness.db"), new SystemClock());
  try { return fn(store); } finally { store.close(); }
}

/** The `ChannelPackage` (full `hypothesis`, `episode_no`, …) behind a publication job -- nothing the CLI
 * exposes today goes further than `channel hypotheses`' trimmed row, so this reads the store directly. */
export function packageFor(project: string, jobId: string): ChannelPackage {
  return withStore(project, (store) => {
    const job = store.getPublicationJob(jobId);
    if (!job) throw new Error(`publication job not found: ${jobId}`);
    const pkg = store.getChannelPackage(job.package_id);
    if (!pkg) throw new Error(`channel package not found: ${job.package_id}`);
    return pkg;
  });
}

/** Rewrites one job's `scheduled_at` in place -- how a real `SCHEDULED` job (booked at a genuine *future*
 * `nextSlot()`) is turned into the "overdue" fixture `publish verify`/`publish reconcile` scenarios need,
 * without waiting for real wall-clock time to pass. */
export function backdateScheduled(project: string, jobId: string, isoDate: string): void {
  withStore(project, (store) => {
    const job = store.getPublicationJob(jobId);
    if (!job) throw new Error(`publication job not found: ${jobId}`);
    store.updatePublicationJob({ ...job, scheduled_at: isoDate });
  });
}

/** Rewrites the world's `HARNESS_FAKE_STATS_FILE` (`{ [video_id]: StatsOutcome }`) outright.
 * `FakeStatsCollector` re-reads that file on every single `collect()`, so a test can script one outcome for
 * the first sweep and a different one for the next without rebuilding the world. Write it *before* the job
 * being collected becomes due: a video with no entry falls back to the collector's own generic default
 * (`views 100, impressions 500, ctr_pct 5`), which is almost never what a learning assertion wants. */
export function statsFile(world: PublishWorld, outcomes: Record<string, StatsOutcome>): void {
  writeFileSync(world.statsPath, JSON.stringify(outcomes, null, 2));
}

/**
 * Ages one publication job by `hours`, the way `backdateScheduled` ages a SCHEDULED one: `scheduled_at` moves
 * back so `verifyScheduled` considers the job overdue, and `published_at` moves back so `collectDue` sees it
 * past `learning.horizon_hours`. Returns the ISO timestamp both were set to, which a caller also wants for
 * the `publish_at` of the matching `HARNESS_PUBLISHER_LOOKUP_FILE` entry -- `verifyScheduled` overwrites
 * `published_at` with `lookup.publish_at ?? now` the moment it settles the job PUBLISHED, so a backdate
 * applied before the verify sweep only survives if the lookup agrees with it.
 */
export function backdatePublished(world: PublishWorld, jobId: string, hours: number): string {
  const iso = new Date(Date.now() - hours * 3_600_000).toISOString();
  withStore(world.channel, (store) => {
    const job = store.getPublicationJob(jobId);
    if (!job) throw new Error(`publication job not found: ${jobId}`);
    store.updatePublicationJob({ ...job, scheduled_at: iso, published_at: iso });
  });
  return iso;
}

/** Drives the channel worker the way `studioWorkerUntil` drives the studio one: `worker --once` (always with
 * `world.secretsEnv`, plus whatever the caller layers on) up to `max` times, stopping as soon as `pred()` is
 * true. A channel worker's planning/auto-pick/collect sweeps only run on an *idle* poll and only ever set
 * something up for the *next* poll to claim, so polling on the worker's own idle/busy signal (what `drain`
 * does) would stop one poll too early; this polls a domain predicate instead. Does not throw when `max` runs
 * out -- the caller's own `expect` on whatever `pred` checked reports far better than a generic timeout. */
export function channelWorkerUntil(world: PublishWorld, pred: () => boolean, max = 60, env: Record<string, string> = {}): void {
  for (let i = 0; i < max && !pred(); i++) cli(world.channel, ["worker", "--once"], { ...world.secretsEnv, ...env });
}

/** Rewrites the world's `HARNESS_PUBLISHER_LOOKUP_FILE` (`{ [video_id]: LookupOutcome }`) outright -- what
 * `publish verify`/`reconcile` and the worker's own verify sweep ask instead of YouTube. */
export function writeLookup(world: PublishWorld, entries: Record<string, unknown>): void {
  writeFileSync(world.secretsEnv.HARNESS_PUBLISHER_LOOKUP_FILE!, JSON.stringify(entries));
}

/**
 * Hand-writes one already-`PUBLISHED` episode -- a `committed` `ChannelPackage` with an `open` hypothesis plus
 * the `PublicationJob` that carries its `youtube_video_id` -- straight into the channel project's store,
 * skipping the ~20s channel-publish run that would otherwise produce it. This is the same shortcut
 * `packages/cli/test/channel-learning-commands.test.ts` takes, lifted here because several acceptance tests
 * need a *history* of episodes (learning rules are about samples, not about publishing) and a real run per
 * sample would make them minutes long for no extra coverage.
 *
 * `hoursAgo` (default 80) puts `published_at` past the channel's 72h `learning.horizon_hours`, so the episode
 * is immediately due for `channel collect` and its snapshot immediately counts at the hypothesis horizon.
 */
export function seedPublishedEpisode(world: PublishWorld, o: {
  channelId: string; episodeNo: number; videoId: string; title?: string; angle?: string;
  metric?: Hypothesis["expected"]["metric"]; target?: number; overlayText?: string[]; hoursAgo?: number;
}): { packageId: string; jobId: string } {
  const title = o.title ?? `Tập ${o.episodeNo}`;
  const now = new Date().toISOString();
  const publishedAt = new Date(Date.now() - (o.hoursAgo ?? 80) * 3_600_000).toISOString();
  const packageId = newId("channel_package");
  const runId = newId("run");
  const itemId = newId("library_item");
  const digest = "sha256:" + createHash("sha256").update(packageId).digest("hex");

  const pkg: ChannelPackage = {
    schema_version: "harness.channel-package/v1", package_id: packageId, channel_id: o.channelId,
    variant_id: newId("content_variant"), content_id: newId("content_item"), library_item_id: itemId, run_id: runId,
    episode_no: o.episodeNo, episode_dir: `episode-${o.episodeNo}`, manifest_digest: digest,
    video_artifact_id: newId("artifact"), thumbnail_artifact_id: newId("artifact"), video_checksum: digest, thumbnail_checksum: digest,
    metadata: { title, description: "", tags: [], playlists: [], hashtags: [], pinned_comment: "", language: "vi" },
    hypothesis: {
      schema_version: "harness.hypothesis/v1", hypothesis_id: newId("hypothesis"),
      basis: [{ kind: "manual", note: "seeded by publish-helpers" }],
      chosen: { title, thumbnail_candidate: "thumb-01.png", overlay_text: o.overlayText ?? [], angle: o.angle ?? "" },
      rejected: [{ title: `${title} (bản khác)`, angle: "", why: "seeded" }],
      expected: { metric: o.metric ?? "views_72h", target: o.target ?? 1000, horizon_hours: 72 },
      status: "open", created_at: now,
    },
    metadata_revision: 1, channel_config_revision: digest, status: "committed", created_at: now, updated_at: now,
  };
  const job: PublicationJob = {
    schema_version: "harness.publication-job/v1", publication_job_id: newId("publication_job"), package_id: packageId,
    channel_id: o.channelId, library_item_id: itemId, run_id: runId, idempotency_key: digest,
    state: "PUBLISHED", youtube_video_id: o.videoId, operation_id: null, scheduled_at: null,
    published_at: publishedAt, last_verified_at: null, note: null, receipt: null, created_at: now, updated_at: now,
  };
  withStore(world.channel, (store) => {
    store.insertChannelPackage(pkg);
    store.insertPublicationJob(job);
  });
  return { packageId, jobId: job.publication_job_id };
}

/** Patches one channel's `planning` block in a temp project's `channels/<id>/channel.yaml`, mirroring
 * `library-helpers.ts`'s `setMaxReplans` -- for the scenarios whose whole point is a planning limit
 * (`lookahead_slots` above `max_open_requests`, say) that the committed fixture deliberately does not have. */
export function setChannelPlanning(project: string, channelId: string, patch: Record<string, unknown>): void {
  const path = join(project, "channels", channelId, "channel.yaml");
  const cfg = parse(readFileSync(path, "utf8")) as { planning?: Record<string, unknown> };
  cfg.planning = { ...cfg.planning, ...patch };
  writeFileSync(path, stringify(cfg));
}

/** `harness library list requests --json` against the channel project's mirror, after a fresh `library sync`
 * (the mirror is what every `library list` reads, and the kho files the studio/`create-requests` write are
 * only visible to this project once synced). */
export function channelRequests(world: PublishWorld): ContentRequest[] {
  librarySync(world.channel);
  const r = cli(world.channel, ["library", "list", "requests", "--json"], world.secretsEnv);
  if (r.code !== 0) throw new Error(`library list requests failed: ${r.err}\n${r.out}`);
  return JSON.parse(r.out) as ContentRequest[];
}

/** Rewrites `project.yaml`'s `publication.verify_grace_hours` in place, mirroring
 * `library-helpers.ts`'s `setResourceCapacity`. */
export function setVerifyGraceHours(project: string, hours: number): void {
  const path = join(project, "project.yaml");
  const cfg = parse(readFileSync(path, "utf8")) as { publication?: Record<string, unknown> };
  cfg.publication = { ...cfg.publication, verify_grace_hours: hours };
  writeFileSync(path, stringify(cfg));
}
