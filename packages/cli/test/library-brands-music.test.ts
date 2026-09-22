import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { HARNESS_ROOT } from "@harness/core";
import { hasFfmpeg, makeWav } from "../../../tests/media.js";

const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");

function cli(project: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function freshProject(edit?: (cfg: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-lib-brands-"));
  cpSync(join(HARNESS_ROOT, "fixtures", "ops-project-minimal"), dir, { recursive: true });
  if (edit) {
    const path = join(dir, "project.yaml");
    const cfg = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    edit(cfg);
    writeFileSync(path, stringify(cfg));
  }
  return dir;
}

function libraryProject(root: string, role: "studio" | "channel", idSuffix: string): string {
  return freshProject((cfg) => { cfg.project_id = `${cfg.project_id}-${idSuffix}`; cfg.library = { root, role }; });
}

/** Builds a `brand.json` source file (outside the kho) plus the two font files it references. */
function makeBrandSource(channelId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-lib-brands-src-"));
  const fontsDir = join(dir, "fonts");
  mkdirSync(fontsDir, { recursive: true });
  writeFileSync(join(fontsDir, "Regular.ttf"), "fake regular font bytes");
  writeFileSync(join(fontsDir, "Bold.ttf"), "fake bold font bytes");
  const brand = {
    schema_version: "harness.brand/v1", channel_id: channelId, revision: 1,
    fonts: { regular: "fonts/Regular.ttf", bold: "fonts/Bold.ttf", origin: "royalty_free", origin_note: "OFL 1.1" },
    colors: { primary: "#F2C94C" },
  };
  const path = join(dir, "brand.json");
  writeFileSync(path, JSON.stringify(brand, null, 2));
  return path;
}

function makeClip(seconds: number): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-lib-music-clip-"));
  const path = join(dir, "track.src.wav");
  makeWav(path, seconds);
  return path;
}

describe("harness library brands CLI", () => {
  it("sets a brand on the channel role, shows it, bumps on a second set, and refuses the same set on the studio role", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-brands-"));
    const channelDir = libraryProject(root, "channel", "brands-channel");
    const studioDir = libraryProject(root, "studio", "brands-studio");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);
    expect(cli(studioDir, "db", "migrate").code).toBe(0);

    const set1 = cli(channelDir, "library", "brands", "set", "ch1", "--from", makeBrandSource("ch1"), "--json");
    expect(set1.code, set1.err).toBe(0);
    const brand1 = JSON.parse(set1.out);
    expect(brand1.channel_id).toBe("ch1");
    expect(brand1.revision).toBe(1);
    expect(Object.keys(brand1.checksums).sort()).toEqual(["fonts.bold", "fonts.regular"]);

    const shown = cli(channelDir, "library", "brands", "show", "ch1", "--json");
    expect(shown.code, shown.err).toBe(0);
    expect(JSON.parse(shown.out).channel_id).toBe("ch1");
    expect(JSON.parse(shown.out).revision).toBe(1);

    const set2 = cli(channelDir, "library", "brands", "set", "ch1", "--from", makeBrandSource("ch1"), "--json");
    expect(set2.code, set2.err).toBe(0);
    expect(JSON.parse(set2.out).revision).toBe(2);

    // studio may never write brands/**
    const refused = cli(studioDir, "library", "brands", "set", "ch1", "--from", makeBrandSource("ch1"), "--json");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("CONFIG_INVALID");
  });

  it("`brands show` on a channel with no brand yet fails with NOT_FOUND", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-brands-none-"));
    const channelDir = libraryProject(root, "channel", "brands-none");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);

    const shown = cli(channelDir, "library", "brands", "show", "no-such-channel", "--json");
    expect(shown.code).toBe(1);
    expect(shown.err).toContain("NOT_FOUND");
  });
});

describe.skipIf(!hasFfmpeg())("harness library music CLI", () => {
  it("adds a track on the channel role, lists it, and refuses the same add on the studio role", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-music-"));
    const channelDir = libraryProject(root, "channel", "music-channel");
    const studioDir = libraryProject(root, "studio", "music-studio");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);
    expect(cli(studioDir, "db", "migrate").code).toBe(0);

    const added = cli(
      channelDir, "library", "music", "add",
      "--track-id", "calm-01", "--file", makeClip(8), "--display-name", "Calm piano 01",
      "--mood", "calm,neutral", "--origin", "royalty_free", "--origin-note", "Pixabay licence, 2026-09-20", "--json",
    );
    expect(added.code, added.err).toBe(0);
    const track = JSON.parse(added.out);
    expect(track.track_id).toBe("calm-01");
    expect(track.active).toBe(true);
    expect(track.mood).toEqual(["calm", "neutral"]);

    const listed = cli(channelDir, "library", "music", "list", "--json");
    expect(listed.code, listed.err).toBe(0);
    const tracks = JSON.parse(listed.out);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].track_id).toBe("calm-01");

    // studio may never write music/**
    const refused = cli(
      studioDir, "library", "music", "add",
      "--track-id", "calm-02", "--file", makeClip(8), "--display-name", "Nope",
      "--mood", "calm", "--origin", "own", "--origin-note", "n/a", "--json",
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("CONFIG_INVALID");
  });

  it("rejects a clip <= 5 seconds without touching the kho", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-music-short-"));
    const channelDir = libraryProject(root, "channel", "music-short");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);

    const refused = cli(
      channelDir, "library", "music", "add",
      "--track-id", "short-01", "--file", makeClip(3), "--display-name", "Too short",
      "--mood", "calm", "--origin", "own", "--origin-note", "n/a", "--json",
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("CONFIG_INVALID");

    const listed = cli(channelDir, "library", "music", "list", "--json");
    expect(listed.code, listed.err).toBe(0);
    expect(JSON.parse(listed.out)).toEqual([]);
  });

  it("retires a track on the channel role and refuses on the studio role", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-music-retire-"));
    const channelDir = libraryProject(root, "channel", "music-retire");
    const studioDir = libraryProject(root, "studio", "music-retire-studio");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);
    expect(cli(studioDir, "db", "migrate").code).toBe(0);

    const added = cli(
      channelDir, "library", "music", "add",
      "--track-id", "calm-01", "--file", makeClip(8), "--display-name", "Calm piano 01",
      "--mood", "calm", "--origin", "own", "--origin-note", "n/a", "--json",
    );
    expect(added.code, added.err).toBe(0);

    const refused = cli(studioDir, "library", "music", "retire", "calm-01", "--json");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("CONFIG_INVALID");

    const retired = cli(channelDir, "library", "music", "retire", "calm-01", "--json");
    expect(retired.code, retired.err).toBe(0);
    expect(JSON.parse(retired.out).active).toBe(false);
  });
});
