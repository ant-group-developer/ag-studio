import { describe, expect, it } from "vitest";
import {
  AudioSourceSchema, IntakeDraftSchema, ProductionMusicSchema, ProductionVoiceSchema, StudioMusicSchema, studioMusicOf,
} from "../src/index.js";

const clone = {
  mode: "clone", reference: "library:studio/p1/voice/abc.wav", reference_text: null, speed: 1, origin: "own",
  source: { kind: "upload", filename: "giong.m4a" }, sha256: "abc", duration_s: 12.5,
  confirmed_by: "auth0|u1", confirmed_at: "2026-10-07T00:00:00.000Z",
};

describe("production voice", () => {
  it("is none (narration declined) or a clone of a sample", () => {
    expect(ProductionVoiceSchema.parse({ mode: "none", decided_by: "auth0|u1", decided_at: "2026-10-07T00:00:00.000Z" }).mode).toBe("none");
    expect(ProductionVoiceSchema.parse(clone)).toMatchObject({ mode: "clone", origin: "own" });
  });

  it("refuses a clone without a library reference or an origin", () => {
    expect(ProductionVoiceSchema.safeParse({ ...clone, reference: "https://x/y.wav" }).success).toBe(false);
    expect(ProductionVoiceSchema.safeParse({ ...clone, origin: "someone" }).success).toBe(false);
  });

  it("still reads the old shape written by tests and SQL", () => {
    const old = ProductionVoiceSchema.parse({ reference: "library:voices/a.wav", reference_text: "xin chào", speed: 1 });
    expect(old).toMatchObject({ reference: "library:voices/a.wav" });
  });
});

describe("audio source", () => {
  it("is a link, an upload or an ag-go asset", () => {
    expect(AudioSourceSchema.parse({ kind: "link", url: "https://drive.google.com/file/d/x/view" }).kind).toBe("link");
    expect(AudioSourceSchema.parse({ kind: "ag-go", asset_id: "a1" }).kind).toBe("ag-go");
    expect(AudioSourceSchema.safeParse({ kind: "link", url: "not a url" }).success).toBe(false);
  });
});

describe("production music", () => {
  it("keeps where the track came from; stages get the plain music", () => {
    const m = ProductionMusicSchema.parse({ track: "library:studio/p1/music/x.mp3", gain_db: -18, ducking: true, source: { kind: "link", url: "https://a.b/x.mp3" }, sha256: "x", duration_s: 120 });
    expect(StudioMusicSchema.parse(studioMusicOf(m))).toEqual({ track: "library:studio/p1/music/x.mp3", gain_db: -18, ducking: true });
  });

  it("reads the old column (no source)", () => {
    expect(studioMusicOf(ProductionMusicSchema.parse({ track: "library:music/calm.mp3", gain_db: -18, ducking: false }))).toEqual({ track: "library:music/calm.mp3", gain_db: -18, ducking: false });
  });
});

describe("intake draft audio links", () => {
  const base = {
    schema_version: "studio.intake-draft/v1", title: null, folder_ids: [], channels: [], keywords: [], aspect: null, language: null,
    hints: { description: "", goal: "", audience: "", tone: "", notes: "", episode_target_seconds: null, max_episodes: null }, questions: [],
  };
  it("are optional", () => {
    expect(IntakeDraftSchema.safeParse(base).success).toBe(true);
  });
  it("hold http(s) links only", () => {
    expect(IntakeDraftSchema.safeParse({ ...base, audio_links: { voice: "https://a.b/v.wav", music: null } }).success).toBe(true);
    expect(IntakeDraftSchema.safeParse({ ...base, audio_links: { voice: "file:///c/v.wav", music: null } }).success).toBe(false);
  });
});
