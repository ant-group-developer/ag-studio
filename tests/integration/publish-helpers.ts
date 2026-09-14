import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { newId, type ChannelPackage, type PublicationJob } from "@harness/contracts";
import { HARNESS_ROOT, SqliteStateStore, SystemClock } from "@harness/core";
import { CHANNEL_FIXTURE, freshLibraryWorld, librarySync, writeActiveStyle, writeLibraryItem, type LibraryWorld } from "./library-helpers.js";
import { cli } from "./footage-helpers.js";

export { cli, drain, stageId, status } from "./footage-helpers.js";

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
   * a channel is publishing its own or a shared item -- one item keeps every test's setup to a single call). */
  itemId: string;
  styleId: string;
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
 * comment), never from a temp project. */
function writeChannelYaml(project: string, channelId: string, repoDir: string): void {
  const src = join(CHANNEL_FIXTURE, "channels", channelId, "channel.yaml");
  const cfg = parse(readFileSync(src, "utf8")) as Record<string, unknown>;
  cfg.repo_dir = posix(repoDir);
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
export function freshPublishWorld(o: { uploadMode?: string; scheduleMode?: string; agentMode?: string; lookup?: Record<string, unknown> } = {}): PublishWorld {
  const world = freshLibraryWorld({ media: false }) as PublishWorld;
  fixAgentArgv(world.channel);

  const repos: Record<string, string> = {};
  for (const id of CHANNEL_IDS) {
    const repoDir = copyRepo();
    repos[id] = repoDir;
    writeChannelYaml(world.channel, id, repoDir);
  }
  world.repos = repos;

  const styleId = newId("edit_style");
  writeActiveStyle(world.lib, styleId);
  const itemId = newId("library_item");
  writeLibraryItem(world.lib, {
    itemId, styleId, status: "approved", titleHint: "Chợ nổi Cái Răng buổi sáng",
    extraFiles: [
      { path: "thumb-01.png", body: "fake png bytes for thumb 1", mime_type: "image/png" },
      { path: "thumb-02.png", body: "fake png bytes for thumb 2", mime_type: "image/png" },
    ],
  });
  librarySync(world.channel);
  world.itemId = itemId;
  world.styleId = styleId;

  const lookupFile = join(world.channel, "lookup.json");
  writeFileSync(lookupFile, JSON.stringify(o.lookup ?? {}));
  world.secretsEnv = {
    HARNESS_SECRET_YOUTUBE_CHANNEL_ONE_EMAIL: "owner@example.com",
    HARNESS_SECRET_YOUTUBE_CHANNEL_TWO_EMAIL: "owner@example.com",
    HARNESS_PUBLISHER_LOOKUP_FILE: lookupFile,
    ...(o.uploadMode ? { FAKE_UPLOAD_MODE: o.uploadMode } : {}),
    ...(o.scheduleMode ? { FAKE_SCHEDULE_MODE: o.scheduleMode } : {}),
    ...(o.agentMode ? { FAKE_AGENT_MODE: o.agentMode } : {}),
  };

  return world;
}

/** `library pick` (claims `world.itemId` into a fresh `ContentItem` for `channelId`) -> `plan
 * channel-publish@1.0.0` / profile `channel` -> `enqueue`. */
export function pickAndPlan(world: PublishWorld, channelId: string): { contentId: string; runId: string } {
  const pick = cli(world.channel, ["library", "pick", world.itemId, "--channel", channelId, "--json"], world.secretsEnv);
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

/** Rewrites `project.yaml`'s `publication.verify_grace_hours` in place, mirroring
 * `library-helpers.ts`'s `setResourceCapacity`. */
export function setVerifyGraceHours(project: string, hours: number): void {
  const path = join(project, "project.yaml");
  const cfg = parse(readFileSync(path, "utf8")) as { publication?: Record<string, unknown> };
  cfg.publication = { ...cfg.publication, verify_grace_hours: hours };
  writeFileSync(path, stringify(cfg));
}
