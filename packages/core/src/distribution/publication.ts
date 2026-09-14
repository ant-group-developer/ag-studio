import {
  HarnessError, newId,
  type Checksum, type ChannelPackage, type Clock, type EventInput, type PublicationJob, type StateStore,
} from "@harness/contracts";
import { sha256String } from "../artifacts/checksum.js";

export function idempotencyKeyFor(p: { channel_id: string; video_checksum: Checksum; manifest_digest: Checksum }): Checksum {
  return sha256String(`${p.channel_id}:${p.video_checksum}:${p.manifest_digest}`);
}

export function publicationEvent(job: PublicationJob, event_type: string, severity: "info" | "warn" | "error", payload: Record<string, unknown> = {}): EventInput {
  return {
    run_id: job.run_id, stage_run_id: null, attempt_id: null, project_id: null, portfolio_id: null,
    channel_id: job.channel_id, content_id: null, variant_id: null, workflow_release: null,
    severity, event_type, payload: { publication_job_id: job.publication_job_id, ...payload },
  };
}

const WARN_ON: ReadonlySet<PublicationJob["state"]> = new Set(["NEEDS_RECONCILIATION", "FAILED"]);

/** The only way `publication_job.state` changes: wraps `store.transition("publication_job", …)`. */
export function transitionPublication(store: StateStore, jobId: string, from: PublicationJob["state"], to: PublicationJob["state"], payload?: Record<string, unknown>): PublicationJob {
  return store.transaction(() => {
    const job = store.getPublicationJob(jobId);
    if (!job) throw new HarnessError("NOT_FOUND", `publication job not found: ${jobId}`, { publication_job_id: jobId });
    const severity = WARN_ON.has(to) ? "warn" : "info";
    const event = publicationEvent(job, `publication.${to.toLowerCase()}`, severity, payload);
    store.transition("publication_job", jobId, from, to, event);
    return store.getPublicationJob(jobId)!;
  });
}

export function createJob(d: { store: StateStore; clock: Clock }, p: { pkg: ChannelPackage }): PublicationJob {
  const now = d.clock.now();
  const job: PublicationJob = {
    schema_version: "harness.publication-job/v1",
    publication_job_id: newId("publication_job"),
    package_id: p.pkg.package_id,
    channel_id: p.pkg.channel_id,
    library_item_id: p.pkg.library_item_id,
    run_id: p.pkg.run_id,
    idempotency_key: idempotencyKeyFor({ channel_id: p.pkg.channel_id, video_checksum: p.pkg.video_checksum, manifest_digest: p.pkg.manifest_digest }),
    state: "READY",
    youtube_video_id: null,
    operation_id: null,
    scheduled_at: null,
    published_at: null,
    last_verified_at: null,
    note: null,
    receipt: null,
    created_at: now,
    updated_at: now,
  };
  d.store.insertPublicationJob(job);
  return job;
}

export interface SlotPolicy { timezone: string; publish_times: string[]; max_daily_uploads: number; min_gap_hours: number }

interface WallClock { y: number; m: number; d: number; hh: number; mm: number }

function partsOf(date: Date, timeZone: string): WallClock {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const byType = new Map(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    y: Number(byType.get("year")), m: Number(byType.get("month")), d: Number(byType.get("day")),
    hh: Number(byType.get("hour")), mm: Number(byType.get("minute")),
  };
}

function asIfUtc(t: number, timezone: string): number {
  const parts = partsOf(new Date(t), timezone);
  return Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm);
}

/** ISO UTC of (local y-m-d, hh:mm) in `timezone`; `Intl.DateTimeFormat`, correct across DST via two corrections. */
export function zonedToUtc(p: { y: number; m: number; d: number; hh: number; mm: number }, timezone: string): Date {
  const guess = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  // Sample the zone's offset at `guess` first, then refine by re-sampling at the first correction — this
  // second pass matters near a DST transition, where the offset at `guess` can differ from the true answer.
  const once = guess - (asIfUtc(guess, timezone) - guess);
  const twice = guess - (asIfUtc(once, timezone) - once);
  return new Date(twice);
}

/** "YYYY-MM-DD" of `iso` in `timezone`. */
export function localDate(iso: string, timezone: string): string {
  const p = partsOf(new Date(iso), timezone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/**
 * Next free publish slot (ISO UTC) after `now`: walks forward day by day (up to `maxDays`), and within each
 * day tries each `publish_times` entry (sorted). A candidate is skipped when it is at or before `now`, lands
 * on the same minute as an entry in `taken`, falls on a local day that already has `max_daily_uploads`
 * entries in `taken`, or is closer than `min_gap_hours` to any entry in `taken`. Exhausting `maxDays` throws
 * `HarnessError("CONFIG_INVALID", …)`.
 */
export function nextSlot(policy: SlotPolicy, taken: string[], now: string, maxDays = 60): string {
  const nowMs = Date.parse(now);
  const takenMs = taken.map((t) => Date.parse(t));
  const times = [...policy.publish_times].sort();
  const gapMs = policy.min_gap_hours * 3600_000;
  const [sy, sm, sd] = localDate(now, policy.timezone).split("-").map(Number) as [number, number, number];

  for (let i = 0; i < maxDays; i++) {
    const day = new Date(Date.UTC(sy, sm - 1, sd + i));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const dayKey = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const slotsThisDay = takenMs.filter((t) => localDate(new Date(t).toISOString(), policy.timezone) === dayKey).length;
    if (slotsThisDay >= policy.max_daily_uploads) continue;

    for (const hhmm of times) {
      const [hhStr, mmStr] = hhmm.split(":");
      const slotMs = zonedToUtc({ y, m, d, hh: Number(hhStr), mm: Number(mmStr) }, policy.timezone).getTime();
      if (slotMs <= nowMs) continue;
      if (takenMs.includes(slotMs)) continue;
      if (takenMs.some((t) => Math.abs(t - slotMs) < gapMs)) continue;
      return new Date(slotMs).toISOString();
    }
  }
  throw new HarnessError("CONFIG_INVALID", `no free publish slot within ${maxDays} days`, { maxDays });
}
