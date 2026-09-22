import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrandProfile, MusicTrack } from "@harness/contracts";
import { LibraryFs, syncLibrary } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "library-sync-brands-"));
}

function makeBrand(channelId: string, overrides: Partial<BrandProfile> = {}): BrandProfile {
  return {
    schema_version: "harness.brand/v1", channel_id: channelId, revision: 1,
    fonts: { regular: "fonts/Regular.ttf", bold: "fonts/Bold.ttf", origin: "royalty_free", origin_note: "OFL 1.1" },
    colors: { primary: "#F2C94C", text: "#FFFFFF", text_outline: "#000000", box: "#000000B3" },
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
    checksums: { "fonts.regular": `sha256:${"a".repeat(64)}`, "fonts.bold": `sha256:${"b".repeat(64)}` },
    created_at: "2026-09-22T00:00:00.000Z", updated_at: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function makeTrack(id: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    schema_version: "harness.music-track/v1", track_id: id, display_name: "Calm piano 01", file: "track.wav",
    mood: ["calm", "neutral"], duration_seconds: 184.2, loop_ok: true, origin: "royalty_free", origin_note: "Pixabay licence, 2026-09-20",
    checksum: `sha256:${"c".repeat(64)}`, active: true, created_at: "2026-09-22T00:00:00.000Z", updated_at: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("syncLibrary brands", () => {
  it("mirrors a hand-written brand.json for both the studio and channel role", async () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    channel.writeJsonAtomic(channel.paths.brandFile("ch1"), makeBrand("ch1"));

    const studio = new LibraryFs({ root, role: "studio" });
    const { store: studioStore, clock: studioClock } = openTempStore();
    const studioReport = await syncLibrary({ store: studioStore, fs: studio, role: "studio", clock: studioClock });
    expect(studioReport.imported.brands).toEqual(["ch1"]);
    expect(studioStore.getBrandProfile("ch1")?.channel_id).toBe("ch1");

    const { store: channelStore, clock: channelClock } = openTempStore();
    const channelReport = await syncLibrary({ store: channelStore, fs: channel, role: "channel", clock: channelClock });
    expect(channelReport.imported.brands).toEqual(["ch1"]);
    expect(channelStore.getBrandProfile("ch1")?.channel_id).toBe("ch1");
  });

  it("flags a corrupt brand.json without importing it", async () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    mkdirSync(channel.paths.brandDir("ch1"), { recursive: true });
    writeFileSync(channel.paths.brandFile("ch1"), "{not valid json");
    const { store, clock } = openTempStore();

    const report = await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(report.imported.brands).toEqual([]);
    expect(report.corrupt).toHaveLength(1);
    expect(report.corrupt[0].path).toBe(channel.paths.brandFile("ch1"));
  });

  it("reports a mirrored brand whose kho entry disappeared as missing, without dropping it from the store", async () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    channel.writeJsonAtomic(channel.paths.brandFile("ch1"), makeBrand("ch1"));
    const { store, clock } = openTempStore();
    await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(store.getBrandProfile("ch1")).toBeDefined();

    rmSync(channel.paths.brandDir("ch1"), { recursive: true, force: true });
    const report = await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(report.missing).toEqual([{ kind: "brand", id: "ch1" }]);
    expect(store.getBrandProfile("ch1")).toBeDefined();
  });
});

describe("syncLibrary tracks", () => {
  it("mirrors a hand-written track.json for both the studio and channel role", async () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    channel.writeJsonAtomic(channel.paths.trackFile("calm-01"), makeTrack("calm-01"));

    const studio = new LibraryFs({ root, role: "studio" });
    const { store: studioStore, clock: studioClock } = openTempStore();
    const studioReport = await syncLibrary({ store: studioStore, fs: studio, role: "studio", clock: studioClock });
    expect(studioReport.imported.tracks).toEqual(["calm-01"]);
    expect(studioStore.getMusicTrack("calm-01")?.track_id).toBe("calm-01");
  });

  it("flags a corrupt track.json without importing it", async () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    mkdirSync(channel.paths.trackDir("calm-01"), { recursive: true });
    writeFileSync(channel.paths.trackFile("calm-01"), "{not valid json");
    const { store, clock } = openTempStore();

    const report = await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(report.imported.tracks).toEqual([]);
    expect(report.corrupt).toHaveLength(1);
    expect(report.corrupt[0].path).toBe(channel.paths.trackFile("calm-01"));
  });

  it("reports a mirrored track whose kho entry disappeared as missing, without dropping it from the store", async () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    channel.writeJsonAtomic(channel.paths.trackFile("calm-01"), makeTrack("calm-01"));
    const { store, clock } = openTempStore();
    await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(store.getMusicTrack("calm-01")).toBeDefined();

    rmSync(channel.paths.trackDir("calm-01"), { recursive: true, force: true });
    const report = await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(report.missing).toEqual([{ kind: "track", id: "calm-01" }]);
    expect(store.getMusicTrack("calm-01")).toBeDefined();
  });

  it("classifies a re-synced track as updated when content changes (checksum, not updated_at, moves)", async () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    channel.writeJsonAtomic(channel.paths.trackFile("calm-01"), makeTrack("calm-01"));
    const { store, clock } = openTempStore();
    const first = await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(first.imported.tracks).toEqual(["calm-01"]);

    const unchanged = await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(unchanged.imported.tracks).toEqual([]);
    expect(unchanged.updated.tracks).toEqual([]);

    clock.advance(60);
    channel.writeJsonAtomic(channel.paths.trackFile("calm-01"), makeTrack("calm-01", { active: false, updated_at: clock.now() }));
    const updated = await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(updated.updated.tracks).toEqual(["calm-01"]);
    expect(store.getMusicTrack("calm-01")?.active).toBe(false);
  });
});
