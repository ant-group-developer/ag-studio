import { describe, expect, it } from "vitest";
import { ContentRequestSchema, ProjectConfigSchema, reviewSchema, surveyIndexSchema, WatchIndexSchema } from "../src/index.js";

describe("WatchIndexSchema", () => {
  it("accepts two videos, one with a null transcript and a transcript_error", () => {
    const parsed = WatchIndexSchema.parse({
      schema_version: "harness.watch/v1",
      mode: "samples",
      videos: [
        {
          label: "video-1", source_path: "samples/video-1.mp4", duration_seconds: 120,
          media: { width: 1920, height: 1080, fps: 30, has_audio: true },
          frames: [{ t: 0, file: "frames/0.jpg", kind: "scene" }],
          sheets: ["sheets/0.jpg"],
          transcript: { segments: [{ start: 0, end: 1.5, text: "hello" }] },
        },
        {
          label: "video-2", source_path: "samples/video-2.mp4", duration_seconds: 60,
          media: null,
          frames: [],
          sheets: [],
          transcript: null,
          transcript_error: "asr failed: timeout",
        },
      ],
    });
    expect(parsed.videos).toHaveLength(2);
    expect(parsed.videos[1]?.transcript).toBeNull();
    expect(parsed.videos[1]?.transcript_error).toBe("asr failed: timeout");
  });
});

describe("reviewSchema", () => {
  it("accepts the old shape (no schema_version, no checks) with checks defaulting to []", () => {
    const parsed = reviewSchema.parse({ decision: "approved" });
    expect(parsed.checks).toEqual([]);
    expect(parsed.note).toBe("");
    expect(parsed.schema_version).toBeUndefined();
  });

  it("accepts the new shape with schema_version and checks", () => {
    const parsed = reviewSchema.parse({
      schema_version: "harness.review/v1",
      decision: "rejected",
      note: "bad framing",
      checks: [{ id: "framing", pass: false, note: "off-center" }],
    });
    expect(parsed.checks).toEqual([{ id: "framing", pass: false, note: "off-center" }]);
  });
});

describe("surveyIndexSchema", () => {
  it("rejects an empty shots array", () => {
    expect(() =>
      surveyIndexSchema.parse({ schema_version: "harness.survey-index/v1", shots: [] }),
    ).toThrow();
  });

  it("accepts a valid shot list", () => {
    const parsed = surveyIndexSchema.parse({
      schema_version: "harness.survey-index/v1",
      shots: [{ in: 0, out: 3.2, score: 4, usable: true }],
    });
    expect(parsed.shots[0]).toMatchObject({ in: 0, out: 3.2, score: 4, usable: true, tags: [], note: "" });
  });
});

const REQUEST_BASE = {
  schema_version: "harness.content-request/v1",
  request_id: "req_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  requested_by: { portfolio_id: "portfolio-main" },
  topic: "test topic",
  status: "open",
  created_at: "2026-09-15T00:00:00.000Z",
  updated_at: "2026-09-15T00:00:00.000Z",
} as const;

describe("ContentRequestSchema.source_hint", () => {
  it("accepts a collection-only source_hint", () => {
    const parsed = ContentRequestSchema.parse({ ...REQUEST_BASE, source_hint: { collection: "main" } });
    expect(parsed.source_hint).toEqual({ collection: "main" });
  });

  it("rejects an uppercase collection", () => {
    expect(() => ContentRequestSchema.parse({ ...REQUEST_BASE, source_hint: { collection: "Main" } })).toThrow();
  });
});

describe("ProjectConfigSchema.library.auto_accept", () => {
  const PROJECT_BASE = {
    schema_version: "harness.project-config/v1",
    project_id: "project-01",
    template_release: "0.1.0",
    runtime: "claude",
    data_root: "./data",
    portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }],
  } as const;

  it("defaults enabled true, source_collection main, max_replans 2, max_concurrent_runs 1, max_sources 40 when auto_accept is {}", () => {
    const parsed = ProjectConfigSchema.parse({
      ...PROJECT_BASE,
      library: { root: "./kho", role: "studio", auto_accept: {} },
    });
    expect(parsed.library?.auto_accept).toEqual({
      enabled: true,
      source_collection: "main",
      max_replans: 2,
      max_concurrent_runs: 1,
      max_sources: 40,
    });
  });

  it("leaves auto_accept undefined when absent", () => {
    const parsed = ProjectConfigSchema.parse({
      ...PROJECT_BASE,
      library: { root: "./kho", role: "studio" },
    });
    expect(parsed.library?.auto_accept).toBeUndefined();
  });
});
