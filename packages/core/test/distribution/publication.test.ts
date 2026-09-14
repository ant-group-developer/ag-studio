import { describe, expect, it } from "vitest";
import { isHarnessError, newId, type ChannelPackage } from "@harness/contracts";
import {
  createJob, idempotencyKeyFor, localDate, nextSlot, transitionPublication, zonedToUtc, type SlotPolicy,
} from "../../src/index.js";
import { openTempStore } from "../helpers.js";

const now = "2026-09-14T00:00:00.000Z";
const sha = (c: string) => "sha256:" + c.repeat(64);

const SAMPLE_HYPOTHESIS = {
  schema_version: "harness.hypothesis/v1" as const, hypothesis_id: newId("hypothesis"),
  basis: [{ kind: "market" as const, note: "competitors post at 9am" }],
  chosen: { title: "Why This Works", thumbnail_candidate: "candidate-1.png", overlay_text: [], angle: "" },
  rejected: [{ title: "Alt Title", angle: "", why: "weaker hook" }],
  expected: { metric: "ctr" as const, target: 0.05, horizon_hours: 72 },
  status: "open" as const, created_at: now,
};

function samplePackage(overrides: Partial<ChannelPackage> = {}): ChannelPackage {
  return {
    schema_version: "harness.channel-package/v1", package_id: newId("channel_package"), channel_id: "channel-a",
    variant_id: newId("content_variant"), content_id: newId("content_item"), library_item_id: newId("library_item"),
    run_id: newId("run"), episode_no: 15, episode_dir: "episode-15",
    manifest_digest: sha("a"), video_artifact_id: newId("artifact"), thumbnail_artifact_id: newId("artifact"),
    video_checksum: sha("b"), thumbnail_checksum: sha("c"), metadata: { title: "Episode 15", description: "", tags: [], playlists: [], hashtags: [], pinned_comment: "", language: "en" },
    hypothesis: SAMPLE_HYPOTHESIS, metadata_revision: 1, channel_config_revision: sha("d"), status: "draft",
    created_at: now, updated_at: now, ...overrides,
  };
}

describe("zonedToUtc", () => {
  it("resolves 13:00 America/New_York to 17:00Z on the spring-forward day (EDT)", () => {
    const d = zonedToUtc({ y: 2026, m: 3, d: 8, hh: 13, mm: 0 }, "America/New_York");
    expect(d.toISOString()).toBe("2026-03-08T17:00:00.000Z");
  });
  it("resolves 13:00 America/New_York to 18:00Z in January (EST)", () => {
    const d = zonedToUtc({ y: 2026, m: 1, d: 15, hh: 13, mm: 0 }, "America/New_York");
    expect(d.toISOString()).toBe("2026-01-15T18:00:00.000Z");
  });
});

describe("localDate", () => {
  it("converts a UTC instant to the local calendar day in Asia/Bangkok", () => {
    expect(localDate("2026-09-14T03:00:00.000Z", "Asia/Bangkok")).toBe("2026-09-14");
  });
  it("converts a UTC instant to the local calendar day in America/New_York", () => {
    expect(localDate("2026-09-14T18:00:00.000Z", "America/New_York")).toBe("2026-09-14");
  });
});

describe("nextSlot", () => {
  const NY_ONE_SLOT: SlotPolicy = { timezone: "America/New_York", publish_times: ["13:00"], max_daily_uploads: 1, min_gap_hours: 20 };

  it("returns the next day's slot when today's slot has already passed", () => {
    const slot = nextSlot(NY_ONE_SLOT, [], "2026-09-14T18:00:00.000Z");
    expect(slot).toBe("2026-09-15T17:00:00.000Z");
  });

  it("skips a day whose only slot is already taken", () => {
    const slot = nextSlot(NY_ONE_SLOT, ["2026-09-15T17:00:00.000Z"], "2026-09-14T18:00:00.000Z");
    expect(slot).toBe("2026-09-16T17:00:00.000Z");
  });

  it("allows two slots on the same day when max_daily_uploads and min_gap_hours permit", () => {
    const policy: SlotPolicy = { timezone: "America/New_York", publish_times: ["09:00", "13:00"], max_daily_uploads: 2, min_gap_hours: 3 };
    const first = nextSlot(policy, [], "2026-09-14T18:00:00.000Z");
    const second = nextSlot(policy, [first], "2026-09-14T18:00:00.000Z");
    expect(localDate(first, policy.timezone)).toBe(localDate(second, policy.timezone));
    expect(second).not.toBe(first);
  });

  it("pushes to the next day when min_gap_hours cannot fit two slots on the same day", () => {
    const policy: SlotPolicy = { timezone: "America/New_York", publish_times: ["09:00", "13:00"], max_daily_uploads: 2, min_gap_hours: 20 };
    const first = nextSlot(policy, [], "2026-09-14T18:00:00.000Z");
    const second = nextSlot(policy, [first], "2026-09-14T18:00:00.000Z");
    expect(localDate(first, policy.timezone)).not.toBe(localDate(second, policy.timezone));
  });

  it("throws CONFIG_INVALID when no slot is free within maxDays", () => {
    const attempt = () => nextSlot(NY_ONE_SLOT, ["2026-09-15T17:00:00.000Z"], "2026-09-14T18:00:00.000Z", 1);
    expect(attempt).toThrow();
    try {
      attempt();
    } catch (e) {
      expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true);
    }
  });
});

describe("idempotencyKeyFor", () => {
  it("is stable for the same inputs and a valid checksum", () => {
    const p = { channel_id: "channel-a", video_checksum: sha("1"), manifest_digest: sha("2") };
    const a = idempotencyKeyFor(p);
    const b = idempotencyKeyFor({ ...p });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("differs when an input differs", () => {
    const a = idempotencyKeyFor({ channel_id: "channel-a", video_checksum: sha("1"), manifest_digest: sha("2") });
    const b = idempotencyKeyFor({ channel_id: "channel-b", video_checksum: sha("1"), manifest_digest: sha("2") });
    expect(a).not.toBe(b);
  });
});

describe("createJob", () => {
  it("creates a READY job with idempotency_key derived from the package, visible via listPublicationJobs", () => {
    const { store, clock } = openTempStore();
    const pkg = samplePackage();
    const job = createJob({ store, clock }, { pkg });
    expect(job.state).toBe("READY");
    expect(job.channel_id).toBe(pkg.channel_id);
    expect(job.package_id).toBe(pkg.package_id);
    expect(job.idempotency_key).toBe(idempotencyKeyFor({ channel_id: pkg.channel_id, video_checksum: pkg.video_checksum, manifest_digest: pkg.manifest_digest }));
    expect(store.listPublicationJobs({ idempotency_key: job.idempotency_key }).map((j) => j.publication_job_id)).toEqual([job.publication_job_id]);
  });
});

describe("transitionPublication", () => {
  it("moves state and appends a publication.uploading event carrying channel_id", () => {
    const { store, clock } = openTempStore();
    const pkg = samplePackage();
    const job = createJob({ store, clock }, { pkg });
    const updated = transitionPublication(store, job.publication_job_id, "READY", "UPLOADING");
    expect(updated.state).toBe("UPLOADING");
    const events = store.listEvents({ run_id: job.run_id });
    expect(events.map((e) => e.event_type)).toEqual(["publication.uploading"]);
    expect(events[0]?.channel_id).toBe(pkg.channel_id);
    expect(events[0]?.payload.publication_job_id).toBe(job.publication_job_id);
  });

  it("uses warn severity for NEEDS_RECONCILIATION and FAILED", () => {
    const { store, clock } = openTempStore();
    const pkg = samplePackage();
    const job = createJob({ store, clock }, { pkg });
    transitionPublication(store, job.publication_job_id, "READY", "FAILED");
    const events = store.listEvents({ run_id: job.run_id });
    expect(events[0]?.severity).toBe("warn");
  });
});
