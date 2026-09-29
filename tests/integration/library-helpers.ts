import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { ContentRequestSchema, MusicTrackSchema, newId, type StateStore } from "@harness/contracts";
import { HARNESS_ROOT, SqliteStateStore, libraryPaths } from "@harness/core";
import { hasFfmpeg, makeVideo, makeWav, systemFontPath } from "../media.js";
import { cli } from "./footage-helpers.js";

export { cli } from "./footage-helpers.js";

export const STUDIO_FIXTURE = join(HARNESS_ROOT, "fixtures", "ops-project-studio");
export const CHANNEL_FIXTURE = join(HARNESS_ROOT, "fixtures", "ops-project-channel");
const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");

const posix = (p: string): string => p.split("\\").join("/");

/** The committed studio `scripts.yaml`, re-emitted with every `cwd` resolved against the fixture directory
 * it is written relative to (`.` -> the studio fixture, `../ops-project-footage` -> the footage fixture).
 * The wrapper `.mjs` files then run in place, where they can resolve `@harness/script-sdk` through their own
 * fixture's `node_modules` (a temp project has none). Generated from the file rather than copied, so a
 * change to the fixture reaches these tests automatically. */
function studioScriptsYaml(): string {
  const doc = parse(readFileSync(join(STUDIO_FIXTURE, "executors", "scripts.yaml"), "utf8")) as { scripts: Record<string, { cwd?: string }> };
  for (const script of Object.values(doc.scripts)) script.cwd = posix(resolve(STUDIO_FIXTURE, script.cwd ?? "."));
  return stringify(doc);
}

/** Copies a committed fixture `project.yaml`, repointing `data_root` at the temp project and `library.root`
 * at the shared temp kho, and writes it into `dir`. Everything else (role, portfolios, workflow scope,
 * resources) stays exactly as the fixture declares it -- except, for the studio fixture only, `adapters` and
 * `library.auto_accept`, which are stripped: the studio autopilot went in GĐ3, and without `adapters` the
 * project runs on the fake agent/media engine. */
function writeProjectYaml(fixtureDir: string, dir: string, lib: string): void {
  const cfg = parse(readFileSync(join(fixtureDir, "project.yaml"), "utf8")) as {
    data_root: string;
    library: { root: string; auto_accept?: unknown };
    adapters?: unknown;
  };
  cfg.data_root = posix(join(dir, "data"));
  cfg.library.root = posix(lib);
  if (fixtureDir === STUDIO_FIXTURE) {
    delete cfg.adapters;
    delete cfg.library.auto_accept;
  }
  writeFileSync(join(dir, "project.yaml"), stringify(cfg));
}

function migrate(dir: string): void {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", dir, "db", "migrate"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`db migrate failed in ${dir}: ${r.stderr}`);
}

export interface LibraryWorld {
  /** The shared kho root both projects are mounted on. */
  lib: string;
  /** Temp studio ops project (role `studio`): runs the media stages. */
  studio: string;
  /** Temp channel ops project (role `channel`): the only role allowed to write brands/** and music/**. */
  channel: string;
  /** `raw/sample-5s.mp4` in the studio project. */
  sample: string;
  /** `raw/samples.txt` in the studio project -- one video path per line. */
  samplesTxt: string;
}

/**
 * A studio project and a channel project on one shared kho, both migrated. `sample`/`samplesTxt` are only
 * written when `media` is true (they need ffmpeg).
 */
export function freshLibraryWorld(o: { media?: boolean } = {}): LibraryWorld {
  const media = o.media ?? true;
  const lib = mkdtempSync(join(tmpdir(), "kho-"));
  // the top-level kho directories a mounted share would already have; `doctor`'s library rows fail when
  // `voices/` or `music/` is missing for either role (`brands/` may legitimately be absent).
  for (const sub of ["styles", "requests", "items", "voices", "music"]) mkdirSync(join(lib, sub), { recursive: true });

  const studio = mkdtempSync(join(tmpdir(), "studio-"));
  writeProjectYaml(STUDIO_FIXTURE, studio, lib);
  mkdirSync(join(studio, "executors"), { recursive: true });
  writeFileSync(join(studio, "executors", "scripts.yaml"), studioScriptsYaml());
  mkdirSync(join(studio, "source-catalog"), { recursive: true });
  writeFileSync(join(studio, "source-catalog", "sources.yaml"), "schema_version: harness.sources/v1\nsources: []\n");

  const rawDir = join(studio, "raw");
  mkdirSync(rawDir, { recursive: true });
  const sample = join(rawDir, "sample-5s.mp4");
  const samplesTxt = join(rawDir, "samples.txt");
  if (media) {
    makeVideo(sample, { seconds: 5, audio: true });
    writeFileSync(samplesTxt, `${posix(sample)}\n`);
  }

  const channel = mkdtempSync(join(tmpdir(), "channel-"));
  writeProjectYaml(CHANNEL_FIXTURE, channel, lib);
  mkdirSync(join(channel, "source-catalog"), { recursive: true });
  writeFileSync(join(channel, "source-catalog", "sources.yaml"), "schema_version: harness.sources/v1\nsources: []\n");

  migrate(studio);
  migrate(channel);

  return { lib, studio, channel, sample, samplesTxt };
}

/** Rewrites one resource capacity in a temp project's `project.yaml`. Setting a capacity to 0 starves every
 * stage that requires it, so `claim()` skips those candidates and falls through to the next ready stage --
 * the same trick `setGpuCapacity` plays for the footage fixture. */
export function setResourceCapacity(project: string, resource: string, capacity: number): void {
  const path = join(project, "project.yaml");
  const cfg = parse(readFileSync(path, "utf8")) as { resources?: Record<string, number> };
  cfg.resources = { ...cfg.resources, [resource]: capacity };
  writeFileSync(path, stringify(cfg));
}

function withStudioStore<T>(world: LibraryWorld, fn: (store: StateStore) => T): T {
  const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/**
 * A content request in the studio's DB, as `library sync` used to mirror it from the kho before GĐ3 removed
 * the request flow. `media compose` still reads exactly one thing off it -- `requested_by.channel_id`, the
 * channel whose brand the episode is built with (`brandChannelIdFor`) -- so it is written straight into the
 * studio store. Returns the new `request_id`, for the brief's `request_id`.
 */
export function seedRequest(world: LibraryWorld, o: { topic: string; channelId?: string }): string {
  const now = new Date().toISOString();
  const request = ContentRequestSchema.parse({
    schema_version: "harness.content-request/v1",
    request_id: newId("content_request"),
    requested_by: { portfolio_id: "portfolio-channel", channel_id: o.channelId ?? "channel-one" },
    topic: o.topic,
    status: "open",
    created_at: now,
    updated_at: now,
  });
  withStudioStore(world, (store) => store.upsertContentRequest(request));
  return request.request_id;
}

/**
 * A channel-owned brand profile in the kho (sub-project 5B), written by the CHANNEL role exactly as an
 * operator would (`harness library brands set --from <brand.json>`). The studio reads brands straight off the
 * kho (`loadBrand`), so nothing needs mirroring into its DB.
 *
 * The harness ships no font, so the two font files are copies of whatever `systemFontPath()` finds; with no
 * system font this returns `false` and writes nothing -- the caller SKIPS that scenario instead of failing.
 * `withLogo` additionally generates a 64x64 PNG with ffmpeg (skipped, with `logo` left off the profile, when
 * ffmpeg is not on PATH).
 */
export function setBrand(world: LibraryWorld, channelId: string, o: {
  withLogo?: boolean;
  tracks?: string[];
  subtitles?: "burn-in" | "karaoke" | "none";
  /** `brand.transition` (spec §2.1): the default across every cut of this channel's episodes. Left off, the
   * schema default `{ kind: "cut", seconds: 0.4 }` applies and no segment ever gets a tail rendered. */
  transition?: { kind: "cut" | "dissolve" | "dip_black"; seconds?: number };
} = {}): boolean {
  const font = systemFontPath();
  if (!font) return false;

  const dir = mkdtempSync(join(tmpdir(), "brandsrc-"));
  const fontsDir = join(dir, "fonts");
  mkdirSync(fontsDir, { recursive: true });
  // Two files, same bytes: `library brands set` copies each by basename and records a checksum per path, so
  // `verifyBrandFiles` still has two independent files to check. One real font stands in for both weights --
  // nothing in the harness reads the font's own weight metadata, only libass does, at render time.
  const regular = join(fontsDir, "Regular.ttf");
  const bold = join(fontsDir, "Bold.ttf");
  copyFileSync(font, regular);
  copyFileSync(font, bold);

  let logo: { path: string } | undefined;
  if (o.withLogo && hasFfmpeg()) {
    const logoPath = join(dir, "logo.png");
    makeLogoPng(logoPath);
    logo = { path: "logo.png" };
  }

  const brand = {
    schema_version: "harness.brand/v1",
    channel_id: channelId,
    revision: 1,
    fonts: { regular: "fonts/Regular.ttf", bold: "fonts/Bold.ttf", origin: "royalty_free", origin_note: "system font, copied for tests" },
    colors: { primary: "#F2C94C" },
    ...(logo ? { logo } : {}),
    ...(o.subtitles ? { subtitles: { mode: o.subtitles } } : {}),
    ...(o.transition ? { transition: { kind: o.transition.kind, ...(o.transition.seconds !== undefined ? { seconds: o.transition.seconds } : {}) } } : {}),
    ...(o.tracks ? { music: { tracks: o.tracks } } : {}),
  };
  const path = join(dir, "brand.json");
  writeFileSync(path, JSON.stringify(brand, null, 2));

  const r = cli(world.channel, ["library", "brands", "set", channelId, "--from", path, "--json"]);
  if (r.code !== 0) throw new Error(`library brands set ${channelId} failed: ${r.err}\n${r.out}`);
  return true;
}

/** A 64x64 solid-colour PNG with a contrasting square in it, so `render-valid`'s "the logo corner is not a
 * flat colour" probe has something to see. */
function makeLogoPng(path: string): void {
  const r = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=white:s=64x64:d=1",
    "-vf", "drawbox=x=8:y=8:w=48:h=48:color=red@1:t=fill", "-frames:v", "1", path,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg logo generation failed: ${r.stderr}`);
}

/** A kho-wide background music track (sub-project 5B), added by the CHANNEL role the way an operator would
 * (`harness library music add`) from an 8 s sine wav. `media compose` resolves a brand's tracks through the
 * studio's DB mirror (`activeTracks`), which `library sync` used to fill before GĐ3; the kho's `track.json`
 * is upserted into the studio store directly instead. Returns `trackId`. */
export function addTrack(world: LibraryWorld, trackId: string, o: { mood?: string[]; seconds?: number; loopOk?: boolean; frequency?: number } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "track-"));
  const src = join(dir, `${trackId}.wav`);
  // 220 Hz by default, an octave below the 440 Hz tone the other media helpers generate, so a mixed
  // episode's music is distinguishable in a spectrum when someone listens to a test render.
  makeWav(src, o.seconds ?? 8, { frequency: o.frequency ?? 220 });
  // `--origin` accepts own|licensed|royalty_free (MUSIC_ORIGINS); "own" is the honest one for a file this
  // test generated itself.
  const args = [
    "library", "music", "add", "--track-id", trackId, "--file", src,
    "--display-name", `Track ${trackId}`, "--mood", (o.mood ?? ["calm"]).join(","),
    "--origin", "own", "--origin-note", "sinh bằng ffmpeg cho test", "--json",
  ];
  if (o.loopOk ?? true) args.push("--loop-ok");
  const r = cli(world.channel, args);
  if (r.code !== 0) throw new Error(`library music add ${trackId} failed: ${r.err}\n${r.out}`);
  const track = MusicTrackSchema.parse(JSON.parse(readFileSync(libraryPaths(world.lib).trackFile(trackId), "utf8")));
  withStudioStore(world, (store) => store.upsertMusicTrack(track));
  return trackId;
}
