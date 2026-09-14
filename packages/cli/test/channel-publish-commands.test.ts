import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { newId, type ChannelPackage, type Hypothesis, type PublicationJob } from "@harness/contracts";
import { HARNESS_ROOT } from "@harness/core";
import { buildContext, type AppContext } from "../src/composition.js";
import { cli } from "../../../tests/integration/library-helpers.js";

// Task 9: `harness channel|publish|skills`, `reconcile --publication`, and the doctor rows they feed. Unlike
// `publish-stage.test.ts` (Task 8), none of this drives the actual channel-publish pipeline -- the jobs these
// commands read/write are written straight into the store by hand (`insertChannelPackage`/`insertPublicationJob`,
// per the brief), and `PlaywrightPublisher`'s `HARNESS_PUBLISHER_LOOKUP_FILE` stands in for the real provider.

const LEGACY_REPO_FIXTURE = join(HARNESS_ROOT, "fixtures", "legacy-channel-repo");
const PLACEHOLDER = "sha256:" + "0".repeat(64);

function setupChannelRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-repo-"));
  cpSync(LEGACY_REPO_FIXTURE, dir, { recursive: true });
  return dir;
}

function writeMinimalProjectYaml(dir: string, o: { projectId: string; adapters?: { publisher: "playwright" | "fake"; agent: "cli" | "fake" }; verifyGraceHours?: number }): void {
  writeFileSync(join(dir, "project.yaml"), stringify({
    schema_version: "harness.project-config/v1",
    project_id: o.projectId,
    template_release: "0.1.0",
    runtime: "claude",
    data_root: "./data",
    portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }],
    resources: {},
    // scoped to no workflow at all: this test never runs a workflow, and an unset scope would make `doctor`
    // scan every workflow.yaml installed in the harness for no reason.
    workflows: [],
    ...(o.adapters ? { adapters: o.adapters } : {}),
    ...(o.verifyGraceHours !== undefined ? { publication: { verify_seconds: 60, verify_grace_hours: o.verifyGraceHours } } : {}),
  }));
}

/** `channels/<id>/channel.yaml` pointing at a fresh copy of `fixtures/legacy-channel-repo`. */
function addChannel(project: string, id: string, repoDir: string): void {
  const channelDir = join(project, "channels", id);
  mkdirSync(channelDir, { recursive: true });
  writeFileSync(join(channelDir, "channel.yaml"), stringify({
    schema_version: "harness.channel-config/v1",
    channel_id: id,
    display_name: `Channel ${id.toUpperCase()}`,
    portfolio_id: "portfolio-main",
    repo_dir: repoDir.split("\\").join("/"),
    legacy_project_id: "project-01",
    youtube: { expected_channel_id: `UCfake0000000000000000${id}`, account_email_ref: `secret://youtube-${id}/email` },
    publication: { timezone: "Asia/Ho_Chi_Minh", publish_times: ["09:00", "18:00"], max_daily_uploads: 3, min_gap_hours: 1 },
    episode: { start: 1, dir_pattern: "episode-{nn}" },
    overlay: { enabled: false },
  }));
}

function migrate(project: string): void {
  const r = cli(project, ["db", "migrate"]);
  if (r.code !== 0) throw new Error(`db migrate failed in ${project}: ${r.err}\n${r.out}`);
}

function withCtx<T>(project: string, fn: (ctx: AppContext) => T): T {
  const ctx = buildContext({ projectDir: project });
  try { return fn(ctx); } finally { ctx.close(); }
}

function sampleHypothesis(title: string): Hypothesis {
  return {
    schema_version: "harness.hypothesis/v1", hypothesis_id: newId("hypothesis"),
    basis: [{ kind: "manual", note: "seed" }],
    chosen: { title, thumbnail_candidate: "thumb.png", overlay_text: [], angle: "" },
    rejected: [{ title: "Other angle", angle: "", why: "weaker" }],
    expected: { metric: "ctr", target: 0.1, horizon_hours: 48 },
    status: "open", created_at: "2026-09-14T00:00:00.000Z",
  };
}

/** Hand-writes a `committed` `ChannelPackage`, mirroring what `build-package` would have committed -- this
 * file is about the CLI commands that read/write jobs, not the pipeline that normally produces them. */
function seedPackage(ctx: AppContext, o: { channelId: string; episodeNo: number; title: string }): ChannelPackage {
  const now = ctx.clock.now();
  const channel = ctx.channels.get(o.channelId);
  const pkg: ChannelPackage = {
    schema_version: "harness.channel-package/v1", package_id: newId("channel_package"), channel_id: o.channelId,
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

/** Hand-writes a `PublicationJob` directly in `o.state` (`insertPublicationJob` does not enforce the
 * transition machine -- only `transitionPublication`/`updatePublicationJob` do), per the brief. */
function seedJob(ctx: AppContext, pkg: ChannelPackage, o: { state: PublicationJob["state"]; videoId?: string; scheduledAt?: string }): PublicationJob {
  const now = ctx.clock.now();
  const job: PublicationJob = {
    schema_version: "harness.publication-job/v1", publication_job_id: newId("publication_job"), package_id: pkg.package_id,
    channel_id: pkg.channel_id, library_item_id: pkg.library_item_id, run_id: pkg.run_id,
    idempotency_key: "sha256:" + createHash("sha256").update(pkg.package_id).digest("hex"),
    state: o.state, youtube_video_id: o.videoId ?? null, operation_id: null, scheduled_at: o.scheduledAt ?? null,
    published_at: null, last_verified_at: null, note: null, receipt: null, created_at: now, updated_at: now,
  };
  ctx.store.insertPublicationJob(job);
  return job;
}

describe("harness channel / publish / skills commands", () => {
  let world: { project: string; repoC1: string; repoC2: string };

  beforeAll(() => {
    const project = mkdtempSync(join(tmpdir(), "chanpub-"));
    writeMinimalProjectYaml(project, { projectId: "project-chanpub", adapters: { publisher: "playwright", agent: "fake" }, verifyGraceHours: 0 });
    const repoC1 = setupChannelRepo();
    const repoC2 = setupChannelRepo();
    addChannel(project, "c1", repoC1);
    addChannel(project, "c2", repoC2);
    migrate(project);
    world = { project, repoC1, repoC2 };
  });

  it("channel list --json lists both channels", () => {
    const r = cli(world.project, ["channel", "list", "--json"]);
    expect(r.code, r.err).toBe(0);
    const rows = JSON.parse(r.out) as { channel_id: string; display_name: string; publish_times: string[]; timezone: string; episode_next: number }[];
    expect(rows.map((row) => row.channel_id).sort()).toEqual(["c1", "c2"]);
    for (const row of rows) {
      expect(row.publish_times).toEqual(["09:00", "18:00"]);
      expect(row.timezone).toBe("Asia/Ho_Chi_Minh");
      expect(row.episode_next).toBeGreaterThanOrEqual(1);
    }
  });

  it("channel show c1 --json includes config + config_revision", () => {
    const r = cli(world.project, ["channel", "show", "c1", "--json"]);
    expect(r.code, r.err).toBe(0);
    const out = JSON.parse(r.out) as { config: { channel_id: string }; config_revision: string; jobs_by_state: Record<string, number> };
    expect(out.config.channel_id).toBe("c1");
    expect(out.config_revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.jobs_by_state).toEqual({});
  });

  describe("publication jobs (seeded directly via the store)", () => {
    let jobScheduled: PublicationJob;
    let jobPublished: PublicationJob;
    let jobNeedsReconciliation: PublicationJob;
    let lookupFile: string;

    beforeAll(() => {
      lookupFile = join(world.project, "lookup.json");
      withCtx(world.project, (ctx) => {
        const pkg1 = seedPackage(ctx, { channelId: "c1", episodeNo: 101, title: "Overdue Episode" });
        jobScheduled = seedJob(ctx, pkg1, { state: "SCHEDULED", videoId: "vid-overdue", scheduledAt: "2020-01-01T00:00:00.000Z" });

        const pkg2 = seedPackage(ctx, { channelId: "c2", episodeNo: 202, title: "Published Episode" });
        jobPublished = seedJob(ctx, pkg2, { state: "PUBLISHED", videoId: "vid-published", scheduledAt: "2020-01-01T00:00:00.000Z" });

        const pkg3 = seedPackage(ctx, { channelId: "c1", episodeNo: 103, title: "Stuck Episode" });
        jobNeedsReconciliation = seedJob(ctx, pkg3, { state: "NEEDS_RECONCILIATION", videoId: "vid-stuck" });
      });
      writeFileSync(lookupFile, JSON.stringify({
        "vid-overdue": { found: true, video_id: "vid-overdue", visibility: "public" },
        "vid-stuck": { found: true, video_id: "vid-stuck", visibility: "public" },
      }));
    });

    it("publish list --json lists all 3, and filters by --state / --channel", () => {
      const all = JSON.parse(cli(world.project, ["publish", "list", "--json"]).out) as PublicationJob[];
      expect(all).toHaveLength(3);

      const scheduledOnly = JSON.parse(cli(world.project, ["publish", "list", "--state", "SCHEDULED", "--json"]).out) as PublicationJob[];
      expect(scheduledOnly.map((j) => j.publication_job_id)).toEqual([jobScheduled.publication_job_id]);

      const c2Only = JSON.parse(cli(world.project, ["publish", "list", "--channel", "c2", "--json"]).out) as PublicationJob[];
      expect(c2Only.map((j) => j.publication_job_id)).toEqual([jobPublished.publication_job_id]);
    });

    it("publish show <job> --json includes the package title, episode_no and events", () => {
      const r = cli(world.project, ["publish", "show", jobPublished.publication_job_id, "--json"]);
      expect(r.code, r.err).toBe(0);
      const out = JSON.parse(r.out) as { job: PublicationJob; title: string | null; episode_no: number | null; events: unknown[] };
      expect(out.job.publication_job_id).toBe(jobPublished.publication_job_id);
      expect(out.title).toBe("Published Episode");
      expect(out.episode_no).toBe(202);
    });

    it("publish slots c1 --days 3 --json returns 3 increasing, distinct, future slots", () => {
      const r = cli(world.project, ["publish", "slots", "c1", "--days", "3", "--json"]);
      expect(r.code, r.err).toBe(0);
      const slots = JSON.parse(r.out) as string[];
      expect(slots).toHaveLength(3);
      const ms = slots.map((s) => Date.parse(s));
      expect(new Set(ms).size).toBe(3);
      expect(ms).toEqual([...ms].sort((a, b) => a - b));
      for (const m of ms) expect(m).toBeGreaterThan(Date.now());
    });

    it("publish cancel moves a READY job to FAILED with the note; refuses a terminal PUBLISHED job", () => {
      const jobReady = withCtx(world.project, (ctx) => {
        const pkg = seedPackage(ctx, { channelId: "c1", episodeNo: 199, title: "Cancel Me" });
        return seedJob(ctx, pkg, { state: "READY" });
      });

      const ok = cli(world.project, ["publish", "cancel", jobReady.publication_job_id, "--note", "no longer wanted", "--json"]);
      expect(ok.code, ok.err).toBe(0);
      const updated = JSON.parse(ok.out) as PublicationJob;
      expect(updated.state).toBe("FAILED");
      expect(updated.note).toBe("no longer wanted");

      const refused = cli(world.project, ["publish", "cancel", jobPublished.publication_job_id, "--note", "too late"]);
      expect(refused.code).toBe(1);
      expect(refused.err).toMatch(/^INVALID_TRANSITION:/);
      // never touched: still PUBLISHED, note untouched
      const stillPublished = withCtx(world.project, (ctx) => ctx.store.getPublicationJob(jobPublished.publication_job_id));
      expect(stillPublished?.state).toBe("PUBLISHED");
      expect(stillPublished?.note).toBeNull();
    });

    it("publish verify settles the overdue SCHEDULED job to PUBLISHED via HARNESS_PUBLISHER_LOOKUP_FILE", () => {
      const r = cli(world.project, ["publish", "verify", "--json"], { HARNESS_PUBLISHER_LOOKUP_FILE: lookupFile });
      expect(r.code, r.err).toBe(0);
      const report = JSON.parse(r.out) as { published: string[]; errors: unknown[] };
      expect(report.published).toContain(jobScheduled.publication_job_id);
      expect(report.errors).toEqual([]);
      const after = withCtx(world.project, (ctx) => ctx.store.getPublicationJob(jobScheduled.publication_job_id));
      expect(after?.state).toBe("PUBLISHED");
    });

    it("publish reconcile settles a NEEDS_RECONCILIATION job with a known video id to PUBLISHED", () => {
      const r = cli(world.project, ["publish", "reconcile", jobNeedsReconciliation.publication_job_id, "--json"], { HARNESS_PUBLISHER_LOOKUP_FILE: lookupFile });
      expect(r.code, r.err).toBe(0);
      const report = JSON.parse(r.out) as { job_id: string; from: string; to: string };
      expect(report.job_id).toBe(jobNeedsReconciliation.publication_job_id);
      expect(report.to).toBe("PUBLISHED");
      const after = withCtx(world.project, (ctx) => ctx.store.getPublicationJob(jobNeedsReconciliation.publication_job_id));
      expect(after?.state).toBe("PUBLISHED");
    });

    it("reconcile --publication <job> is equivalent to publish reconcile <job>", () => {
      const job = withCtx(world.project, (ctx) => {
        const pkg = seedPackage(ctx, { channelId: "c1", episodeNo: 105, title: "Stuck Episode via reconcile flag" });
        return seedJob(ctx, pkg, { state: "NEEDS_RECONCILIATION", videoId: "vid-stuck-flag" });
      });
      writeFileSync(lookupFile, JSON.stringify({ "vid-stuck-flag": { found: true, video_id: "vid-stuck-flag", visibility: "public" } }));

      const r = cli(world.project, ["reconcile", "--publication", job.publication_job_id, "--json"], { HARNESS_PUBLISHER_LOOKUP_FILE: lookupFile });
      expect(r.code, r.err).toBe(0);
      const report = JSON.parse(r.out) as { job_id: string; from: string; to: string };
      expect(report).toMatchObject({ job_id: job.publication_job_id, from: "NEEDS_RECONCILIATION", to: "PUBLISHED" });
      const after = withCtx(world.project, (ctx) => ctx.store.getPublicationJob(job.publication_job_id));
      expect(after?.state).toBe("PUBLISHED");
    });

    it("channel hypotheses c1 --json lists hypotheses from c1's committed packages only", () => {
      const r = cli(world.project, ["channel", "hypotheses", "c1", "--json"]);
      expect(r.code, r.err).toBe(0);
      const rows = JSON.parse(r.out) as { hypothesis_id: string; episode_no: number; title: string; status: string }[];
      expect(rows.some((row) => row.episode_no === 101 && row.title === "Overdue Episode")).toBe(true);
      expect(rows.every((row) => row.hypothesis_id.startsWith("hyp_"))).toBe(true);
      expect(rows.some((row) => row.episode_no === 202)).toBe(false); // c2's package must never leak into c1's list
    });
  });

  it("skills sync copies skills/channel-package into .claude/skills and .agents/skills", () => {
    const r = cli(world.project, ["skills", "sync", "--json"]);
    expect(r.code, r.err).toBe(0);
    const names = JSON.parse(r.out) as string[];
    expect(names).toContain("channel-package");
    expect(existsSync(join(world.project, ".claude", "skills", "channel-package", "SKILL.md"))).toBe(true);
    expect(existsSync(join(world.project, ".agents", "skills", "channel-package", "SKILL.md"))).toBe(true);
  });
});

describe("channel list / doctor on a project with no (then a broken) channels/", () => {
  let project: string;

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), "chanpub-empty-"));
    writeMinimalProjectYaml(project, { projectId: "project-nochan" });
    migrate(project);
  });

  it("channel list on a project with no channels/ directory is [] and exits 0", () => {
    const r = cli(project, ["channel", "list", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  it("a broken channels/bad/channel.yaml fails channel list with CONFIG_INVALID, but doctor still runs and fails channels:config", () => {
    mkdirSync(join(project, "channels", "bad"), { recursive: true });
    // missing every field but schema_version -> ChannelConfigSchema.safeParse fails -> CONFIG_INVALID
    writeFileSync(join(project, "channels", "bad", "channel.yaml"), "schema_version: harness.channel-config/v1\n");

    const list = cli(project, ["channel", "list", "--json"]);
    expect(list.code).toBe(1);
    expect(list.err).toMatch(/^CONFIG_INVALID:/);

    const doctor = cli(project, ["doctor", "--json"]);
    const rows = JSON.parse(doctor.out) as { check: string; ok: boolean }[];
    const channelsConfig = rows.find((row) => row.check === "channels:config");
    expect(channelsConfig).toBeDefined();
    expect(channelsConfig?.ok).toBe(false);
    expect(rows.some((row) => row.check.startsWith("channel:"))).toBe(false);
  });
});
