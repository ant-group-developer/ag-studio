import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError } from "@harness/contracts";
import { LibraryFs, libraryPaths } from "../../src/index.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "library-brands-"));
}

describe("libraryPaths brands/music", () => {
  it("builds brandsDir/brandDir/brandFile/brandFontsDir", () => {
    const root = tempRoot();
    const p = libraryPaths(root);
    expect(p.brandsDir).toBe(join(root, "brands"));
    expect(p.brandDir("ch1")).toBe(join(root, "brands", "ch1"));
    expect(p.brandFile("ch1")).toBe(join(root, "brands", "ch1", "brand.json"));
    expect(p.brandFontsDir("ch1")).toBe(join(root, "brands", "ch1", "fonts"));
  });

  it("builds musicDir/trackDir/trackFile", () => {
    const root = tempRoot();
    const p = libraryPaths(root);
    expect(p.musicDir).toBe(join(root, "music"));
    expect(p.trackDir("calm-01")).toBe(join(root, "music", "calm-01"));
    expect(p.trackFile("calm-01")).toBe(join(root, "music", "calm-01", "track.json"));
  });

  it("brandDir/brandFile/brandFontsDir throw CONFIG_INVALID for a path-traversal-shaped channel_id", () => {
    const root = tempRoot();
    const p = libraryPaths(root);
    for (const bad of ["../music", "CH1", "ch 1", ""]) {
      for (const fn of [() => p.brandDir(bad), () => p.brandFile(bad), () => p.brandFontsDir(bad)]) {
        let caught: unknown;
        try {
          fn();
        } catch (e) {
          caught = e;
        }
        expect(isHarnessError(caught, "CONFIG_INVALID"), `expected CONFIG_INVALID for channel_id ${JSON.stringify(bad)}`).toBe(true);
      }
    }
  });

  it("trackDir/trackFile throw CONFIG_INVALID for a path-traversal-shaped or malformed track_id", () => {
    const root = tempRoot();
    const p = libraryPaths(root);
    for (const bad of ["../brands", "Calm-01", "a", ""]) {
      for (const fn of [() => p.trackDir(bad), () => p.trackFile(bad)]) {
        let caught: unknown;
        try {
          fn();
        } catch (e) {
          caught = e;
        }
        expect(isHarnessError(caught, "CONFIG_INVALID"), `expected CONFIG_INVALID for track_id ${JSON.stringify(bad)}`).toBe(true);
      }
    }
  });
});

describe("LibraryFs brands/music write guard", () => {
  it("channel may write brands/<ch>/brand.json, brands/<ch>/fonts/<file>, and music/<id>/track.json", () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });

    expect(() => channel.writeJsonAtomic(channel.paths.brandFile("ch1"), { ok: true })).not.toThrow();
    expect(() => channel.writeJsonAtomic(join(channel.paths.brandFontsDir("ch1"), "a.ttf"), { ok: true })).not.toThrow();
    expect(() => channel.writeJsonAtomic(join(channel.paths.brandDir("ch1"), "logo.png"), { ok: true })).not.toThrow();
    expect(() => channel.writeJsonAtomic(channel.paths.trackFile("calm-01"), { ok: true })).not.toThrow();
    expect(JSON.parse(readFileSync(channel.paths.brandFile("ch1"), "utf8"))).toEqual({ ok: true });
  });

  it("studio may not write anything under brands/ or music/", () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });

    for (const path of [studio.paths.brandFile("ch1"), join(studio.paths.brandFontsDir("ch1"), "a.ttf"), studio.paths.trackFile("calm-01")]) {
      let caught: unknown;
      try {
        studio.writeJsonAtomic(path, { ok: true });
      } catch (e) {
        caught = e;
      }
      expect(isHarnessError(caught, "CONFIG_INVALID"), `expected studio write of ${path} to be refused`).toBe(true);
    }
  });

  it("channel may not write deeper than music/<id>/<file> (exactly 3 segments)", () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    let caught: unknown;
    try {
      channel.writeJsonAtomic(join(channel.paths.trackDir("calm-01"), "nested", "extra.json"), { ok: true });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });

  it("channel may write arbitrarily deep under brands/<ch>/ (>= 3 segments)", () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    expect(() => channel.writeJsonAtomic(join(channel.paths.brandDir("ch1"), "nested", "deeper", "extra.json"), { ok: true })).not.toThrow();
  });
});

describe("LibraryFs.listBrandChannelIds / listTrackIds", () => {
  it("requires brand.json / track.json and skips dot-names", () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    channel.writeJsonAtomic(channel.paths.brandFile("ch1"), { ok: true });
    channel.writeJsonAtomic(channel.paths.trackFile("calm-01"), { ok: true });

    expect(channel.listBrandChannelIds()).toEqual(["ch1"]);
    expect(channel.listTrackIds()).toEqual(["calm-01"]);
  });

  it("returns empty array when brands/ or music/ does not exist yet", () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    expect(fs.listBrandChannelIds()).toEqual([]);
    expect(fs.listTrackIds()).toEqual([]);
  });
});
