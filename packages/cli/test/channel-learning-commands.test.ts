import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { newId, type ChannelPackage, type Hypothesis, type PublicationJob, type StatsOutcome } from "@harness/contracts";
import { HARNESS_ROOT } from "@harness/core";
import { buildContext, type AppContext } from "../src/composition.js";
import { cli, freshLibraryWorld, librarySync, type LibraryWorld } from "../../../tests/integration/library-helpers.js";

// Task 6: `harness channel stats|collect|learned|demand|plan-requests|pick-next|metrics import` (spec §2.5,
// §4.5), driven the same way `channel-publish-commands.test.ts` (Task 9) drives the existing `channel …`
// commands: jobs/packages are written straight into the store by hand, `HARNESS_FAKE_STATS_FILE` stands in for
// a real Studio collect, and `--json` output is parsed and asserted on directly.

const LEGACY_REPO_FIXTURE = join(HARNESS_ROOT, "fixtures", "legacy-channel-repo");
const CHANNEL_ID = "c1";
const PORTFOLIO_ID = "portfolio-channel"; // matches fixtures/ops-project-channel/project.yaml's own portfolio
const PLACEHOLDER = "sha256:" + "0".repeat(64);
const SECRET_ENV = { HARNESS_SECRET_YOUTUBE_C1_EMAIL: "owner@example.com" };

function setupChannelRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "learning-cmd-repo-"));
  cpSync(LEGACY_REPO_FIXTURE, dir, { recursive: true });
  return dir;
}

/** `channels/c1/channel.yaml` with `planning`/`auto_pick` both enabled and `lookahead_slots: 3` -- with
 * nothing else covering the channel's publish schedule, `channelDemand` computes `needed: 3` deterministically
 * (mirrors `learning-stages.test.ts`'s own `lookahead_slots`-pinned `needed` expectation). */
function addChannel(project: string, repoDir: string): void {
  const channelDir = join(project, "channels", CHANNEL_ID);
  mkdirSync(channelDir, { recursive: true });
  writeFileSync(join(channelDir, "channel.yaml"), stringify({
    schema_version: "harness.channel-config/v1",
    channel_id: CHANNEL_ID,
    display_name: "Channel One",
    portfolio_id: PORTFOLIO_ID,
    repo_dir: repoDir.split("\\").join("/"),
    legacy_project_id: "project-01",
    youtube: { expected_channel_id: "UCfake000000000000000001", account_email_ref: `secret://youtube-${CHANNEL_ID}/email` },
    publication: { timezone: "Asia/Ho_Chi_Minh", publish_times: ["09:00", "18:00"], max_daily_uploads: 3, min_gap_hours: 1 },
    episode: { start: 1, dir_pattern: "episode-{nn}" },
    overlay: { enabled: false },
    planning: { enabled: true, lookahead_slots: 3, topics_per_run: 3, max_open_requests: 3, check_seconds: 3600 },
    auto_pick: { enabled: true, max_concurrent_runs: 1 },
  }));
}

function withCtx<T>(project: string, fn: (ctx: AppContext) => T): T {
  const ctx = buildContext({ projectDir: project });
  try { return fn(ctx); } finally { ctx.close(); }
}

function sampleHypothesis(title: string): Hypothesis {
  return {
    schema_version: "harness.hypothesis/v1", hypothesis_id: newId("hypothesis"),
    basis: [{ kind: "manual", note: "seed" }],
    chosen: { title, thumbnail_candidate: "thumb.png", overlay_text: [], angle: "flycam" },
    rejected: [{ title: "Other angle", angle: "", why: "weaker" }],
    // 72h, matching the channel's own default `learning.horizon_hours` (this channel.yaml declares no
    // `learning` block): the seeded snapshot lands at ~80h, inside `snapshotAtHorizon`'s [60, 96] window.
    // A 48h horizon here would put that snapshot outside its [36, 72] window -- correctly leaving the
    // hypothesis `open`, but not what these tests are about.
    expected: { metric: "ctr", target: 0.1, horizon_hours: 72 },
    status: "open", created_at: "2026-09-01T00:00:00.000Z",
  };
}

/** Hand-writes a `committed` `ChannelPackage` (mirrors `channel-publish-commands.test.ts`'s own `seedPackage`). */
function seedPackage(ctx: AppContext, o: { episodeNo: number; title: string }): ChannelPackage {
  const now = ctx.clock.now();
  const channel = ctx.channels.get(CHANNEL_ID);
  const pkg: ChannelPackage = {
    schema_version: "harness.channel-package/v1", package_id: newId("channel_package"), channel_id: CHANNEL_ID,
    variant_id: newId("content_variant"), content_id: newId("content_item"), library_item_id: newId("library_item"), run_id: newId("run"),
    episode_no: o.episodeNo, episode_dir: `episode-${o.episodeNo}`, manifest_digest: PLACEHOLDER,
    video_artifact_id: newId("artifact"), thumbnail_artifact_id: newId("artifact"), video_checksum: PLACEHOLDER, thumbnail_checksum: PLACEHOLDER,
    metadata: { title: o.title, description: "", tags: [], playlists: [], hashtags: [], pinned_comment: "", language: "en" },
    hypothesis: sampleHypothesis(o.title), metadata_revision: 1, channel_config_revision: channel.config_revision,
    status: "committed", created_at: now, updated_at: now,
  };
  ctx.store.insertChannelPackage(pkg);
  return pkg;
}

/** A `PUBLISHED` `PublicationJob` whose `published_at` is `hoursAgo` before the (system) clock's "now" --
 * `collectDue` (default `horizon_hours: 72`) is due for one whose `published_at` is 80h in the past but not
 * yet due for the default `recollect_hours: [168, 720]` targets, so `channel collect` sees exactly one due
 * item for it. */
function seedPublishedJob(ctx: AppContext, pkg: ChannelPackage, o: { videoId: string; hoursAgo: number }): PublicationJob {
  const now = ctx.clock.now();
  const publishedAt = new Date(Date.parse(now) - o.hoursAgo * 3_600_000).toISOString();
  const job: PublicationJob = {
    schema_version: "harness.publication-job/v1", publication_job_id: newId("publication_job"), package_id: pkg.package_id,
    channel_id: CHANNEL_ID, library_item_id: pkg.library_item_id, run_id: pkg.run_id,
    idempotency_key: "sha256:" + createHash("sha256").update(pkg.package_id).digest("hex"),
    state: "PUBLISHED", youtube_video_id: o.videoId, operation_id: null, scheduled_at: null,
    published_at: publishedAt, last_verified_at: null, note: null, receipt: null, created_at: now, updated_at: now,
  };
  ctx.store.insertPublicationJob(job);
  return job;
}

function writeFakeStatsFile(path: string, outcomes: Record<string, StatsOutcome>): void {
  writeFileSync(path, JSON.stringify(outcomes));
}

/** Writes an `items/<id>/` the way library-export would have, approved and (optionally) targeted at a
 * content request -- enough for `autoPick`'s group-A/group-B candidate scan (mirrors `learning-stages.test.ts`'s
 * own `writeApprovedItem`, minus the media files this file's tests never need to fetch). */
function writeApprovedItem(lib: string, itemId: string, o: { requestId?: string } = {}): void {
  const dir = join(lib, "items", itemId);
  mkdirSync(dir, { recursive: true });
  const body = `fake episode bytes for ${itemId}\n`;
  writeFileSync(join(dir, "episode.mp4"), body);
  const item = {
    schema_version: "harness.library-item/v1", item_id: itemId, status: "approved", title_hint: `Ep ${itemId}`, summary: "seed summary",
    style: { style_id: newId("edit_style"), revision: 1 }, duration_seconds: 5, media: null,
    ...(o.requestId ? { request_id: o.requestId } : {}),
    files: [{ path: "episode.mp4", checksum: "sha256:" + createHash("sha256").update(body).digest("hex"), size_bytes: Buffer.byteLength(body), mime_type: "video/mp4" }],
    lineage: { project_id: "project-studio", run_id: newId("run"), content_id: newId("content_item"), source_ids: [] },
    review: { note: "" }, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(item, null, 2) + "\n");
}

describe("harness channel stats/collect/learned/demand/plan-requests/pick-next/metrics import", () => {
  let world: LibraryWorld;
  let repoDir: string;
  let job: PublicationJob;
  const statsFile = join(mkdtempSync(join(tmpdir(), "fake-stats-")), "stats.json");

  beforeAll(() => {
    world = freshLibraryWorld({ media: false });
    repoDir = setupChannelRepo();
    addChannel(world.channel, repoDir);
    librarySync(world.channel);

    withCtx(world.channel, (ctx) => {
      const pkg = seedPackage(ctx, { episodeNo: 1, title: "Ep 1" });
      job = seedPublishedJob(ctx, pkg, { videoId: "vidABC", hoursAgo: 80 });
    });

    writeFakeStatsFile(statsFile, { vidABC: { kind: "ok", views: 100, impressions: 500, ctr_pct: 5, avg_view_sec: 60 } });
  });

  function cliJson<T>(args: string[]): { code: number | null; json: T; out: string } {
    const r = cli(world.channel, args, { ...SECRET_ENV, HARNESS_FAKE_STATS_FILE: statsFile });
    return { code: r.code, json: r.out ? (JSON.parse(r.out) as T) : (undefined as T), out: r.out };
  }

  it("channel collect --channel c1 --json collects the one due job, exit 0", () => {
    const r = cliJson<{ collected: { job_id: string }[]; blocked: string[]; failed: unknown[] }>(["channel", "collect", "--channel", CHANNEL_ID, "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.collected).toHaveLength(1);
    expect(r.json.collected[0]!.job_id).toBe(job.publication_job_id);
    expect(r.json.blocked).toEqual([]);
    expect(r.json.failed).toEqual([]);
  });

  it("channel stats c1 --json has one row with the collected snapshot", () => {
    const r = cliJson<{ episode_no: number; snapshots: number; views: number | null; ctr_pct: number | null }[]>(["channel", "stats", CHANNEL_ID, "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.json).toHaveLength(1);
    expect(r.json[0]).toMatchObject({ episode_no: 1, snapshots: 1, views: 100, ctr_pct: 5 });
  });

  it("channel learned c1 --json reports a note when there are not yet enough supported hypotheses in one group", () => {
    const r = cliJson<{ sample_size: number; standard: { note: string; angle?: string } }>(["channel", "learned", CHANNEL_ID, "--json"]);
    expect(r.code, r.out).toBe(0);
    // the one hypothesis collect just evaluated (ctr_pct 5 >= target 0.1) is `supported`, but `min_samples`
    // (default 2) is not met yet -- exactly the "chưa đủ" case the brief calls for.
    expect(r.json.sample_size).toBe(1);
    expect(r.json.standard.note).toContain("giả thuyết supported");
  });

  it("channel demand c1 --json: needed reflects lookahead_slots with nothing else covering the schedule", () => {
    const r = cliJson<{ needed: number; open_requests: number }>(["channel", "demand", CHANNEL_ID, "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.needed).toBe(3);
  });

  it("channel plan-requests c1 --json starts a channel-planning run (demand is uncovered, no cooldown yet)", () => {
    const r = cliJson<{ started?: { run_id: string; needed: number }; skipped?: string }>(["channel", "plan-requests", CHANNEL_ID, "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.started ?? r.json.skipped, r.out).toBeTruthy();
    if (r.json.started) {
      expect(r.json.started.run_id).toMatch(/^run_/);
      expect(r.json.started.needed).toBe(3);
    } else {
      expect(r.json.skipped).toBe("open-cap");
    }
  });

  it("channel pick-next c1 --json picks the approved item targeted at this channel's own request", () => {
    const requestJson = cli(world.channel, ["library", "request", "create", "--portfolio", PORTFOLIO_ID, "--channel", CHANNEL_ID, "--topic", "Auto pick topic", "--style", newId("edit_style"), "--json"]);
    expect(requestJson.code, requestJson.err).toBe(0);
    const requestId = (JSON.parse(requestJson.out) as { request_id: string }).request_id;

    const itemId = newId("library_item");
    writeApprovedItem(world.lib, itemId, { requestId });
    librarySync(world.channel);

    const r = cliJson<{ picked?: { item_id: string; run_id: string }; skipped?: string }>(["channel", "pick-next", CHANNEL_ID, "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.picked, r.out).toBeDefined();
    expect(r.json.picked!.item_id).toBe(itemId);
  });

  it("channel metrics import c1 <jsonl> --json imports matching rows and reports the rest skipped", () => {
    const jsonlPath = join(mkdtempSync(join(tmpdir(), "metrics-import-")), "channel-metrics.jsonl");
    const lines = [
      JSON.stringify({ videoId: "vidABC", views: 200, impressions: 900, ctr_pct: 6, avg_view_sec: 70, collectedAt: "2026-09-13T00:00:00.000Z" }),
      JSON.stringify({ videoId: "vid-does-not-exist", views: 10 }),
    ];
    writeFileSync(jsonlPath, lines.join("\n") + "\n");

    const r = cliJson<{ imported: number; skipped: { videoId: string; why: string }[] }>(["channel", "metrics", "import", CHANNEL_ID, jsonlPath, "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.imported).toBe(1);
    expect(r.json.skipped).toHaveLength(1);
    expect(r.json.skipped[0]!.videoId).toBe("vid-does-not-exist");
  });

  it("channel collect exits 1 when the report has failures, but still prints the report", () => {
    // a job with no youtube_video_id is reported `failed` by `collectStats` without ever calling the collector.
    const failing = withCtx(world.channel, (ctx) => {
      const pkg = seedPackage(ctx, { episodeNo: 2, title: "Ep 2" });
      const now = ctx.clock.now();
      const noVideoJob: PublicationJob = {
        schema_version: "harness.publication-job/v1", publication_job_id: newId("publication_job"), package_id: pkg.package_id,
        channel_id: CHANNEL_ID, library_item_id: pkg.library_item_id, run_id: pkg.run_id,
        idempotency_key: "sha256:" + createHash("sha256").update(pkg.package_id + "novideo").digest("hex"),
        state: "PUBLISHED", youtube_video_id: null, operation_id: null, scheduled_at: null,
        published_at: new Date(Date.parse(now) - 80 * 3_600_000).toISOString(), last_verified_at: null, note: null, receipt: null,
        created_at: now, updated_at: now,
      };
      ctx.store.insertPublicationJob(noVideoJob);
      return noVideoJob;
    });

    const r = cliJson<{ failed: { job_id: string; reason: string }[] }>(["channel", "collect", "--channel", CHANNEL_ID, "--force", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json.failed.some((f) => f.job_id === failing.publication_job_id)).toBe(true);
  });
});
