import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChannelPackage, Clock, PublicationJob, StateStore } from "@harness/contracts";
import { posixPath, type LoadedChannel } from "../distribution/channels.js";
import { localDate, zonedToUtc } from "../distribution/publication.js";
import type { DoctorRow } from "../doctor/doctor.js";
import type { LibraryFs } from "../library/files.js";
import { gateOverdue } from "../orchestration/gate.js";

/**
 * Read model for the file-based dashboard (design §6.1). Deliberately a plain TS interface, not a Zod schema:
 * this is a derived view the CLI/worker write for `packages/dashboard`'s server to read as a static file, not
 * a control-plane entity that ever goes through `transition()` or gets validated on the way into the store.
 */
export interface DashboardSnapshot {
  schema_version: "harness.dashboard-snapshot/v1";
  project_id: string;
  generated_at: string;
  library: DashboardLibrary | null;
  channels: DashboardChannel[];
  episodes: DashboardEpisode[];
  runs_active: DashboardActiveRun[];
  alerts: DashboardAlert[];
  market: Record<string, never>;
}

export interface DashboardLibrary {
  root: string;
  mounted: boolean;
  styles_active: number;
  requests_open: number;
  items: { pending_review: number; approved: number; rejected: number; withdrawn: number };
}

export interface DashboardChannelDoctorRow { row: string; status: "ok" | "warn" | "fail"; message: string }

export interface DashboardChannel {
  channel_id: string;
  display_name: string;
  color: string;
  publish_times: string[];
  timezone: string;
  language: string;
  today: { published: number; target: number };
  login: { profile_dir_exists: boolean; last_upload_ok_at: string | null };
  latest: { episode_no: number; state: string; stage_key: string | null; run_id: string } | null;
  episodes_count: number;
  doctor: DashboardChannelDoctorRow[];
}

export interface DashboardEpisode {
  job_id: string;
  channel_id: string;
  episode_no: number;
  state: string;
  scheduled_at: string | null;
  published_at: string | null;
  video_id: string | null;
  run_id: string;
  current_stage: string | null;
  package: { title: string; description: string; tags: string[]; hashtags: string[]; playlists: string[]; pinned_comment: string; thumbnail: string };
  hypothesis: { angle: string; metric: string; target: number };
}

export interface DashboardActiveRun { run_id: string; channel_id: string; stage_key: string; state: string; since: string }

export type DashboardAlertKind = "reconcile" | "run_failed" | "gate_overdue" | "doctor" | "library_unmounted" | "missing_today";
export interface DashboardAlert { kind: DashboardAlertKind; channel_id?: string; ref: string; message: string; since: string }

export interface SnapshotDeps {
  store: StateStore;
  channels: LoadedChannel[];
  library?: { fs: LibraryFs };
  doctorRows?: DoctorRow[];
  clock: Clock;
  gateWindowSeconds: number;
  /**
   * `project.yaml`'s `project_id`, stamped on `DashboardSnapshot.project_id` per design §6.1. Not part of the
   * brief's `SnapshotDeps` literal -- an obvious omission: the snapshot shape requires `project_id` and nothing
   * else in these deps could supply it (a `LoadedChannel` carries no project reference), so building a
   * snapshot without it would be impossible. Fixed here rather than flagged as a design trade-off.
   */
  project_id: string;
}

const ACTIVE_STAGE_STATES = new Set(["RUNNING", "CLAIMED", "READY"]);
const RUN_FAILED_WINDOW_MS = 7 * 24 * 3600_000;

export function buildSnapshot(d: SnapshotDeps): DashboardSnapshot {
  const now = d.clock.now();
  const doctorRows = d.doctorRows ?? [];

  const channels = d.channels.map((c) => buildChannel(d.store, c, now, doctorRows));
  const episodes = buildEpisodes(d.store, d.channels);

  return {
    schema_version: "harness.dashboard-snapshot/v1",
    project_id: d.project_id,
    generated_at: now,
    library: buildLibrary(d),
    channels,
    episodes,
    runs_active: buildRunsActive(d.store),
    alerts: buildAlerts(d, now, doctorRows, channels),
    market: {},
  };
}

function buildLibrary(d: SnapshotDeps): DashboardLibrary | null {
  const library = d.library;
  if (!library) return null;
  const items = d.store.listLibraryItems();
  const counts = { pending_review: 0, approved: 0, rejected: 0, withdrawn: 0 };
  for (const item of items) counts[item.status]++;
  return {
    root: posixPath(library.fs.paths.root),
    mounted: library.fs.exists(),
    styles_active: d.store.listEditStyles({ status: "active" }).length,
    requests_open: d.store.listContentRequests({ status: "open" }).length,
    items: counts,
  };
}

/** First stage of `runId` that is not `SUCCEEDED`, or `null` when every stage has finished -- the same
 * "what's blocking this run right now" the brief asks for both `episodes[].current_stage` and
 * `channels[].latest.stage_key`. */
function currentStage(store: StateStore, runId: string): string | null {
  const stage = store.listStageRuns(runId).find((s) => s.state !== "SUCCEEDED");
  return stage ? stage.stage_key : null;
}

function buildChannel(store: StateStore, channel: LoadedChannel, now: string, doctorRows: DoctorRow[]): DashboardChannel {
  const cfg = channel.config;
  const jobs = store.listPublicationJobs({ channel_id: cfg.channel_id });
  const today = localDate(now, cfg.publication.timezone);

  const publishedToday = jobs.filter((j) => {
    if (j.state !== "PUBLISHED" && j.state !== "SCHEDULED") return false;
    const at = j.scheduled_at ?? j.published_at;
    return at !== null && localDate(at, cfg.publication.timezone) === today;
  }).length;

  const profileDirExists = existsSync(join(resolve(cfg.repo_dir), ".upload-profile", "Default"));
  const lastUploadOkAt = jobs
    .filter((j) => j.state === "PROCESSING" || j.state === "SCHEDULED" || j.state === "PUBLISHED")
    .reduce<string | null>((max, j) => (max === null || j.updated_at > max ? j.updated_at : max), null);

  let latestPkg: ChannelPackage | undefined;
  for (const p of store.listChannelPackages({ channel_id: cfg.channel_id })) {
    if (!latestPkg || p.episode_no > latestPkg.episode_no) latestPkg = p;
  }
  let latest: DashboardChannel["latest"] = null;
  if (latestPkg) {
    const job = jobs.find((j) => j.package_id === latestPkg!.package_id);
    latest = {
      episode_no: latestPkg.episode_no,
      state: job?.state ?? latestPkg.status,
      stage_key: currentStage(store, latestPkg.run_id),
      run_id: latestPkg.run_id,
    };
  }

  const doctor: DashboardChannelDoctorRow[] = doctorRows
    .filter((r) => r.check.startsWith(`channel:${cfg.channel_id}:`))
    .map((r) => ({ row: r.check, status: r.ok ? "ok" : "fail", message: r.detail }));

  return {
    channel_id: cfg.channel_id, display_name: cfg.display_name, color: cfg.color,
    publish_times: cfg.publication.publish_times, timezone: cfg.publication.timezone, language: cfg.seo.language,
    today: { published: publishedToday, target: cfg.publication.max_daily_uploads },
    login: { profile_dir_exists: profileDirExists, last_upload_ok_at: lastUploadOkAt },
    latest,
    episodes_count: jobs.length,
    doctor,
  };
}

function buildEpisodes(store: StateStore, channels: LoadedChannel[]): DashboardEpisode[] {
  const episodes: DashboardEpisode[] = [];
  for (const channel of channels) {
    for (const job of store.listPublicationJobs({ channel_id: channel.config.channel_id })) {
      const pkg = store.getChannelPackage(job.package_id);
      if (!pkg) continue; // a job with no package left is a data problem for `doctor`, not the dashboard
      episodes.push({
        job_id: job.publication_job_id, channel_id: job.channel_id, episode_no: pkg.episode_no, state: job.state,
        scheduled_at: job.scheduled_at, published_at: job.published_at, video_id: job.youtube_video_id, run_id: job.run_id,
        current_stage: currentStage(store, job.run_id),
        package: {
          title: pkg.metadata.title, description: pkg.metadata.description, tags: pkg.metadata.tags,
          hashtags: pkg.metadata.hashtags, playlists: pkg.metadata.playlists, pinned_comment: pkg.metadata.pinned_comment,
          thumbnail: `thumbnails/${pkg.package_id}.png`,
        },
        hypothesis: { angle: pkg.hypothesis.chosen.angle, metric: pkg.hypothesis.expected.metric, target: pkg.hypothesis.expected.target },
      });
    }
  }
  return episodes;
}

function buildRunsActive(store: StateStore): DashboardActiveRun[] {
  const out: DashboardActiveRun[] = [];
  for (const run of [...store.listRuns({ state: "RUNNING" }), ...store.listRuns({ state: "WAITING" })]) {
    const stage = store.listStageRuns(run.run_id).find((s) => ACTIVE_STAGE_STATES.has(s.state));
    if (!stage) continue;
    const content = run.content_id ? store.getContentItem(run.content_id) : undefined;
    const channelId = content?.library_channel_id;
    if (!channelId) continue; // not a channel-publish run (e.g. a footage/cartoon production run); not this dashboard's concern
    out.push({ run_id: run.run_id, channel_id: channelId, stage_key: stage.stage_key, state: run.state, since: stage.updated_at });
  }
  return out;
}

/** Local wall-clock time in `timezone` is past the latest `publishTimes` entry for `now`'s local day. */
function isPastLastSlot(publishTimes: string[], timezone: string, now: string): boolean {
  const last = [...publishTimes].sort().at(-1);
  if (!last) return false;
  const [y, m, dd] = localDate(now, timezone).split("-").map(Number) as [number, number, number];
  const [hh, mm] = last.split(":").map(Number) as [number, number];
  return Date.parse(now) >= zonedToUtc({ y, m, d: dd, hh, mm }, timezone).getTime();
}

function buildAlerts(d: SnapshotDeps, now: string, doctorRows: DoctorRow[], channels: DashboardChannel[]): DashboardAlert[] {
  const { store } = d;
  const alerts: DashboardAlert[] = [];

  for (const job of store.listPublicationJobs({ state: "NEEDS_RECONCILIATION" }) as PublicationJob[]) {
    alerts.push({ kind: "reconcile", channel_id: job.channel_id, ref: job.publication_job_id, message: `publication job ${job.publication_job_id} stuck at NEEDS_RECONCILIATION`, since: job.updated_at });
  }

  const failedSinceMs = Date.parse(now) - RUN_FAILED_WINDOW_MS;
  for (const run of store.listRuns({ state: "FAILED" })) {
    if (Date.parse(run.updated_at) < failedSinceMs) continue;
    alerts.push({ kind: "run_failed", ref: run.run_id, message: `run ${run.run_id} failed`, since: run.updated_at });
  }

  for (const { run, stage, overdue_seconds } of gateOverdue(store, now, d.gateWindowSeconds)) {
    alerts.push({ kind: "gate_overdue", ref: stage.stage_run_id, message: `gate ${stage.stage_key} of run ${run.run_id} overdue by ${overdue_seconds}s`, since: stage.updated_at });
  }

  for (const row of doctorRows) {
    if (row.ok) continue;
    const channelMatch = /^channel:([^:]+):/.exec(row.check);
    alerts.push({ kind: "doctor", ...(channelMatch ? { channel_id: channelMatch[1] } : {}), ref: row.check, message: row.detail, since: now });
  }

  if (d.library && !d.library.fs.exists()) {
    const root = posixPath(d.library.fs.paths.root);
    alerts.push({ kind: "library_unmounted", ref: root, message: `library root not mounted: ${root}`, since: now });
  }

  for (const channel of channels) {
    if (channel.today.published >= channel.today.target) continue;
    if (!isPastLastSlot(channel.publish_times, channel.timezone, now)) continue;
    alerts.push({
      kind: "missing_today", channel_id: channel.channel_id, ref: channel.channel_id,
      message: `${channel.channel_id}: ${channel.today.published}/${channel.today.target} published today`, since: now,
    });
  }

  return alerts;
}

/** Atomic write (tmp + rename, same convention `LibraryFs` uses) of `<dataRoot>/dashboard/snapshot.json`. */
export function writeSnapshotFile(dataRoot: string, snapshot: DashboardSnapshot): string {
  const dir = join(dataRoot, "dashboard");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "snapshot.json");
  const tmp = join(dir, `.snapshot.json.tmp-${randomUUID()}`);
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  renameSync(tmp, file);
  return file;
}
