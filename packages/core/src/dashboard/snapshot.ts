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
  media: DashboardMedia | null;
}

/** Sub-project 5A Task 9 (spec §6.1): project-level (not per-channel) media-engine health for the studio
 * dashboard -- `engine` is whichever `MediaEngine` `project.yaml`'s `adapters.media` picked, `last_tts_at` is
 * the newest `media.tts_done` event's timestamp, `cache_hit_ratio` is Σcached / Σlines across the newest 20
 * `media.tts_done` events (`null` when none exist or their lines summed to zero). Present only when the
 * project declares `library` with `role: "studio"` -- a channel project or one with no library at all has
 * nothing running the media pipeline for this block to describe.
 *
 * Sub-project 5B Task 9 adds the render-side counterparts: `last_render_at`/`render_encoder` come from the
 * newest `media.rendered` event (`null`/`null` when none exists), and `mezz_cache.hit_ratio` is
 * Σcached_segments / Σ(cached_segments + rendered_segments) across the newest 20 `media.rendered` events
 * (`null` when none exist or that denominator sums to zero) -- the render-time analogue of `cache_hit_ratio`
 * above, which stays TTS-only. `mezz_cache` deliberately carries no `bytes` field: nothing in the render
 * pipeline reports mezzanine cache size anywhere an event could pick it up from (`RenderReport` has no such
 * field), so there is nothing truthful to put there yet -- a future task can add it once the render report
 * does. */
export interface DashboardMedia {
  engine: "python" | "fake";
  last_tts_at: string | null;
  cache_hit_ratio: number | null;
  last_render_at: string | null;
  render_encoder: "nvenc" | "cpu" | null;
  mezz_cache: { hit_ratio: number | null };
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

export type DashboardAlertKind = "reconcile" | "run_failed" | "gate_overdue" | "doctor" | "library_unmounted" | "missing_today" | "request_stuck" | "stage_waiting_human" | "stats_blocked" | "stats_failing" | "planning_failed" | "media_engine_unavailable" | "render_cpu_fallback";
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
  /**
   * Sub-project 5A Task 9: which `MediaEngine` this project runs (`ctx.media.name` -- the composition root's
   * own adapter instance, never re-derived or re-imported here since `core` must not depend on `adapters/*`).
   * Combined with `store`'s `media.tts_done` events into `DashboardSnapshot.media`, which is `null` unless
   * `library.role === "studio"` regardless of whether this is set.
   *
   * Sub-project 5B Task 9 adds two fields the `render_cpu_fallback` alert needs and nothing else in
   * `SnapshotDeps` carries: `render_encoder_cfg` is `project.yaml`'s `media.render.encoder` verbatim (an
   * explicit `"cpu"` choice is not a fallback and must never alert), and `resources_gpu` is
   * `project.yaml.resources.gpu`'s declared capacity (0/undefined on a machine with no GPU resource declared
   * at all -- same convention `gpuCurrentlyLeased`/`checkScriptStage`'s resource-capacity check use elsewhere).
   */
  media?: { engine: "python" | "fake"; render_encoder_cfg?: "auto" | "nvenc" | "cpu"; resources_gpu?: number };
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
    media: buildMedia(d),
  };
}

const TTS_DONE_WINDOW = 20;
// `media.tts_done` fires for every run including `voice: none`/`voice: original` ones, which carry `lines: 0`
// -- a project that mixes those with `voice: tts` episodes can have the newest 20 *events* all be zero-line
// ones, pushing every real tts line out of the window entirely. Fetched wider and filtered below (review
// finding, Task 9 fix round) so the ratio/timestamp reflect the newest 20 events that actually did tts work.
const TTS_DONE_FETCH_LIMIT = 200;

/** `DashboardSnapshot.media` (spec §6.1, sub-project 5A Task 9): `null` unless the project declares `library`
 * with `role: "studio"`. `engine` defaults to `"fake"` when the caller did not pass `SnapshotDeps.media` --
 * every real call site (the composition root) always does, this is just what a `library`-only test fixture
 * that predates this task falls back to. `media.tts_done` events carry no `channel_id` (the media pipeline is
 * project-level, not per-channel), so this reads project-wide rather than going through `newestChannelEvent`.
 * `last_tts_at`/`cache_hit_ratio` both only ever look at events with `lines > 0` (a `voice: none`/`original`
 * run's zero-line event says nothing about tts cache health and must not crowd out or null it). */
/** Sub-project 5B Task 9: how many of the newest `media.rendered` events feed `mezz_cache.hit_ratio` and
 * `last_render_at`/`render_encoder` -- unlike `media.tts_done` (see `TTS_DONE_FETCH_LIMIT` above), a
 * `voice: none`/`original` run still renders and still emits a real `media.rendered` event, so there is no
 * "zero-line" event to filter out here and no need to over-fetch. */
const RENDER_WINDOW = 20;

function buildMedia(d: SnapshotDeps): DashboardMedia | null {
  if (d.library?.role !== "studio") return null;
  const fetched = d.store.listEvents({ event_type: "media.tts_done", newest: true, limit: TTS_DONE_FETCH_LIMIT });
  const withLines = fetched.filter((e) => typeof e.payload.lines === "number" && e.payload.lines > 0).slice(-TTS_DONE_WINDOW);
  const last_tts_at = withLines.at(-1)?.occurred_at ?? null;
  let cachedSum = 0;
  let linesSum = 0;
  for (const e of withLines) {
    cachedSum += typeof e.payload.cached === "number" ? e.payload.cached : 0;
    linesSum += e.payload.lines as number;
  }

  const renderEvents = d.store.listEvents({ event_type: "media.rendered", newest: true, limit: RENDER_WINDOW });
  const lastRender = renderEvents.at(-1);
  const last_render_at = lastRender?.occurred_at ?? null;
  const render_encoder = lastRender?.payload.encoder === "nvenc" || lastRender?.payload.encoder === "cpu" ? lastRender.payload.encoder : null;
  let cachedSegmentsSum = 0;
  let totalSegmentsSum = 0;
  for (const e of renderEvents) {
    const cached = e.payload.cached_segments;
    const rendered = e.payload.rendered_segments;
    if (typeof cached !== "number" || typeof rendered !== "number") continue;
    cachedSegmentsSum += cached;
    totalSegmentsSum += cached + rendered;
  }

  return {
    engine: d.media?.engine ?? "fake",
    last_tts_at, cache_hit_ratio: linesSum > 0 ? cachedSum / linesSum : null,
    last_render_at, render_encoder,
    mezz_cache: { hit_ratio: totalSegmentsSum > 0 ? cachedSegmentsSum / totalSegmentsSum : null },
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

/** Newest `event_type` event for this channel, or `undefined` when none exists. Filters by `channel_id` at
 * the store level (not by fetching the newest-of-all-channels window and filtering in JS): on a multi-channel
 * project, a quiet channel's own newest event of this type could otherwise be pushed out of a shared
 * newest-1000-across-every-channel window by a busier sibling channel, silently reporting `undefined` even
 * though a matching event exists (final-review finding, sub-project 3B Task 6). `limit: 1` is enough once the
 * query is already narrowed to exactly this channel + event type. */
function newestChannelEvent(store: StateStore, eventType: string, channelId: string) {
  return store.listEvents({ event_type: eventType, channel_id: channelId, newest: true, limit: 1 }).at(-1);
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
/** The doctor `check` names that raise `media_engine_unavailable` instead of the generic `doctor` alert
 * (`media:models` is deliberately excluded -- see `buildAlerts` below). */
const MEDIA_ENGINE_CHECKS = new Set(["media:python", "media:packages", "media:device", "media:engine"]);

/** `stats_blocked` (spec §5/§6): a `stats.blocked` event for the channel within the last 24h with no later
 * `stats.collected` for that same channel -- once a fresh collect succeeds the channel is no longer
 * considered blocked, even before another `stats.blocked` would naturally age out of the window. Takes the
 * already-built `DashboardChannel[]` (not a fresh `LoadedChannel[]`/store lookup) so the "newest
 * `stats.collected`" half of the check reuses `buildChannelLearning`'s own `last_collect_at` -- computed once
 * per channel per snapshot already, not fetched a second time here. */
function statsBlockedAlerts(store: StateStore, now: string, channels: DashboardChannel[]): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  for (const channel of channels) {
    const channelId = channel.channel_id;
    const blocked = newestChannelEvent(store, "stats.blocked", channelId);
    if (!blocked) continue;
    if (Date.parse(now) - Date.parse(blocked.occurred_at) >= ALERT_WINDOW_MS) continue;
    const lastCollectAt = channel.learning.last_collect_at;
    if (lastCollectAt && Date.parse(lastCollectAt) > Date.parse(blocked.occurred_at)) continue;
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
function planningFailedAlerts(store: StateStore, now: string, channels: DashboardChannel[]): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  for (const channel of channels) {
    const channelId = channel.channel_id;
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

/** `render_cpu_fallback` (spec §6.4, sub-project 5B Task 9): the newest `media.rendered` event resolved to
 * `cpu` even though this machine declares a `gpu` resource (`project.yaml.resources.gpu >= 1`) and
 * `media.render.encoder` is `"auto"` -- an explicit `encoder: "cpu"` project config is a deliberate choice,
 * not a fallback, so no alert then (same distinction `mediaRenderStage`'s own `encoder_cpu` render-report
 * warning draws). Gated on `library.role === "studio"`, the same condition `DashboardSnapshot.media` itself is
 * gated on -- a channel project has no render pipeline for this to describe. Queries the store directly
 * (rather than reusing the already-built `DashboardMedia`) for the same reason `statsBlockedAlerts`/
 * `planningFailedAlerts` do their own `newestChannelEvent` lookups: one alert function, one self-contained
 * query, no threading extra state through `buildAlerts`'s signature. */
function renderCpuFallbackAlerts(d: SnapshotDeps): DashboardAlert[] {
  if (d.library?.role !== "studio") return [];
  if (d.media?.render_encoder_cfg !== "auto") return [];
  if ((d.media?.resources_gpu ?? 0) < 1) return [];
  const last = d.store.listEvents({ event_type: "media.rendered", newest: true, limit: 1 }).at(-1);
  if (!last || last.payload.encoder !== "cpu") return [];
  return [{
    kind: "render_cpu_fallback", ref: last.event_id,
    message: `media render fell back to CPU on run ${String(last.payload.run_id ?? "unknown")} despite resources.gpu and media.render.encoder: auto`,
    since: last.occurred_at,
  }];
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
  alerts.push(...statsBlockedAlerts(store, now, channels));
  alerts.push(...statsFailingAlerts(store));
  alerts.push(...planningFailedAlerts(store, now, channels));
  alerts.push(...renderCpuFallbackAlerts(d));

  for (const { run, stage, overdue_seconds } of gateOverdue(store, now, d.gateWindowSeconds)) {
    alerts.push({ kind: "gate_overdue", ref: stage.stage_run_id, message: `gate ${stage.stage_key} of run ${run.run_id} overdue by ${overdue_seconds}s`, since: stage.updated_at });
  }

  for (const row of doctorRows) {
    if (row.ok) continue;
    // `media_engine_unavailable` below already covers these four -- a failing `media:python`/`media:packages`/
    // `media:device`/`media:engine` row must raise exactly one alert, not this generic one *and* the specific
    // one (review finding, Task 9 fix round). `media:models` is deliberately NOT in `MEDIA_ENGINE_CHECKS`, so
    // it still falls through to this generic loop -- same `ok: false`-as-warning treatment
    // `channel:<id>:planning`'s fake-agent row gets, no new severity concept, no *specific* alert kind.
    if (MEDIA_ENGINE_CHECKS.has(row.check)) continue;
    const channelMatch = /^channel:([^:]+):/.exec(row.check);
    alerts.push({ kind: "doctor", ...(channelMatch ? { channel_id: channelMatch[1] } : {}), ref: row.check, message: row.detail, since: now });
  }

  // `media_engine_unavailable` (spec §6.1, sub-project 5A Task 9): a failing `media:python`/`media:packages`/
  // `media:device`/`media:engine` row means the python engine cannot actually do the transcribe/tts work a
  // multi-hour GPU stage is about to attempt -- raised INSTEAD OF the generic `doctor` alert for these four
  // checks (see the exclusion above), one `media_engine_unavailable` alert per failing row.
  for (const row of doctorRows) {
    if (row.ok) continue;
    if (!MEDIA_ENGINE_CHECKS.has(row.check)) continue;
    alerts.push({ kind: "media_engine_unavailable", ref: row.check, message: row.detail, since: now });
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
