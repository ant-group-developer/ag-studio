import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChannelConfigSchema, ChannelPackageSchema, EditStyleSchema, ContentRequestSchema, LibraryItemSchema, PublicationJobSchema,
  newId, type ChannelPackage, type PublicationJob,
} from "@harness/contracts";
import { buildSnapshot, canonicalDigest, FixedClock, HARNESS_ROOT, LibraryFs, writeSnapshotFile, type LoadedChannel } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

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

    const snapshot = buildSnapshot({ store, channels: [], library: { fs }, clock, gateWindowSeconds: 600, project_id: "project-snap" });
    expect(snapshot.library).toEqual({
      root: libRoot.split("\\").join("/"), mounted: true, styles_active: 1, requests_open: 1,
      items: { pending_review: 0, approved: 1, rejected: 0, withdrawn: 0 },
    });

    rmSync(libRoot, { recursive: true, force: true });
    const unmounted = buildSnapshot({ store, channels: [], library: { fs }, clock, gateWindowSeconds: 600, project_id: "project-snap" });
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

    const withoutAutoAccept = buildSnapshot({ store, channels: [], library: { fs }, clock, gateWindowSeconds: 600, project_id: "project-snap" });
    expect(withoutAutoAccept.alerts.some((a) => a.kind === "request_stuck")).toBe(false);

    const snapshot = buildSnapshot({
      store, channels: [], clock, gateWindowSeconds: 600, project_id: "project-snap",
      library: { fs, autoAccept: { enabled: true, source_collection: "main", max_replans: 2, max_concurrent_runs: 1 } },
    });
    const alert = snapshot.alerts.find((a) => a.kind === "request_stuck");
    expect(alert).toMatchObject({ kind: "request_stuck", ref: requestId });
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
