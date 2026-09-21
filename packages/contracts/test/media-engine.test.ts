import { describe, expect, it } from "vitest";
import {
  AnySurveyIndexSchema, ChannelConfigSchema, ContentRequestSchema, FitReportSchema, NarrationSchema,
  NarrationTimingSchema, ProjectConfigSchema, ShotsIndexSchema, TimelineSchema, TranscriptSchema,
  VoiceProfileSchema, autoAcceptPatterns, libraryBriefSchema, newId, surveyIndexSchema, surveyIndexSchemaV2,
} from "../src/index.js";

const NOW = "2026-09-21T00:00:00.000Z";
const SHA = "sha256:" + "a".repeat(64);

function sourceId() { return newId("source_item"); }

function shotsIndexSample() {
  return {
    schema_version: "harness.shots/v2",
    sources: [
      {
        source_id: sourceId(), index: 0, file_name: "clip-1.mp4", duration_seconds: 12,
        has_audio: true, shots: [{ shot_id: "s000-000", in: 0, out: 5 }, { shot_id: "s000-001", in: 5, out: 12 }],
      },
    ],
  };
}

function transcriptSample() {
  return {
    schema_version: "harness.transcript/v1", engine: "whisperx",
    sources: [{
      source_id: sourceId(), language: "vi", alignment: "word",
      segments: [{ start: 0, end: 2, text: "xin chào", words: [{ word: "xin", start: 0, end: 0.5 }, { word: "chào", start: 0.5, end: 2 }] }],
    }],
  };
}

function narrationSample() {
  return { schema_version: "harness.narration/v1", language: "vi", lines: [{ line_id: "L001", edl_order: 0, text: "xin chào các bạn" }] };
}

function narrationTimingSample() {
  return {
    schema_version: "harness.narration-timing/v1", voice_id: newId("voice_profile"), voice_revision: 1, total_seconds: 3,
    lines: [{
      line_id: "L001", edl_order: 0, text: "xin chào các bạn", wav: "L001.wav", duration_seconds: 3,
      chunks: [{ text: "xin chào các bạn", start: 0, end: 3 }], words: [], alignment: "chunk", cached: false,
    }],
  };
}

function fitReportSample() {
  return {
    schema_version: "harness.fit-report/v1", voice: "tts",
    entries: [{ order: 0, source_id: sourceId(), before: { in: 0, out: 5 }, after: { in: 0, out: 4 }, action: "trimmed" }],
    shortfalls: [], reused_seconds: 0, warnings: [], total_seconds: 4, within_target: true,
  };
}

function timelineSample() {
  return {
    schema_version: "harness.timeline/v1", voice: "tts", language: "vi", total_seconds: 4,
    video: [{ order: 0, source_id: sourceId(), in: 0, out: 4, start: 0, end: 4 }],
    narration: [{ line_id: "L001", wav: "L001.wav", start: 0, end: 3, words: [] }],
    speech: [],
  };
}

function voiceProfileSample(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "harness.voice/v1", voice_id: newId("voice_profile"), display_name: "Chị Hai", language: "vi",
    origin: "own", origin_note: "", ref_audio: { path: "ref.wav", checksum: SHA, duration_seconds: 8 },
    ref_text: "xin chào các bạn, đây là giọng mẫu", params: {}, revision: 1, status: "active",
    created_at: NOW, updated_at: NOW, ...overrides,
  };
}

describe("media-engine schemas", () => {
  it("parses a valid sample of each of the 8 new schemas", () => {
    expect(ShotsIndexSchema.parse(shotsIndexSample()).sources[0]?.shots).toHaveLength(2);
    expect(TranscriptSchema.parse(transcriptSample()).sources[0]?.segments[0]?.words).toHaveLength(2);
    expect(NarrationSchema.parse(narrationSample()).lines[0]?.line_id).toBe("L001");
    expect(NarrationTimingSchema.parse(narrationTimingSample()).lines[0]?.cached).toBe(false);
    expect(FitReportSchema.parse(fitReportSample()).within_target).toBe(true);
    expect(TimelineSchema.parse(timelineSample()).video).toHaveLength(1);
    expect(VoiceProfileSchema.parse(voiceProfileSample()).status).toBe("active");
    expect(surveyIndexSchemaV2.parse({
      schema_version: "harness.survey-index/v2",
      shots: [{ source_id: sourceId(), shot_id: "s000-000", in: 0, out: 5, score: 4, tags: [], usable: true, note: "", speech: "talking" }],
    }).shots).toHaveLength(1);
  });

  it("splits a fit-report shortfall into reused and uncovered seconds, defaulting both to 0", () => {
    const withRow = (row: Record<string, unknown>) => ({ ...fitReportSample(), shortfalls: [row] });
    expect(FitReportSchema.parse(withRow({ line_ids: ["L001"], missing_seconds: 2 })).shortfalls[0]).toEqual({
      line_ids: ["L001"], missing_seconds: 2, reused_seconds: 0, uncovered_seconds: 0,
    });
    expect(FitReportSchema.parse(withRow({
      line_ids: ["L001", "L002"], missing_seconds: 280.7, reused_seconds: 20, uncovered_seconds: 260.7,
    })).shortfalls[0]?.uncovered_seconds).toBe(260.7);
    // missing_seconds stays strictly positive, and neither split may be negative
    expect(FitReportSchema.safeParse(withRow({ line_ids: [], missing_seconds: 0 })).success).toBe(false);
    expect(FitReportSchema.safeParse(withRow({ line_ids: [], missing_seconds: 2, reused_seconds: -1 })).success).toBe(false);
  });

  it("rejects a shot_id that does not match s###-### ", () => {
    const bad = shotsIndexSample();
    bad.sources[0]!.shots[0]!.shot_id = "s1-2";
    expect(ShotsIndexSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a voice profile missing origin, and a ref_audio duration outside [3,30]", () => {
    const { origin: _origin, ...withoutOrigin } = voiceProfileSample();
    expect(VoiceProfileSchema.safeParse(withoutOrigin).success).toBe(false);
    expect(VoiceProfileSchema.safeParse(voiceProfileSample({ ref_audio: { path: "ref.wav", checksum: SHA, duration_seconds: 2 } })).success).toBe(false);
  });

  it("defaults voice params and keeps ref_audio.path pinned to ref.wav", () => {
    const v = VoiceProfileSchema.parse(voiceProfileSample());
    expect(v.params).toEqual({ speed: 1, num_step: 32 });
    expect(VoiceProfileSchema.safeParse(voiceProfileSample({ ref_audio: { path: "other.wav", checksum: SHA, duration_seconds: 8 } })).success).toBe(false);
  });
});

const MINIMAL_PROJECT_CONFIG = {
  schema_version: "harness.project-config/v1", project_id: "project-main", template_release: "0.1.0", runtime: "claude",
  data_root: "E:/youtube-operations-data", portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }],
};

describe("ProjectConfigSchema media/adapters.media/auto_accept defaults", () => {
  it("an old project.yaml (no adapters.media/media/auto_accept.max_sources) still parses with new defaults", () => {
    const parsed = ProjectConfigSchema.parse(MINIMAL_PROJECT_CONFIG);
    expect(parsed.adapters.media).toBe("fake");
    expect(parsed.media.device).toBe("cuda:0");
    expect(parsed.media.tts.max_chars).toBe(280);
    expect(parsed.media.watch.max_sheets).toBe(24);
  });

  it("defaults library.auto_accept.max_sources to 40", () => {
    const parsed = ProjectConfigSchema.parse({
      ...MINIMAL_PROJECT_CONFIG,
      library: { root: "E:/lib", role: "studio", auto_accept: {} },
    });
    expect(parsed.library?.auto_accept?.max_sources).toBe(40);
  });

  it("accepts adapters.media: python and a full media block", () => {
    const parsed = ProjectConfigSchema.parse({
      ...MINIMAL_PROJECT_CONFIG,
      adapters: { media: "python" },
      media: { python: "D:/venv/Scripts/python.exe", device: "cuda:1" },
    });
    expect(parsed.adapters.media).toBe("python");
    expect(parsed.media.device).toBe("cuda:1");
    expect(parsed.media.transcribe.model).toBe("large-v3");
  });
});

describe("autoAcceptPatterns", () => {
  it("falls back to [source_collection] when source_collections is absent", () => {
    expect(autoAcceptPatterns({ enabled: true, source_collection: "main", max_replans: 2, max_concurrent_runs: 1, max_sources: 40 })).toEqual(["main"]);
  });
  it("uses source_collections when present", () => {
    expect(autoAcceptPatterns({ enabled: true, source_collection: "main", source_collections: ["shoot-*", "b-roll"], max_replans: 2, max_concurrent_runs: 1, max_sources: 40 })).toEqual(["shoot-*", "b-roll"]);
  });
});

const MINIMAL_CHANNEL_CONFIG = {
  schema_version: "harness.channel-config/v1", channel_id: "channel-a", display_name: "Channel A", portfolio_id: "portfolio-main",
  repo_dir: "E:/channels/channel-a",
  youtube: { expected_channel_id: "UCxxxxxxxxxxxxxxxxxxxxxx", account_email_ref: "secret://youtube/channel-a-email" },
  publication: { timezone: "Asia/Ho_Chi_Minh", publish_times: ["09:00"] },
};

describe("ChannelConfigSchema voice", () => {
  it("an old channel.yaml (no voice) still parses", () => {
    expect(ChannelConfigSchema.parse(MINIMAL_CHANNEL_CONFIG).voice).toBeUndefined();
  });
  it("parses a channel.yaml with voice.voice_id", () => {
    const voiceId = newId("voice_profile");
    expect(ChannelConfigSchema.parse({ ...MINIMAL_CHANNEL_CONFIG, voice: { voice_id: voiceId } }).voice).toEqual({ voice_id: voiceId });
  });
});

describe("voice_id on ContentRequestSchema and libraryBriefSchema", () => {
  it("content request accepts voice_id", () => {
    const voiceId = newId("voice_profile");
    const r = ContentRequestSchema.parse({
      schema_version: "harness.content-request/v1", request_id: newId("content_request"), requested_by: { portfolio_id: "pf" },
      topic: "chợ nổi", status: "open", voice: "tts", voice_id: voiceId, created_at: NOW, updated_at: NOW,
    });
    expect(r.voice_id).toBe(voiceId);
  });
  it("library brief accepts voice_id, voice_revision and voice_checksum", () => {
    const voiceId = newId("voice_profile");
    const b = libraryBriefSchema.parse({
      topic: "chợ nổi", style_id: newId("edit_style"), style_revision: 1, voice: "tts",
      voice_id: voiceId, voice_revision: 1, voice_checksum: SHA,
    });
    expect(b).toMatchObject({ voice_id: voiceId, voice_revision: 1, voice_checksum: SHA });
  });
});

describe("AnySurveyIndexSchema", () => {
  it("parses a v1 survey sample", () => {
    const v1 = { schema_version: "harness.survey-index/v1", shots: [{ in: 0, out: 5, score: 3, tags: [], usable: true, note: "" }] };
    expect(surveyIndexSchema.parse(v1).shots).toHaveLength(1);
    expect(AnySurveyIndexSchema.safeParse(v1).success).toBe(true);
  });
  it("parses a v2 survey sample", () => {
    const v2 = {
      schema_version: "harness.survey-index/v2",
      shots: [{ source_id: sourceId(), shot_id: "s000-000", in: 0, out: 5, score: 3, tags: [], usable: true, note: "", speech: "none" }],
    };
    expect(AnySurveyIndexSchema.safeParse(v2).success).toBe(true);
  });
});
