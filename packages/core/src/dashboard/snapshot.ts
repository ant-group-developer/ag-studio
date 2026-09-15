import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChannelLearned, ChannelPackage, Clock, LibraryClaim, LibraryItem, PublicationJob, StateStore } from "@harness/contracts";
import { posixPath, type LoadedChannel } from "../distribution/channels.js";
import { localDate, zonedToUtc } from "../distribution/publication.js";
import type { DoctorRow } from "../doctor/doctor.js";
import type { AutoAcceptConfig } from "../library/auto-accept.js";
import { finishedRunCounts } from "../library/auto-accept.js";
import type { LibraryFs, LibraryRole } from "../library/files.js";
import { channelDemand } from "../learning/planning.js";
import { gateOverdue } from "../orchestration/gate.js";
import { isTerminal } from "../state/transitions.js";

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
  learning: DashboardChannelLearning;
}

/** Sub-project 3B Task 6 (spec §5): the channel-learning-loop read model for one channel. `demand` is `null`
 * unless this channel has `planning.enabled` *and* the snapshot was built with library access
 * (`SnapshotDeps.learning`) -- `channelDemand` needs both to mean anything. */
export interface DashboardChannelLearning {
  hypotheses: { open: number; supported: number; refuted: number; void: number };
  last_collect_at: string | null;
  standard: ChannelLearned["standard"] | null;
  metric: ChannelLearned["metric"] | null;
  demand: { needed: number; open_requests: number } | null;
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

export type DashboardAlertKind = "reconcile" | "run_failed" | "gate_overdue" | "doctor" | "library_unmounted" | "missing_today" | "request_stuck" | "stage_waiting_human" | "stats_blocked" | "stats_failing" | "planning_failed";
export interface DashboardAlert { kind: DashboardAlertKind; channel_id?: string; ref: string; message: string; since: string }

export interface SnapshotDeps {
  store: StateStore;
  channels: LoadedChannel[];
  /** `autoAccept` drives the `request_stuck` alert below (an open request whose finished-run count already
   * exceeds `max_replans` -- the same "exhausted" condition `autoAccept` itself skips on, spec §5) without
   * this snapshot needing to know anything else about the studio autopilot loop. It only means anything
   * where the loop actually runs, so the alert is gated on `role === "studio"` **and** `enabled`, exactly
   * like the worker's own `autoAcceptDepsFor`: a channel project, or a studio with the loop switched off,
   * has nobody to act on "auto-accept gave up" and must not be told it did. */
  library?: { fs: LibraryFs; role: LibraryRole; autoAccept?: AutoAcceptConfig };
  /**
   * Sub-project 3B Task 6: library data for each channel's `learning.demand` block (`channelDemand` needs
   * `libraryItems`/`libraryClaimsOf`, exactly the shape `publish-stage.ts`'s own `demand` stage already reads
   * from `app.store.listLibraryItems`/`library.fs.listClaims`). Optional and separate from `library` above --
   * a snapshot with no library access at all (or a channel whose `planning` is disabled) simply reports
   * `demand: null` rather than needing this.
   */
  learning?: { libraryItems: LibraryItem[]; libraryClaimsOf: (itemId: string) => LibraryClaim[] };
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

  const results = d.channels.map((c) => buildChannelSafe(d, c, now, doctorRows));
  const channels = results.map((r) => r.channel);
  const episodes = results.flatMap((r) => r.episodes);
  const channelBuildErrors = results.flatMap((r) => (r.error ? [{ channel_id: r.channel.channel_id, message: r.error }] : []));

  return {
    schema_version: "harness.dashboard-snapshot/v1",
    project_id: d.project_id,
    generated_at: now,
    library: buildLibrary(d),
    channels,
    episodes,
    runs_active: buildRunsActive(d.store),
    alerts: buildAlerts(d, now, doctorRows, channels, channelBuildErrors),
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

interface ChannelBuild { channel: DashboardChannel; episodes: DashboardEpisode[]; error?: string }

/** One misconfigured channel (most likely `publication.timezone` -- `ChannelConfigSchema` only requires
 * `z.string().min(1)`, never validated against the IANA timezone database, so a typo throws a `RangeError`
 * out of `Intl.DateTimeFormat` deep inside `localDate`/`zonedToUtc`) must not abort the whole snapshot: every
 * other channel still has to render. Falls back to a safe-default row plus the failure message rather than
 * propagating, so the caller can still surface it as a `doctor` alert (`buildAlerts` below). */
function buildChannelSafe(d: SnapshotDeps, channel: LoadedChannel, now: string, doctorRows: DoctorRow[]): ChannelBuild {
  try {
    return { channel: buildChannel(d, channel, now, doctorRows), episodes: buildChannelEpisodes(d.store, channel) };
  } catch (e) {
    return { channel: fallbackChannel(channel, doctorRows), episodes: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Safe-default row for a channel whose `buildChannel` threw: zeroed counters, no `latest`/episodes, but the
 * real `doctor` rows (pure string filtering, cannot itself throw) and a best-effort `profile_dir_exists` --
 * `existsSync`/`resolve` do not throw for an ordinary bad path, but this stays defensive since the whole
 * point of this fallback is "never let one channel's bad config take the rest of the snapshot down with it". */
function fallbackChannel(channel: LoadedChannel, doctorRows: DoctorRow[]): DashboardChannel {
  const cfg = channel.config;
  let profileDirExists = false;
  try { profileDirExists = existsSync(join(resolve(cfg.repo_dir), ".upload-profile", "Default")); } catch { /* keep false */ }
  const doctor: DashboardChannelDoctorRow[] = doctorRows
    .filter((r) => r.check.startsWith(`channel:${cfg.channel_id}:`))
    .map((r) => ({ row: r.check, status: r.ok ? "ok" : "fail", message: r.detail }));
  return {
    channel_id: cfg.channel_id, display_name: cfg.display_name, color: cfg.color,
    publish_times: cfg.publication.publish_times, timezone: cfg.publication.timezone, language: cfg.seo.language,
    today: { published: 0, target: cfg.publication.max_daily_uploads },
    login: { profile_dir_exists: profileDirExists, last_upload_ok_at: null },
    latest: null,
    episodes_count: 0,
    doctor,
    learning: { hypotheses: { open: 0, supported: 0, refuted: 0, void: 0 }, last_collect_at: null, standard: null, metric: null, demand: null },
  };
}

/** Newest `event_type` event for this channel, or `undefined` when none exists -- `listEvents({ newest: true })`
 * (per its own documented ordering, see `packages/core/src/learning/metrics.ts`'s `recentlyEmitted`) returns
 * the newest-1000 window OLDEST-first, so the *last* matching element is the actually-newest one. */
function newestChannelEvent(store: StateStore, eventType: string, channelId: string) {
  return store.listEvents({ event_type: eventType, newest: true }).filter((e) => e.channel_id === channelId).at(-1);
}

/** Sub-project 3B Task 6 (spec §5): `DashboardChannel.learning` for one channel -- hypothesis-status counts
 * across its committed packages, the newest `stats.collected` event's timestamp, the channel's learned
 * standard/metric (`null` until `learnChannelStandard` has ever run for it), and `demand` computed via
 * `channelDemand` only when this channel's `planning.enabled` *and* the snapshot has library access. */
function buildChannelLearning(d: SnapshotDeps, channel: LoadedChannel): DashboardChannelLearning {
  const channelId = channel.config.channel_id;
  const hypotheses = { open: 0, supported: 0, refuted: 0, void: 0 };
  for (const pkg of d.store.listChannelPackages({ channel_id: channelId, status: "committed" })) hypotheses[pkg.hypothesis.status]++;
  const learned = d.store.getChannelLearned(channelId);
  const lastCollect = newestChannelEvent(d.store, "stats.collected", channelId);
  let demand: DashboardChannelLearning["demand"] = null;
  if (d.learning && channel.config.planning.enabled) {
    const computed = channelDemand({ store: d.store, clock: d.clock, channel, libraryItems: d.learning.libraryItems, libraryClaimsOf: d.learning.libraryClaimsOf });
    demand = { needed: computed.needed, open_requests: computed.open_requests };
  }
  return { hypotheses, last_collect_at: lastCollect?.occurred_at ?? null, standard: learned?.standard ?? null, metric: learned?.metric ?? null, demand };
}

function buildChannel(d: SnapshotDeps, channel: LoadedChannel, now: string, doctorRows: DoctorRow[]): DashboardChannel {
  const store = d.store;
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
    learning: buildChannelLearning(d, channel),
  };
}

/** Episodes for one channel -- called from `buildChannelSafe` so a channel whose `buildChannel` threw simply
 * contributes no episodes (already reflected by `episodes_count: 0` on its fallback row) instead of a second,
 * redundant failure path. Does not read `channel.config.publication`, so nothing here can throw the way a bad
 * `timezone` throws out of `buildChannel`. */
function buildChannelEpisodes(store: StateStore, channel: LoadedChannel): DashboardEpisode[] {
  const episodes: DashboardEpisode[] = [];
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

/**
 * Every stage parked at `WAITING_HUMAN` on a run that is still alive, whatever its executor type. `gate`
 * stages were already covered -- but only by `gateOverdue`, and only once a `gate_deadline_seconds` they may
 * not even declare has elapsed; an `agent` stage that failed `contract` (never retried, spec §7) parks
 * forever with nothing on the dashboard at all, and `request_stuck` does not see it either because the kho
 * request stays `claimed` while the run lives (final-review finding I-5). Carries the last attempt's failure
 * so the operator knows whether to fix an input, the skill, or just resubmit.
 */
function waitingHumanAlerts(store: StateStore): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  for (const run of store.listRuns({})) {
    if (isTerminal("run", run.state)) continue;
    for (const stage of store.listStageRuns(run.run_id)) {
      if (stage.state !== "WAITING_HUMAN") continue;
      const attempts = store.listAttempts(stage.stage_run_id);
      const last = attempts[attempts.length - 1];
      const why = last
        ? `last attempt ${last.failure_kind ?? last.state.toLowerCase()}${last.error_summary ? `: ${last.error_summary}` : ""}`
        : "no attempt recorded";
      alerts.push({
        kind: "stage_waiting_human", ref: stage.stage_run_id,
        message: `stage ${stage.stage_key} of run ${run.run_id} is waiting for a human (${why})`,
        since: stage.updated_at,
      });
    }
  }
  return alerts;
}

const ALERT_WINDOW_MS = 24 * 3_600_000;
const STATS_FAILING_THRESHOLD = 3;

/** `stats_blocked` (spec §5/§6): a `stats.blocked` event for the channel within the last 24h with no later
 * `stats.collected` for that same channel -- once a fresh collect succeeds the channel is no longer
 * considered blocked, even before another `stats.blocked` would naturally age out of the window. */
function statsBlockedAlerts(store: StateStore, now: string, channels: LoadedChannel[]): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  for (const channel of channels) {
    const channelId = channel.config.channel_id;
    const blocked = newestChannelEvent(store, "stats.blocked", channelId);
    if (!blocked) continue;
    if (Date.parse(now) - Date.parse(blocked.occurred_at) >= ALERT_WINDOW_MS) continue;
    const collected = newestChannelEvent(store, "stats.collected", channelId);
    if (collected && Date.parse(collected.occurred_at) > Date.parse(blocked.occurred_at)) continue;
    alerts.push({
      kind: "stats_blocked", channel_id: channelId, ref: blocked.event_id,
      message: `channel ${channelId} stats collection blocked: ${String(blocked.payload.reason ?? "unknown reason")}`,
      since: blocked.occurred_at,
    });
  }
  return alerts;
}

/** `stats_failing` (spec §5/§6): any `PUBLISHED` job whose `receipt.collect_failures` has reached the
 * `stats.failing` threshold `collectStats` itself uses (packages/core/src/learning/metrics.ts). */
function statsFailingAlerts(store: StateStore): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  for (const job of store.listPublicationJobs({ state: "PUBLISHED" }) as PublicationJob[]) {
    const failures = job.receipt && typeof job.receipt.collect_failures === "number" ? job.receipt.collect_failures : 0;
    if (failures < STATS_FAILING_THRESHOLD) continue;
    alerts.push({
      kind: "stats_failing", channel_id: job.channel_id, ref: job.publication_job_id,
      message: `publication job ${job.publication_job_id} has ${failures} consecutive stats-collect failures`,
      since: job.updated_at,
    });
  }
  return alerts;
}

/** `planning_failed` (spec §5/§6): a `channel.planning_failed` event for the channel within the last 24h. */
function planningFailedAlerts(store: StateStore, now: string, channels: LoadedChannel[]): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  for (const channel of channels) {
    const channelId = channel.config.channel_id;
    const failed = newestChannelEvent(store, "channel.planning_failed", channelId);
    if (!failed) continue;
    if (Date.parse(now) - Date.parse(failed.occurred_at) >= ALERT_WINDOW_MS) continue;
    alerts.push({
      kind: "planning_failed", channel_id: channelId, ref: failed.event_id,
      message: `channel ${channelId} planning failed: ${String(failed.payload.reason ?? "unknown reason")}`,
      since: failed.occurred_at,
    });
  }
  return alerts;
}

/** Local wall-clock time in `timezone` is past the latest `publishTimes` entry for `now`'s local day. */
function isPastLastSlot(publishTimes: string[], timezone: string, now: string): boolean {
  const last = [...publishTimes].sort().at(-1);
  if (!last) return false;
  const [y, m, dd] = localDate(now, timezone).split("-").map(Number) as [number, number, number];
  const [hh, mm] = last.split(":").map(Number) as [number, number];
  return Date.parse(now) >= zonedToUtc({ y, m, d: dd, hh, mm }, timezone).getTime();
}

function buildAlerts(d: SnapshotDeps, now: string, doctorRows: DoctorRow[], channels: DashboardChannel[], channelBuildErrors: { channel_id: string; message: string }[]): DashboardAlert[] {
  const { store } = d;
  const alerts: DashboardAlert[] = [];

  for (const err of channelBuildErrors) {
    alerts.push({ kind: "doctor", channel_id: err.channel_id, ref: `channel:${err.channel_id}:snapshot`, message: err.message, since: now });
  }
  const brokenChannelIds = new Set(channelBuildErrors.map((e) => e.channel_id));

  for (const job of store.listPublicationJobs({ state: "NEEDS_RECONCILIATION" }) as PublicationJob[]) {
    alerts.push({ kind: "reconcile", channel_id: job.channel_id, ref: job.publication_job_id, message: `publication job ${job.publication_job_id} stuck at NEEDS_RECONCILIATION`, since: job.updated_at });
  }

  const failedSinceMs = Date.parse(now) - RUN_FAILED_WINDOW_MS;
  for (const run of store.listRuns({ state: "FAILED" })) {
    if (Date.parse(run.updated_at) < failedSinceMs) continue;
    alerts.push({ kind: "run_failed", ref: run.run_id, message: `run ${run.run_id} failed`, since: run.updated_at });
  }

  alerts.push(...waitingHumanAlerts(store));
  alerts.push(...statsBlockedAlerts(store, now, d.channels));
  alerts.push(...statsFailingAlerts(store));
  alerts.push(...planningFailedAlerts(store, now, d.channels));

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

  if (d.library?.autoAccept?.enabled && d.library.role === "studio") {
    const maxReplans = d.library.autoAccept.max_replans;
    const finished = finishedRunCounts(store);
    for (const request of store.listContentRequests({ status: "open" })) {
      const count = finished.get(request.request_id) ?? 0;
      if (count <= maxReplans) continue;
      alerts.push({
        kind: "request_stuck", ref: request.request_id,
        message: `content request ${request.request_id} exhausted its replan budget (${count} finished runs > max_replans ${maxReplans})`,
        since: request.updated_at,
      });
    }
  }

  for (const channel of channels) {
    // a broken channel's fallback row still carries its (bad) timezone -- `isPastLastSlot` would throw again;
    // its `channel:<id>:snapshot` doctor alert above already covers it, so skip rather than re-fail here.
    if (brokenChannelIds.has(channel.channel_id)) continue;
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
