import { describe, expect, it } from "vitest";
import type { BrandProfile, MusicTrack } from "@harness/contracts";
import { openTempStore } from "../helpers.js";

const NOW = "2026-09-22T00:00:00.000Z";
const LATER = "2026-09-22T01:00:00.000Z";
const SHA = "sha256:" + "a".repeat(64);

function brandProfile(overrides: Partial<BrandProfile> = {}): BrandProfile {
  return {
    schema_version: "harness.brand/v1", channel_id: "channel-a", revision: 1,
    fonts: { regular: "Inter-Regular.ttf", bold: "Inter-Bold.ttf", origin: "royalty_free", origin_note: "Google Fonts, OFL" },
    colors: { primary: "#FF6600", text: "#FFFFFF", text_outline: "#000000", box: "#000000B3" },
    safe_margin_px: 120,
    text: {
      title: { size_px: 120, position: "top_left", box: true, animation: "slide_up", seconds: 4 },
      callout: { size_px: 160, position: "center", box: false, animation: "pop", seconds: 3 },
      lower_third: { size_px: 72, position: "bottom_left", box: true, animation: "fade", seconds: 5 },
    },
    subtitles: { mode: "burn-in", size_px: 88, position: "bottom_center", max_chars_per_line: 42, max_lines: 2, highlight_color: "#F2C94C" },
    transition: { kind: "cut", seconds: 0.4 },
    source_fit: "scale_pad",
    music: { tracks: [], gain_db: -18, duck_db: -12, duck_attack_ms: 150, duck_release_ms: 600 },
    checksums: {}, created_at: NOW, updated_at: NOW, ...overrides,
  };
}

function musicTrack(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    schema_version: "harness.music-track/v1", track_id: "upbeat-piano", display_name: "Upbeat Piano",
    file: "upbeat-piano.mp3", mood: ["upbeat"], duration_seconds: 120, loop_ok: true,
    origin: "royalty_free", origin_note: "Pixabay Music", checksum: SHA, active: true,
    created_at: NOW, updated_at: NOW, ...overrides,
  };
}

describe("migration 0007", () => {
  it("adds the brand_profile and music_track tables", () => {
    const { store } = openTempStore();
    expect(store.listAppliedMigrations()).toContain("0007_composition.sql");
    expect(store.tableNames()).toEqual(expect.arrayContaining(["brand_profile", "music_track"]));
  });
});

describe("brand_profile store", () => {
  it("upsert inserts a new row and get returns it", () => {
    const { store } = openTempStore();
    const b = brandProfile();
    store.upsertBrandProfile(b);
    expect(store.getBrandProfile(b.channel_id)).toEqual(b);
  });

  it("upsert with the same channel_id overwrites the existing row", () => {
    const { store } = openTempStore();
    store.upsertBrandProfile(brandProfile({ revision: 1 }));
    store.upsertBrandProfile(brandProfile({ revision: 2, updated_at: LATER }));
    const got = store.getBrandProfile("channel-a");
    expect(got?.revision).toBe(2);
    expect(got?.updated_at).toBe(LATER);
  });

  it("returns undefined for an unknown channel_id", () => {
    const { store } = openTempStore();
    expect(store.getBrandProfile("channel-unknown")).toBeUndefined();
  });

  it("lists every brand profile", () => {
    const { store } = openTempStore();
    store.upsertBrandProfile(brandProfile({ channel_id: "channel-a" }));
    store.upsertBrandProfile(brandProfile({ channel_id: "channel-b" }));
    expect(store.listBrandProfiles().map((b) => b.channel_id).sort()).toEqual(["channel-a", "channel-b"]);
  });
});

describe("music_track store", () => {
  it("upsert inserts a new row and get returns it", () => {
    const { store } = openTempStore();
    const t = musicTrack();
    store.upsertMusicTrack(t);
    expect(store.getMusicTrack(t.track_id)).toEqual(t);
  });

  it("upsert with the same track_id overwrites the existing row", () => {
    const { store } = openTempStore();
    store.upsertMusicTrack(musicTrack({ active: true }));
    store.upsertMusicTrack(musicTrack({ active: false, updated_at: LATER }));
    const got = store.getMusicTrack("upbeat-piano");
    expect(got?.active).toBe(false);
    expect(got?.updated_at).toBe(LATER);
  });

  it("returns undefined for an unknown track_id", () => {
    const { store } = openTempStore();
    expect(store.getMusicTrack("unknown-track")).toBeUndefined();
  });

  it("lists all tracks, and filters by active", () => {
    const { store } = openTempStore();
    const active = musicTrack({ track_id: "upbeat-piano", active: true });
    const retired = musicTrack({ track_id: "old-jingle", active: false });
    store.upsertMusicTrack(active);
    store.upsertMusicTrack(retired);
    expect(store.listMusicTracks({}).map((t) => t.track_id).sort()).toEqual(["old-jingle", "upbeat-piano"]);
    expect(store.listMusicTracks({ active: true }).map((t) => t.track_id)).toEqual(["upbeat-piano"]);
    expect(store.listMusicTracks({ active: false }).map((t) => t.track_id)).toEqual(["old-jingle"]);
  });
});
