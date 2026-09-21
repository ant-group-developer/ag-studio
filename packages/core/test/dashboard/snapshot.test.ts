import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChannelConfigSchema, ChannelPackageSchema, EditStyleSchema, ContentRequestSchema, LibraryItemSchema, PublicationJobSchema,
  newId, type ChannelPackage, type PublicationJob,
} from "@harness/contracts";
import { buildSnapshot, canonicalDigest, FixedClock, HARNESS_ROOT, LibraryFs, writeSnapshotFile, type LoadedChannel } from "../../src/index.js";
import { openTempStore, seedStage } from "../helpers.js";

const LEGACY_REPO_FIXTURE = join(HARNESS_ROOT, "fixtures", "legacy-channel-repo");
const SHA = "sha256:" + "a".repeat(64);

function setupChannelRepo(withProfile: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-repo-"));
  cpSync(LEGACY_REPO_FIXTURE, dir, { recursive: true });
  if (!withProfile) rmSync(join(dir, ".upload-profile"), { recursive: true, force: true });
  return dir;
}

function makeChannel(id: string, repoDir: string, o: { maxDaily?: number; timezone?: string } = {}): LoadedChannel {
  const config = ChannelConfigSchema.parse({
    schema_version: "harness.channel-config/v1",
    channel_id: id,
    display_name: `Channel ${id}`,
    portfolio_id: "portfolio-main",
    repo_dir: repoDir.split("\\").join("/"),
    legacy_project_id: "project-01",
    youtube: { expected_channel_id: `UC${id}`, account_email_ref: `secret://youtube-${id}/email` },
    publication: { timezone: o.timezone ?? "Asia/Ho_Chi_Minh", publish_times: ["09:00", "18:00"], max_daily_uploads: o.maxDaily ?? 1, min_gap_hours: 1 },
  });
  return { config, dir: repoDir, config_revision: canonicalDigest(config) };
}

const SAMPLE_HYPOTHESIS = {
  schema_version: "harness.hypothesis/v1" as const,
  hypothesis_id: newId("hypothesis"),
  basis: [{ kind: "market" as const, note: "competitors post at 9am" }],
  chosen: { title: "Why This Works", thumbnail_candidate: "candidate-1.png" },
  rejected: [{ title: "Alt Title", why: "weaker hook" }],
  expected: { metric: "ctr" as const, target: 0.05, horizon_hours: 72 },
  created_at: "2026-09-14T00:00:00.000Z",
};

function makePackage(o: { channelId: string; episodeNo: number; title: string; configRevision: string }): ChannelPackage {
  return ChannelPackageSchema.parse({
    schema_version: "harness.channel-package/v1", package_id: newId("channel_package"), channel_id: o.channelId,
    variant_id: newId("content_variant"), content_id: newId("content_item"), library_item_id: newId("library_item"), run_id: newId("run"),
    episode_no: o.episodeNo, episode_dir: `episode-${o.episodeNo}`, manifest_digest: SHA,
    video_artifact_id: newId("artifact"), thumbnail_artifact_id: newId("artifact"), video_checksum: SHA, thumbnail_checksum: SHA,
    metadata: { title: o.title }, hypothesis: SAMPLE_HYPOTHESIS, metadata_revision: 1, channel_config_revision: o.configRevision,
    status: "committed", created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  });
}

let jobKeySeq = 0;
const nextIdempotencyKey = (): string => "sha256:" + (++jobKeySeq).toString(16).padStart(64, "0");

function makeJob(pkg: ChannelPackage, o: { state: PublicationJob["state"]; scheduledAt?: string | null; publishedAt?: string | null; videoId?: string | null }): PublicationJob {
  return PublicationJobSchema.parse({
    schema_version: "harness.publication-job/v1", publication_job_id: newId("publication_job"), package_id: pkg.package_id,
    channel_id: pkg.channel_id, library_item_id: pkg.library_item_id, run_id: pkg.run_id,
    // unique per job: `publication_job.idempotency_key` is uniquely indexed for every non-FAILED row.
    idempotency_key: nextIdempotencyKey(), state: o.state,
    youtube_video_id: o.videoId ?? null, operation_id: null, scheduled_at: o.scheduledAt ?? null, published_at: o.publishedAt ?? null,
    last_verified_at: null, note: null, receipt: null, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  });
}

// 2026-09-15 20:00 Asia/Ho_Chi_Minh (UTC+7, no DST) -- after the channel's last publish slot (18:00) that day.
const NOW = "2026-09-15T13:00:00.000Z";

describe("buildSnapshot", () => {
  it("builds channels/episodes/alerts per §6.1 and reflects per-channel .upload-profile presence", () => {
    const { store } = openTempStore();
    const clock = new FixedClock(NOW);

    const repoWithProfile = setupChannelRepo(true);
    const repoWithoutProfile = setupChannelRepo(false);
    const c1 = makeChannel("c1", repoWithProfile);
    const c2 = makeChannel("c2", repoWithoutProfile);

    const pkgToday = makePackage({ channelId: "c1", episodeNo: 1, title: "Today's Episode", configRevision: c1.config_revision });
    const jobToday = makeJob(pkgToday, { state: "SCHEDULED", scheduledAt: "2026-09-15T02:00:00.000Z" }); // 09:00 local, today
    store.insertChannelPackage(pkgToday);
    store.insertPublicationJob(jobToday);

    const pkgYesterday = makePackage({ channelId: "c1", episodeNo: 2, title: "Yesterday's Episode", configRevision: c1.config_revision });
    const jobYesterday = makeJob(pkgYesterday, { state: "PUBLISHED", publishedAt: "2026-09-14T02:00:00.000Z" }); // 09:00 local, yesterday
    store.insertChannelPackage(pkgYesterday);
    store.insertPublicationJob(jobYesterday);

    const pkgStuck = makePackage({ channelId: "c2", episodeNo: 1, title: "Stuck Episode", configRevision: c2.config_revision });
    const jobStuck = makeJob(pkgStuck, { state: "NEEDS_RECONCILIATION", videoId: "vid-stuck" });
    store.insertChannelPackage(pkgStuck);
    store.insertPublicationJob(jobStuck);

    const snapshot = buildSnapshot({
      store, channels: [c1, c2], clock, gateWindowSeconds: 600, project_id: "project-snap",
      doctorRows: [{ check: "ffprobe", ok: false, detail: "ffprobe not found on PATH" }],
    });

    expect(snapshot.schema_version).toBe("harness.dashboard-snapshot/v1");
    expect(snapshot.project_id).toBe("project-snap");
    expect(snapshot.library).toBeNull();

    expect(snapshot.channels[0]!.channel_id).toBe("c1");
    expect(snapshot.channels[0]!.today.published).toBe(1);
    expect(snapshot.channels[0]!.login.profile_dir_exists).toBe(true);
    expect(snapshot.channels[1]!.login.profile_dir_exists).toBe(false);

    expect(snapshot.episodes).toHaveLength(3);
    for (const ep of snapshot.episodes) expect(ep.package.thumbnail).toMatch(/^thumbnails\/pkg_[A-Za-z0-9]+\.png$/);

    const reconcileAlert = snapshot.alerts.find((a) => a.kind === "reconcile");
    expect(reconcileAlert?.ref).toBe(jobStuck.publication_job_id);

    const missingTodayAlert = snapshot.alerts.find((a) => a.kind === "missing_today" && a.channel_id === "c2");
    expect(missingTodayAlert).toBeDefined();
    // c1 already met its target for today -- must not also get a missing_today alert
    expect(snapshot.alerts.some((a) => a.kind === "missing_today" && a.channel_id === "c1")).toBe(false);

    const doctorAlert = snapshot.alerts.find((a) => a.kind === "doctor");
    expect(doctorAlert?.ref).toBe("ffprobe");
  });

  it("isolates a channel with an invalid timezone: the good channel is unaffected and the bad one gets a doctor alert instead of aborting the snapshot", () => {
    const { store } = openTempStore();
    const clock = new FixedClock(NOW);

    const goodRepo = setupChannelRepo(true);
    const badRepo = setupChannelRepo(true);
    const good = makeChannel("good", goodRepo);
    // `ChannelConfigSchema.publication.timezone` is only `z.string().min(1)` -- never validated against the
    // IANA timezone database -- so this is a legal config that still crashes `Intl.DateTimeFormat` deep
    // inside `localDate`/`zonedToUtc` with a `RangeError` the moment `buildChannel` touches it.
    const bad = makeChannel("bad", badRepo, { timezone: "Not/AZone" });

    const pkgGood = makePackage({ channelId: "good", episodeNo: 1, title: "Good Episode", configRevision: good.config_revision });
    const jobGood = makeJob(pkgGood, { state: "SCHEDULED", scheduledAt: "2026-09-15T02:00:00.000Z" }); // 09:00 local, today
    store.insertChannelPackage(pkgGood);
    store.insertPublicationJob(jobGood);

    const pkgBad = makePackage({ channelId: "bad", episodeNo: 1, title: "Bad Episode", configRevision: bad.config_revision });
    store.insertChannelPackage(pkgBad);
    store.insertPublicationJob(makeJob(pkgBad, { state: "SCHEDULED", scheduledAt: "2026-09-15T02:00:00.000Z" }));

    const snapshot = buildSnapshot({ store, channels: [good, bad], clock, gateWindowSeconds: 600, project_id: "project-snap" });

    // the whole snapshot still builds
    expect(snapshot.channels).toHaveLength(2);

    const goodChannel = snapshot.channels.find((c) => c.channel_id === "good");
    expect(goodChannel?.today.published).toBe(1);

    const badChannel = snapshot.channels.find((c) => c.channel_id === "bad");
    expect(badChannel).toEqual({
      channel_id: "bad", display_name: "Channel bad", color: "#5b8cff", publish_times: ["09:00", "18:00"],
      timezone: "Not/AZone", language: "en", today: { published: 0, target: 1 },
      login: { profile_dir_exists: true, last_upload_ok_at: null }, latest: null, episodes_count: 0, doctor: [],
      learning: { hypotheses: { open: 0, supported: 0, refuted: 0, void: 0 }, last_collect_at: null, standard: null, metric: null, demand: null },
    });

    const doctorAlert = snapshot.alerts.find((a) => a.kind === "doctor" && a.channel_id === "bad");
    expect(doctorAlert?.ref).toBe("channel:bad:snapshot");
    expect(doctorAlert?.message).toBeTruthy();

    // the bad channel must not also blow up the missing_today check downstream
    expect(snapshot.alerts.some((a) => a.kind === "missing_today" && a.channel_id === "bad")).toBe(false);
  });

  it("reports library counts and mounted state from the DB mirror + LibraryFs.exists()", () => {
    const { store } = openTempStore();
    const clock = new FixedClock(NOW);
    const libRoot = mkdtempSync(join(tmpdir(), "snapshot-lib-"));
    const fs = new LibraryFs({ root: libRoot, role: "channel" });
    const styleId = newId("edit_style");

    store.upsertEditStyle(EditStyleSchema.parse({
      schema_version: "harness.edit-style/v1", style_id: styleId, revision: 1, name: "Style A", status: "active",
      params: {
        cut_rhythm: "fast", shot_seconds: [1, 3], text_overlay: { style: "bold", density: "medium" }, subtitles: "burn-in",
        music: { mood: "upbeat", ducking: true }, opening: { seconds: 2, structure: "hook" }, aspect_ratio: "16:9",
      },
      created_at: NOW, updated_at: NOW,
    }));
    store.upsertContentRequest(ContentRequestSchema.parse({
      schema_version: "harness.content-request/v1", request_id: newId("content_request"), requested_by: { portfolio_id: "portfolio-main" },
      topic: "topic", status: "open", created_at: NOW, updated_at: NOW,
    }));
    store.upsertLibraryItem(LibraryItemSchema.parse({
      schema_version: "harness.library-item/v1", item_id: newId("library_item"), status: "approved",
      style: { style_id: styleId, revision: 1 }, duration_seconds: 5, media: null,
      files: [{ path: "episode.mp4", checksum: SHA, size_bytes: 10, mime_type: "video/mp4" }],
      lineage: { project_id: "project-studio", run_id: newId("run"), content_id: newId("content_item"), source_ids: [] },
      created_at: NOW, updated_at: NOW,
    }));

    const snapshot = buildSnapshot({ store, channels: [], library: { fs, role: "channel" }, clock, gateWindowSeconds: 600, project_id: "project-snap" });
    expect(snapshot.library).toEqual({
      root: libRoot.split("\\").join("/"), mounted: true, styles_active: 1, requests_open: 1,
      items: { pending_review: 0, approved: 1, rejected: 0, withdrawn: 0 },
    });

    rmSync(libRoot, { recursive: true, force: true });
    const unmounted = buildSnapshot({ store, channels: [], library: { fs, role: "channel" }, clock, gateWindowSeconds: 600, project_id: "project-snap" });
    expect(unmounted.library?.mounted).toBe(false);
    expect(unmounted.alerts.some((a) => a.kind === "library_unmounted")).toBe(true);
  });

  it("alerts request_stuck for an open request whose finished runs exceed autoAccept.max_replans", () => {
    const { store, clock } = openTempStore();
    const libRoot = mkdtempSync(join(tmpdir(), "snapshot-lib-stuck-"));
    const fs = new LibraryFs({ root: libRoot, role: "studio" });
    const requestId = newId("content_request");
    const contentId = newId("content_item");

    store.upsertContentRequest(ContentRequestSchema.parse({
      schema_version: "harness.content-request/v1", request_id: requestId, requested_by: { portfolio_id: "portfolio-main" },
      topic: "topic", status: "open", created_at: clock.now(), updated_at: clock.now(),
    }));
    store.insertContentItem({
      schema_version: "harness.content-item/v1", content_id: contentId, source_ids: [], revision: 1, title: "topic", created_at: clock.now(),
      library_brief: { topic: "topic", style_id: newId("edit_style"), style_revision: 1, voice: "none", language: "vi", request_id: requestId },
    });
    for (const state of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
      store.insertRun({
        schema_version: "harness.run/v1", run_id: newId("run"), project_id: "project-snap", portfolio_id: "portfolio-main",
        workflow_release: { id: "library-production", version: "1.0.0", digest: SHA }, profile_snapshot: { id: "studio", revision: 1 },
        content_id: contentId, options: {}, state, effective_config_snapshot: {}, effective_config_digest: SHA, total_cost_usd: 0,
        created_at: clock.now(), updated_at: clock.now(),
      });
    }

    const autoAccept = { enabled: true, source_collection: "main", max_replans: 2, max_concurrent_runs: 1 };

    const withoutAutoAccept = buildSnapshot({ store, channels: [], library: { fs, role: "studio" }, clock, gateWindowSeconds: 600, project_id: "project-snap" });
    expect(withoutAutoAccept.alerts.some((a) => a.kind === "request_stuck")).toBe(false);

    // final-review bundled minor (h): the alert only means something where the loop actually runs -- the same
    // `role === "studio" && enabled` condition the worker builds `AutoAcceptDeps` on
    const disabled = buildSnapshot({
      store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap",
      library: { fs, role: "studio", autoAccept: { ...autoAccept, enabled: false } },
    });
    expect(disabled.alerts.some((a) => a.kind === "request_stuck")).toBe(false);

    const channelRole = buildSnapshot({
      store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap",
      library: { fs, role: "channel", autoAccept },
    });
    expect(channelRole.alerts.some((a) => a.kind === "request_stuck")).toBe(false);

    const snapshot = buildSnapshot({
      store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap",
      library: { fs, role: "studio", autoAccept },
    });
    const alert = snapshot.alerts.find((a) => a.kind === "request_stuck");
    expect(alert).toMatchObject({ kind: "request_stuck", ref: requestId });
  });

  // Final-review finding I-5: an agent stage that fails `contract` is never retried and parks at
  // WAITING_HUMAN forever. `gateOverdue` only ever looked at `gate` executors with a deadline, and
  // `request_stuck` only at open requests, so nothing on the dashboard said anything about it.
  it("alerts stage_waiting_human for any parked stage on a live run, with the last attempt's failure, and not for a terminal run", () => {
    const { store, clock } = openTempStore();

    const { runId, stage } = seedStage(store, { key: "survey-source", state: "WAITING_HUMAN" });
    store.insertAttempt({
      schema_version: "harness.attempt/v1", attempt_id: newId("attempt"), stage_run_id: stage.stage_run_id, run_id: runId,
      lease_owner: "worker-1", fencing_token: 1, state: "FAILED", started_at: clock.now(), finished_at: clock.now(),
      failure_kind: "contract", error_summary: "agent wrote no output/survey.md", created_at: clock.now(), updated_at: clock.now(),
    });

    // a second run that already finished: its parked stage must not raise anything
    const doneRunId = newId("run");
    store.insertRun({
      schema_version: "harness.run/v1", run_id: doneRunId, project_id: "project-snap", portfolio_id: "portfolio-main",
      workflow_release: { id: "library-production", version: "1.1.0", digest: SHA }, profile_snapshot: { id: "studio", revision: 1 },
      options: {}, state: "CANCELLED", effective_config_snapshot: {}, effective_config_digest: SHA, total_cost_usd: 0,
      created_at: clock.now(), updated_at: clock.now(),
    });
    seedStage(store, { key: "plan-edit", state: "WAITING_HUMAN", runId: doneRunId });

    const snapshot = buildSnapshot({ store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap" });
    const parked = snapshot.alerts.filter((a) => a.kind === "stage_waiting_human");
    expect(parked).toHaveLength(1);
    expect(parked[0]!.ref).toBe(stage.stage_run_id);
    expect(parked[0]!.message).toContain("survey-source");
    expect(parked[0]!.message).toContain(runId);
    expect(parked[0]!.message).toContain("agent wrote no output/survey.md");
  });

  describe("learning block and alerts (sub-project 3B, Task 6)", () => {
    it("counts hypothesis statuses, reports the newest stats.collected timestamp and the learned standard/metric, and leaves demand null when planning is disabled", () => {
      const { store } = openTempStore();
      const clock = new FixedClock(NOW);
      const repo = setupChannelRepo(true);
      const c1 = makeChannel("c1", repo);

      const pkgOpen = makePackage({ channelId: "c1", episodeNo: 1, title: "Open", configRevision: c1.config_revision });
      const pkgSupported = { ...makePackage({ channelId: "c1", episodeNo: 2, title: "Supported", configRevision: c1.config_revision }), hypothesis: { ...SAMPLE_HYPOTHESIS, status: "supported" as const } };
      const pkgRefuted = { ...makePackage({ channelId: "c1", episodeNo: 3, title: "Refuted", configRevision: c1.config_revision }), hypothesis: { ...SAMPLE_HYPOTHESIS, status: "refuted" as const } };
      for (const pkg of [pkgOpen, pkgSupported, pkgRefuted]) store.insertChannelPackage(pkg);
      const job = makeJob(pkgSupported, { state: "PUBLISHED", publishedAt: "2026-09-10T00:00:00.000Z", videoId: "vid1" });
      store.insertPublicationJob(job);

      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: "c1",
        content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "stats.collected",
        payload: { job_id: job.publication_job_id, metric_id: "metric_1" },
      });

      store.upsertChannelLearned({
        schema_version: "harness.channel-learned/v1", channel_id: "c1", updated_at: NOW, sample_size: 2, metric: "ctr",
        medians: { views_72h: 100, ctr_pct: 5, avg_view_pct: null },
        winners: { angles: [], title_patterns: [], overlay: [] },
        standard: { angle: "flycam", note: "" }, history: [],
      });

      const snapshot = buildSnapshot({ store, channels: [c1], clock, gateWindowSeconds: 600, project_id: "project-snap" });
      const learning = snapshot.channels[0]!.learning;
      expect(learning.hypotheses).toEqual({ open: 1, supported: 1, refuted: 1, void: 0 });
      expect(learning.last_collect_at).not.toBeNull();
      expect(learning.standard).toEqual({ angle: "flycam", note: "" });
      expect(learning.metric).toBe("ctr");
      expect(learning.demand).toBeNull(); // planning.enabled defaults to false
    });

    // Final-review finding (sub-project 3B Task 6): `newestChannelEvent` used to fetch the newest `event_type`
    // rows across *every* channel (`listEvents({ event_type, newest: true })`, default `limit: 1000`) and
    // filter by `channel_id` in JS -- so a quiet channel's own newest event of that type could be pushed out
    // of that shared window by a busier sibling channel, well before the quiet channel itself accumulated
    // anywhere near 1000 events. Fixed by a store-level `channel_id` filter (`listEvents({ channel_id })`,
    // `packages/core/src/state/sqlite-store.ts`) that `newestChannelEvent` now uses with `limit: 1`.
    it("last_collect_at survives a busier sibling channel emitting more stats.collected events than the store's default newest-window limit", () => {
      const { store, clock } = openTempStore();
      const repo = setupChannelRepo(true);
      const quiet = makeChannel("quiet", repo);
      const busy = makeChannel("busy", repo);

      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: "quiet",
        content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "stats.collected",
        payload: { job_id: "quiet-job", metric_id: "metric_quiet" },
      });
      clock.advance(1);

      // more than `listEvents`'s default limit (1000) of matching-type events, all on the sibling channel.
      for (let i = 0; i < 1005; i++) {
        store.appendEvent({
          run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: "busy",
          content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "stats.collected",
          payload: { job_id: `busy-job-${i}`, metric_id: `metric_busy_${i}` },
        });
        clock.advance(1);
      }

      const snapshot = buildSnapshot({ store, channels: [quiet, busy], clock, gateWindowSeconds: 600, project_id: "project-snap" });
      const quietChannel = snapshot.channels.find((c) => c.channel_id === "quiet")!;
      expect(quietChannel.learning.last_collect_at).not.toBeNull(); // used to be null: pushed out by "busy"'s 1005 events
    });

    it("stats_blocked clears once a channel's own later stats.collected exists, even when a busier sibling channel's events would otherwise push it out of a shared window", () => {
      const { store, clock } = openTempStore();
      const repo = setupChannelRepo(true);
      const quiet = makeChannel("quiet", repo);
      const busy = makeChannel("busy", repo);

      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: "quiet",
        content_id: null, variant_id: null, workflow_release: null, severity: "warn", event_type: "stats.blocked",
        payload: { channel_id: "quiet", reason: "verify-it's-you" },
      });
      clock.advance(1);
      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: "quiet",
        content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "stats.collected",
        payload: { job_id: "quiet-job", metric_id: "metric_quiet" },
      });
      clock.advance(1);

      for (let i = 0; i < 1005; i++) {
        store.appendEvent({
          run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: "busy",
          content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "stats.collected",
          payload: { job_id: `busy-job-${i}`, metric_id: `metric_busy_${i}` },
        });
        clock.advance(1);
      }

      const snapshot = buildSnapshot({ store, channels: [quiet, busy], clock, gateWindowSeconds: 600, project_id: "project-snap" });
      // used to stay up forever on a busy multi-channel project: the "quiet" channel's own later stats.collected
      // was pushed out of the shared newest-1000 window by "busy"'s 1005 events.
      expect(snapshot.alerts.some((a) => a.kind === "stats_blocked" && a.channel_id === "quiet")).toBe(false);
    });

    it("computes demand only when planning.enabled and SnapshotDeps.learning (library access) are both present", () => {
      const { store } = openTempStore();
      const clock = new FixedClock(NOW);
      const repo = setupChannelRepo(true);
      const c1 = makeChannel("c1", repo);
      (c1.config.planning as { enabled: boolean }).enabled = true;

      const noLibrary = buildSnapshot({ store, channels: [c1], clock, gateWindowSeconds: 600, project_id: "project-snap" });
      expect(noLibrary.channels[0]!.learning.demand).toBeNull();

      const withLibrary = buildSnapshot({
        store, channels: [c1], clock, gateWindowSeconds: 600, project_id: "project-snap",
        learning: { libraryItems: [], libraryClaimsOf: () => [] },
      });
      expect(withLibrary.channels[0]!.learning.demand).toEqual({ needed: c1.config.planning.lookahead_slots, open_requests: 0 });
    });

    it("alerts stats_blocked for a channel with a stats.blocked event in the last 24h and no later stats.collected, and clears once a fresh collect succeeds", () => {
      const { store, clock } = openTempStore();
      const repo = setupChannelRepo(true);
      const c1 = makeChannel("c1", repo);

      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: "c1",
        content_id: null, variant_id: null, workflow_release: null, severity: "warn", event_type: "stats.blocked",
        payload: { channel_id: "c1", reason: "verify-it's-you" },
      });

      const blocked = buildSnapshot({ store, channels: [c1], clock, gateWindowSeconds: 600, project_id: "project-snap" });
      const alert = blocked.alerts.find((a) => a.kind === "stats_blocked" && a.channel_id === "c1");
      expect(alert).toBeDefined();
      expect(alert?.message).toContain("verify-it's-you");

      clock.advance(10);
      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: "c1",
        content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "stats.collected",
        payload: { job_id: "publication_job_x", metric_id: "metric_x" },
      });
      const cleared = buildSnapshot({ store, channels: [c1], clock, gateWindowSeconds: 600, project_id: "project-snap" });
      expect(cleared.alerts.some((a) => a.kind === "stats_blocked" && a.channel_id === "c1")).toBe(false);
    });

    it("alerts stats_failing for any PUBLISHED job whose receipt.collect_failures has reached 3", () => {
      const { store, clock } = openTempStore();
      const repo = setupChannelRepo(true);
      const c1 = makeChannel("c1", repo);
      const pkg = makePackage({ channelId: "c1", episodeNo: 1, title: "Ep 1", configRevision: c1.config_revision });
      store.insertChannelPackage(pkg);
      const job = makeJob(pkg, { state: "PUBLISHED", publishedAt: "2026-09-10T00:00:00.000Z", videoId: "vid1" });
      store.insertPublicationJob(job);
      store.updatePublicationJob({ ...job, receipt: { collect_failures: 3 } });

      const snapshot = buildSnapshot({ store, channels: [c1], clock, gateWindowSeconds: 600, project_id: "project-snap" });
      const alert = snapshot.alerts.find((a) => a.kind === "stats_failing");
      expect(alert).toMatchObject({ kind: "stats_failing", channel_id: "c1", ref: job.publication_job_id });

      store.updatePublicationJob({ ...job, receipt: { collect_failures: 2 } });
      const belowThreshold = buildSnapshot({ store, channels: [c1], clock, gateWindowSeconds: 600, project_id: "project-snap" });
      expect(belowThreshold.alerts.some((a) => a.kind === "stats_failing")).toBe(false);
    });

    it("alerts planning_failed for a channel.planning_failed event within the last 24h", () => {
      const { store, clock } = openTempStore();
      const repo = setupChannelRepo(true);
      const c1 = makeChannel("c1", repo);
      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: "c1",
        content_id: null, variant_id: null, workflow_release: null, severity: "error", event_type: "channel.planning_failed",
        payload: { channel_id: "c1", reason: "no active edit style available" },
      });

      const snapshot = buildSnapshot({ store, channels: [c1], clock, gateWindowSeconds: 600, project_id: "project-snap" });
      const alert = snapshot.alerts.find((a) => a.kind === "planning_failed" && a.channel_id === "c1");
      expect(alert?.message).toContain("no active edit style available");
    });
  });
});

describe("media block and media_engine_unavailable alert (sub-project 5A, Task 9)", () => {
  it("media is null unless the project declares library with role \"studio\"", () => {
    const { store, clock } = openTempStore();
    const noLibrary = buildSnapshot({ store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap" });
    expect(noLibrary.media).toBeNull();

    const libRoot = mkdtempSync(join(tmpdir(), "snapshot-media-channel-"));
    const channelRole = buildSnapshot({
      store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap", media: { engine: "python" },
      library: { fs: new LibraryFs({ root: libRoot, role: "channel" }), role: "channel" },
    });
    expect(channelRole.media).toBeNull();
  });

  it("reports the configured engine, the newest media.tts_done timestamp, and Σcached/Σlines", () => {
    const { store, clock } = openTempStore();
    const libRoot = mkdtempSync(join(tmpdir(), "snapshot-media-studio-"));
    const library = { fs: new LibraryFs({ root: libRoot, role: "studio" as const }), role: "studio" as const };

    const noEvents = buildSnapshot({ store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap", library, media: { engine: "python" } });
    expect(noEvents.media).toEqual({ engine: "python", last_tts_at: null, cache_hit_ratio: null });

    const appendTts = (lines: number, cached: number): void => {
      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: null,
        content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "media.tts_done",
        payload: { run_id: "run_1", lines, cached, seconds: 10 },
      });
      clock.advance(1);
    };
    appendTts(10, 4);
    appendTts(10, 8); // newest -- last_tts_at should reflect this one

    const snapshot = buildSnapshot({ store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap", library, media: { engine: "python" } });
    expect(snapshot.media?.engine).toBe("python");
    expect(snapshot.media?.last_tts_at).not.toBeNull();
    expect(snapshot.media?.cache_hit_ratio).toBeCloseTo((4 + 8) / (10 + 10));
  });

  it("caps the ratio window at the newest 20 media.tts_done events, ignoring older ones", () => {
    const { store, clock } = openTempStore();
    const libRoot = mkdtempSync(join(tmpdir(), "snapshot-media-window-"));
    const library = { fs: new LibraryFs({ root: libRoot, role: "studio" as const }), role: "studio" as const };

    const appendTts = (lines: number, cached: number): void => {
      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: null,
        content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "media.tts_done",
        payload: { run_id: "run_old", lines, cached, seconds: 1 },
      });
      clock.advance(1);
    };
    // 5 old events with a 0/10 ratio, then 20 newer events with a perfect 10/10 ratio -- only the newest 20
    // may count, or the ratio would be pulled down by the old ones.
    for (let i = 0; i < 5; i++) appendTts(10, 0);
    for (let i = 0; i < 20; i++) appendTts(10, 10);

    const snapshot = buildSnapshot({ store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap", library, media: { engine: "python" } });
    expect(snapshot.media?.cache_hit_ratio).toBe(1);
  });

  // Fix round (coordinator review, adjacent finding): media.tts_done fires for every run, including
  // voice:none/voice:original ones with lines: 0. A naive "newest 20 events" window can be entirely zero-line
  // ones on a project that mixes tts and non-tts episodes, nulling the ratio and last_tts_at even though real
  // tts work happened not long before.
  it("ignores interleaved zero-line media.tts_done events for both cache_hit_ratio and last_tts_at", () => {
    const { store, clock } = openTempStore();
    const libRoot = mkdtempSync(join(tmpdir(), "snapshot-media-interleaved-"));
    const library = { fs: new LibraryFs({ root: libRoot, role: "studio" as const }), role: "studio" as const };

    const appendTts = (lines: number, cached: number): void => {
      store.appendEvent({
        run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: null,
        content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "media.tts_done",
        payload: { run_id: "run_x", lines, cached, seconds: 1 },
      });
      clock.advance(1);
    };

    appendTts(10, 5); // real tts, oldest
    appendTts(0, 0); // voice: none/original in between
    let lastRealAt: string | undefined;
    appendTts(10, 10); // real tts, newest
    lastRealAt = store.listEvents({ event_type: "media.tts_done", newest: true, limit: 1 })[0]!.occurred_at;
    // 25 more voice:none/original runs after the last real tts -- more than the naive 20-event window, so a
    // window keyed on raw event recency (not filtered by lines > 0 first) would see only these and conclude
    // "no tts ever happened".
    for (let i = 0; i < 25; i++) appendTts(0, 0);

    const snapshot = buildSnapshot({ store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap", library, media: { engine: "python" } });
    expect(snapshot.media?.cache_hit_ratio).toBeCloseTo((5 + 10) / (10 + 10));
    expect(snapshot.media?.last_tts_at).toBe(lastRealAt);
  });

  it("cache_hit_ratio is null when the newest events summed to zero lines", () => {
    const { store, clock } = openTempStore();
    const libRoot = mkdtempSync(join(tmpdir(), "snapshot-media-zero-"));
    const library = { fs: new LibraryFs({ root: libRoot, role: "studio" as const }), role: "studio" as const };
    store.appendEvent({
      run_id: null, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null, channel_id: null,
      content_id: null, variant_id: null, workflow_release: null, severity: "info", event_type: "media.tts_done",
      payload: { run_id: "run_1", lines: 0, cached: 0, seconds: 0 },
    });
    const snapshot = buildSnapshot({ store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap", library, media: { engine: "fake" } });
    expect(snapshot.media?.cache_hit_ratio).toBeNull();
  });

  // Fix round (coordinator review, Important 1): a failing media:python/packages/device/engine row used to
  // raise BOTH the generic "doctor" alert (the loop over every !row.ok row) AND the specific
  // "media_engine_unavailable" one -- double alerting nothing else in this file does (channel:<id>:planning's
  // fake-agent row, for comparison, only ever gets the one generic alert). Each of these four checks now
  // raises media_engine_unavailable ONLY; media:models keeps the single generic "doctor" alert and never gets
  // media_engine_unavailable, exactly like the fake-agent warning row.
  it("a failing media:python/packages/device/engine row raises exactly one alert (media_engine_unavailable, not also doctor)", () => {
    const { store, clock } = openTempStore();
    for (const check of ["media:python", "media:packages", "media:device", "media:engine"]) {
      const snapshot = buildSnapshot({
        store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap",
        doctorRows: [{ check, ok: false, detail: `${check} detail` }],
      });
      expect(snapshot.alerts, check).toHaveLength(1);
      expect(snapshot.alerts[0], check).toMatchObject({ kind: "media_engine_unavailable", ref: check, message: `${check} detail` });
    }
  });

  it("a failing media:models row raises exactly one alert (the generic doctor one, never media_engine_unavailable)", () => {
    const { store, clock } = openTempStore();
    const snapshot = buildSnapshot({
      store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap",
      doctorRows: [{ check: "media:models", ok: false, detail: "will download on first run: whisperx" }],
    });
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]).toMatchObject({ kind: "doctor", ref: "media:models", message: "will download on first run: whisperx" });
  });
});

describe("writeSnapshotFile", () => {
  it("writes <dataRoot>/dashboard/snapshot.json atomically, leaving no .tmp files behind", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "snapshot-out-"));
    const clock = new FixedClock(NOW);
    const { store } = openTempStore();
    const snapshot = buildSnapshot({ store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap" });

    const path = writeSnapshotFile(dataRoot, snapshot);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.schema_version).toBe("harness.dashboard-snapshot/v1");

    const files = readdirSync(join(dataRoot, "dashboard"));
    expect(files).toEqual(["snapshot.json"]);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
  });
});
