import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { fileURLToPath } from "node:url";
import { newId, type ContentRequest, type LibraryItem, type VoiceProfile } from "@harness/contracts";
import { HARNESS_ROOT, SqliteStateStore } from "@harness/core";
import { hasFfmpeg, makeSceneClip, makeVideo, makeWav, systemFontPath } from "../media.js";
import { cli, status } from "./footage-helpers.js";

export { cli, cliAsync, drain, stageId, status, submitGate, SAMPLE_EDL } from "./footage-helpers.js";

export const STUDIO_FIXTURE = join(HARNESS_ROOT, "fixtures", "ops-project-studio");
export const CHANNEL_FIXTURE = join(HARNESS_ROOT, "fixtures", "ops-project-channel");
const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
const FAKE_AGENT_CLI = join(HARNESS_ROOT, "fixtures", "fake-agent-cli.mjs");

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
 * resources) stays exactly as the fixture declares it -- except, for the studio fixture only, `adapters`
 * and `library.auto_accept`, which this function always overwrites outright (never merges) based on
 * `autopilot`: true rewrites `adapters.agent_argv` to absolute paths (`node`/`../fake-agent-cli.mjs` only
 * resolve from the fixture directory itself, see that file's committed adapters comment) so the studio
 * autopilot loop can actually spawn the fake agent from a temp project; false/omitted strips `adapters` and
 * `library.auto_accept` entirely, reproducing the pre-task-8 fixture shape (`agent: fake`, no auto-accept)
 * so every existing 2C test (library-pipeline, studio-wrappers) is unaffected by the fixture now shipping
 * autopilot enabled by default for real (non-test) use. */
function writeProjectYaml(fixtureDir: string, dir: string, lib: string, o: { autopilot?: boolean; media1_2?: boolean; media1_3?: boolean } = {}): void {
  const cfg = parse(readFileSync(join(fixtureDir, "project.yaml"), "utf8")) as {
    data_root: string;
    library: { root: string; auto_accept?: unknown };
    adapters?: { agent?: string; agent_argv?: string[]; media?: string };
  };
  cfg.data_root = posix(join(dir, "data"));
  cfg.library.root = posix(lib);
  if (fixtureDir === STUDIO_FIXTURE) {
    if (o.autopilot) {
      cfg.adapters = { agent: "cli", agent_argv: [process.execPath, posix(FAKE_AGENT_CLI), "{prompt}"], media: "fake" };
      const auto = (cfg.library.auto_accept ?? {}) as Record<string, unknown>;
      if (o.media1_3) {
        // Sub-project 5B Task 8: the 5B world -- NO `workflow_release` pin, so the autopilot follows the
        // studio profile forward (revision 4 -> library-production@1.3.0), plus the same COLLECTION source
        // picking `media1_2` uses.
        cfg.library.auto_accept = { ...auto, source_collections: ["shoot-*"] };
      } else if (o.media1_2) {
        // Task 10 (5A): the sub-project 5A world -- COLLECTION source picking (the studio autopilot's second
        // explicit mode since task 7: a whole shoot per request instead of one clip), pinned to 1.2.0.
        // Sub-project 5B moved the studio profile to library-production@1.3.0, so what used to be "follow the
        // profile" is now an explicit pin via `library.auto_accept.workflow_release` (ADR 111's documented
        // rollback knob) -- exactly the way the 1.1.0 branch below has always worked.
        cfg.library.auto_accept = { ...auto, source_collections: ["shoot-*"], workflow_release: "library-production@1.2.0" };
      } else {
        // Task 8: the studio profile moved to library-production@1.2.0, but every sub-project 4 autopilot test
        // was written against 1.1.0's stage keys/counts -- pin the autopilot to the release it was written for
        // via `library.auto_accept.workflow_release` (the operator's own documented rollback knob) rather than
        // letting it silently follow the profile forward.
        cfg.library.auto_accept = { ...auto, workflow_release: "library-production@1.1.0" };
      }
    } else {
      delete cfg.adapters;
      delete cfg.library.auto_accept;
    }
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
  /** Temp studio ops project (role `studio`, workflows style-study + library-production). */
  studio: string;
  /** Temp channel ops project (role `channel`, no workflows). */
  channel: string;
  /** `raw/sample-5s.mp4` in the studio project — the footage every production run cuts from. */
  sample: string;
  /** `raw/samples.txt` in the studio project — one video path per line, what `collect-samples` studies. */
  samplesTxt: string;
}

/**
 * A studio project and a channel project on one shared kho, both migrated, plus the media the style-study
 * and library-production workflows run on. `sample`/`samplesTxt` are only written when `media` is true
 * (they need ffmpeg); the acceptance tests that hand-write kho files take `media: false`. `autopilot: true`
 * (task 8) rewrites the studio project's `adapters`/`library.auto_accept` so `worker --once` alone can drive
 * a channel request all the way to an approved item through the fake agent CLI -- see `writeProjectYaml`'s
 * own comment for exactly what that overwrites. Defaults to `false`, reproducing the pre-task-8 studio
 * project (`agent: fake`, no auto-accept) so every existing 2C test is unaffected.
 *
 * `media1_2: true` (task 10, sub-project 5A) implies `autopilot` and swaps that pin for the 5A world:
 * `library-production@1.2.0` (an explicit pin since 5B moved the profile on), `adapters.media: fake`
 * (`FakeMediaEngine`, no Python/GPU), and COLLECTION source picking over `shoot-*` -- pair it with
 * `ingestShoot(world, "shoot-a", n)`.
 *
 * `media1_3: true` (sub-project 5B task 8) is the same world one release forward: NO pin at all, so the
 * autopilot follows the studio profile to `library-production@1.3.0` (`media-compose`/`media-render`).
 * Pair it with `setBrand`/`addTrack` when the episode should carry text, subtitles and music.
 */
export function freshLibraryWorld(o: { media?: boolean; autopilot?: boolean; media1_2?: boolean; media1_3?: boolean } = {}): LibraryWorld {
  const media = o.media ?? true;
  const media1_2 = o.media1_2 ?? false;
  const media1_3 = o.media1_3 ?? false;
  const autopilot = (o.autopilot ?? false) || media1_2 || media1_3;
  const lib = mkdtempSync(join(tmpdir(), "kho-"));
  // the top-level kho directories a mounted share would already have; `doctor`'s `library:write` row probes
  // `styles/` (studio) and `requests/` (channel) and fails when they are missing, (sub-project 5A)
  // `library:voices` fails the same way for either role when `voices/` itself is absent, and (sub-project 5B)
  // `library:music` fails the same way for either role when `music/` is absent (`library:brands`, studio-only,
  // does not need its directory to exist at all -- an empty/missing `brands/` is just "no channel has a brand
  // yet", not a failure, so it is deliberately left uncreated here).
  for (const sub of ["styles", "requests", "items", "voices", "music"]) mkdirSync(join(lib, sub), { recursive: true });

  const studio = mkdtempSync(join(tmpdir(), "studio-"));
  writeProjectYaml(STUDIO_FIXTURE, studio, lib, { autopilot, media1_2, media1_3 });
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

/** A schema-valid `EditStyle` as the `analyze-style` gate would write it (`draft` by default; `active` is
 * what `style-review` submits and what `library accept` requires). */
export const SAMPLE_STYLE = (styleId: string, status: "draft" | "active" | "retired" = "draft"): string =>
  JSON.stringify(
    {
      schema_version: "harness.edit-style/v1",
      style_id: styleId,
      revision: 1,
      name: "Chợ nổi fast-cut",
      status,
      learned_from: [{ label: "sample-5s.mp4", notes: "reference clip collected by collect-samples" }],
      params: {
        cut_rhythm: "fast",
        shot_seconds: [1, 3],
        transitions: ["cut"],
        text_overlay: { style: "bold", density: "medium" },
        subtitles: "burn-in",
        music: { mood: "upbeat", ducking: true },
        opening: { seconds: 2, structure: "hook" },
        aspect_ratio: "16:9",
        pace_notes: "giữ nhịp nhanh ở 10 giây đầu",
      },
      evidence: [],
      created_at: "2026-09-14T00:00:00.000Z",
      updated_at: "2026-09-14T00:00:00.000Z",
    },
    null,
    2,
  );

/** Writes `SAMPLE_STYLE(styleId, "active")` straight into the kho, standing in for a finished style-study
 * run in the scenarios that are not about style-study itself. */
export function writeActiveStyle(lib: string, styleId: string): void {
  const dir = join(lib, "styles", styleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "style.json"), SAMPLE_STYLE(styleId, "active") + "\n");
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

/**
 * Writes an `items/<id>/` the way `library-export` would have: one data file plus a manifest whose
 * `files` entry carries that file's real checksum and size. `corrupt` bends exactly one of the two so the
 * item is what `syncLibrary` reports as corrupt: `"manifest"` leaves unparseable JSON in manifest.json,
 * `"checksum"` rewrites the data file after the manifest was computed. `extraFiles` writes additional
 * `items/<id>/<path>` entries into the manifest's `files` array alongside `episode.mp4` (e.g. thumbnail
 * candidates a channel-publish run needs) -- a compatible addition, so every existing caller is unaffected.
 *
 * `episode.mp4` itself is a real (tiny) video via `makeVideo` when ffmpeg is on PATH, so a `media-probe`
 * check downstream (the channel-publish `fetch-library-item` stage requires it) gets a decodable file
 * instead of failing on plain text; when ffmpeg is unavailable this falls back to the original fake-bytes
 * body (unchanged from before), which is fine because `media-probe` itself skips without a prober.
 */
export function writeLibraryItem(lib: string, o: {
  itemId: string;
  styleId: string;
  status: LibraryItem["status"];
  titleHint?: string;
  requestId?: string;
  corrupt?: "manifest" | "checksum";
  extraFiles?: { path: string; body: string; mime_type: string }[];
}): void {
  const dir = join(lib, "items", o.itemId);
  mkdirSync(dir, { recursive: true });
  const videoPath = join(dir, "episode.mp4");
  let body: Buffer | string;
  if (hasFfmpeg()) {
    makeVideo(videoPath, { seconds: 2, audio: true });
    body = readFileSync(videoPath);
  } else {
    body = `fake episode bytes for ${o.itemId}\n`;
    writeFileSync(videoPath, body);
  }

  if (o.corrupt === "manifest") {
    writeFileSync(join(dir, "manifest.json"), "{ this is not valid JSON");
    return;
  }

  const files: LibraryItem["files"] = [
    { path: "episode.mp4", checksum: "sha256:" + createHash("sha256").update(body).digest("hex"), size_bytes: Buffer.byteLength(body), mime_type: "video/mp4" },
  ];
  for (const f of o.extraFiles ?? []) {
    writeFileSync(join(dir, f.path), f.body);
    files.push({ path: f.path, checksum: "sha256:" + createHash("sha256").update(f.body).digest("hex"), size_bytes: Buffer.byteLength(f.body), mime_type: f.mime_type });
  }

  const item: LibraryItem = {
    schema_version: "harness.library-item/v1",
    item_id: o.itemId,
    status: o.status,
    title_hint: o.titleHint ?? `Item ${o.status}`,
    summary: "",
    style: { style_id: o.styleId, revision: 1 },
    ...(o.requestId ? { request_id: o.requestId } : {}),
    duration_seconds: 5,
    media: null,
    files,
    lineage: { project_id: "project-studio", run_id: newId("run"), content_id: newId("content_item"), source_ids: [] },
    review: { note: "" },
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(item, null, 2) + "\n");

  // after the manifest was written, so its checksum no longer describes what is on disk
  if (o.corrupt === "checksum") {
    writeFileSync(videoPath, typeof body === "string" ? `${body}tampered\n` : Buffer.concat([body, Buffer.from("tampered")]));
  }
}

/** `harness library sync --json` on a project, asserting it found nothing corrupt. */
export function librarySync(project: string): { imported: { styles: string[]; requests: string[]; items: string[] }; updated: { styles: string[]; requests: string[]; items: string[] }; corrupt: { path: string; reason: string }[] } {
  const r = cli(project, ["library", "sync", "--json"]);
  if (r.code !== 0) throw new Error(`library sync failed in ${project}: ${r.err}\n${r.out}`);
  return JSON.parse(r.out);
}

/** Env every `cli()`/`drain()` call against an autopilot studio project should carry: `FAKE_YTDLP=1` so
 * `collect-samples.mjs` fakes downloading any `https://` line in `samples.txt` instead of shelling a real
 * yt-dlp (spec/task-6), plus whatever the caller layers on top (`FAKE_REVIEW_MODE`, `FAKE_AGENT_FAIL_STAGE`,
 * ...). `world` is unused today but kept in the signature -- every other studio-world helper here takes it
 * first, and a future per-world default (e.g. a distinct fake yt-dlp fixture) would slot in without
 * breaking callers. */
export function studioEnv(world: LibraryWorld, extra: Record<string, string> = {}): Record<string, string> {
  void world;
  return { FAKE_YTDLP: "1", ...extra };
}

/** Channel `library request create --json`, returning the new request's id. Mirrors the CLI's own option
 * names (`--source-hint`, `--voice`, `--duration`) one-to-one so a caller reads like the command it drives.
 * `duration` defaults to `[1, 60]` (comfortably wide for the few-second samples these worlds cut from) --
 * the `assemble` stage's `brief-duration` required check (workflows/library-production@{1.0.0,1.1.0}) skips
 * without a `target_duration_seconds` on the request, and a skipped *required* check fails the stage just
 * like an outright `fail` would (AGENTS.md: "skip không phải là pass"), so every request an autopilot test
 * expects to reach `assemble` needs one. */
export function requestCreate(world: LibraryWorld, o: { topic: string; style: string; sourceHint?: string; voice?: string; voiceId?: string; duration?: [number, number]; language?: string }): string {
  const [min, max] = o.duration ?? [1, 60];
  const args = ["library", "request", "create", "--portfolio", "portfolio-channel", "--channel", "channel-one", "--topic", o.topic, "--style", o.style, "--duration", `${min},${max}`, "--json"];
  if (o.sourceHint) args.push("--source-hint", o.sourceHint);
  if (o.voice) args.push("--voice", o.voice);
  // `--voice tts` is rejected at creation time without an ACTIVE voice profile (`createRequest` ->
  // `requireActiveVoice`), so every tts request in these tests carries an `addVoice()` id.
  if (o.voiceId) args.push("--voice-id", o.voiceId);
  if (o.language) args.push("--language", o.language);
  const r = cli(world.channel, args);
  if (r.code !== 0) throw new Error(`library request create failed: ${r.err}\n${r.out}`);
  return (JSON.parse(r.out) as ContentRequest).request_id;
}

/** The request exactly as the kho file has it (not the studio's DB mirror, which only reflects the last
 * `library sync`/auto-sync poll) -- `reopenRequest`/`fulfillRequest`/`claimRequest` all write straight
 * through to this file, so reading it is always current regardless of sync cadence. */
export function requestStatus(world: LibraryWorld, requestId: string): ContentRequest {
  return JSON.parse(readFileSync(join(world.lib, "requests", `${requestId}.json`), "utf8")) as ContentRequest;
}

/** Drives the studio autopilot loop: `worker --once` (env defaulting through `studioEnv`) up to `max` times,
 * stopping as soon as `pred()` is true. Unlike `drain()` (which stops at the first "idle" result), a single
 * "idle" poll here may have just silently planned a *new* run via auto-accept -- its first stage only gets
 * claimed on the *next* call -- so this keeps polling on a domain predicate instead of the worker's own
 * idle/busy signal. Does not throw when `max` is exhausted without `pred()` going true: the caller's own
 * `expect` on whatever `pred` was checking gives a far more useful failure than a generic timeout would. */
export function studioWorkerUntil(world: LibraryWorld, pred: () => boolean, max = 60, env: Record<string, string> = {}): void {
  for (let i = 0; i < max && !pred(); i++) cli(world.studio, ["worker", "--once"], studioEnv(world, env));
}

/** Four distinct colour triples, cycled over a shoot's clips: two clips must never be byte-identical or
 * `source ingest` deduplicates them by checksum into a single source item -- and that applies ACROSS shoots
 * too, which is why the cycle starts at a per-collection offset (`collectionSeed`) rather than at 0. */
const SHOOT_COLORS = [["red", "blue", "green"], ["blue", "green", "yellow"], ["green", "yellow", "red"], ["yellow", "red", "blue"]];

/** A small stable number per collection name, used to give each shoot its own colours, frame size and tone
 * so no two shoots can generate the same bytes for the same clip index. */
function collectionSeed(collection: string): number {
  let h = 0;
  for (const ch of collection) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return h;
}

/**
 * A whole shoot (sub-project 5A: a collection is one shooting session): `n` distinct ffmpeg clips of 6-10 s,
 * each three solid-colour scenes so `media-index` finds two scene cuts in it, ingested in one
 * `harness source ingest <dir> --collection <collection>`. Returns the new `source_id`s in ingest order.
 *
 * Every clip differs in duration, colours and audio tone, so none of them dedupe against another by checksum.
 * `withAudio: false` produces video-only clips (`has_audio: false`, which `media-transcribe` skips);
 * `audioSeconds` shortens the tone so the clip ends in real silence -- the tail `voice: original` cut
 * snapping needs something to snap to (see `makeSceneClip`). `silentClips` names the clip indexes that get
 * NO audio track while the rest do: a shoot that mixes sound and silence, which is the headline 5A scenario
 * and the one `assemble.mjs` used to decide for the whole shoot from its first clip alone.
 */
export function ingestShoot(world: LibraryWorld, collection: string, n: number, o: { withAudio?: boolean; audioSeconds?: number; language?: string; silentClips?: number[] } = {}): string[] {
  const withAudio = o.withAudio ?? true;
  const silent = new Set(o.silentClips ?? []);
  const seed = collectionSeed(collection);
  const dir = mkdtempSync(join(tmpdir(), `${collection}-`));
  for (let i = 0; i < n; i++) {
    const seconds = 6 + (i % 5); // 6..10 s
    makeSceneClip(join(dir, `clip-${String(i).padStart(2, "0")}.mp4`), {
      seconds,
      colors: SHOOT_COLORS[(seed + i) % SHOOT_COLORS.length]!,
      size: `${320 + 2 * (seed % 8)}x180`,
      audio: withAudio && !silent.has(i) ? { frequency: 300 + ((seed + i * 7) % 23) * 37, ...(o.audioSeconds !== undefined ? { seconds: Math.min(o.audioSeconds, seconds) } : {}) } : null,
    });
  }
  const r = cli(world.studio, ["source", "ingest", dir, "--collection", collection, "--rights", "cleared", "--language", o.language ?? "en", "--json"]);
  if (r.code !== 0) throw new Error(`source ingest ${dir} failed: ${r.err}\n${r.out}`);
  const ingested = (JSON.parse(r.out) as { ingested: { source_id: string; created: boolean }[] }).ingested;
  // A clip whose bytes an earlier shoot already registered comes back `created: false` and KEEPS that earlier
  // collection, so `--source-hint <collection>` would silently find nothing later -- fail here instead.
  const reused = ingested.filter((i) => !i.created);
  if (ingested.length !== n || reused.length > 0) {
    throw new Error(`source ingest ${dir} registered ${ingested.length} sources (${reused.length} deduplicated against an earlier shoot), expected ${n} new ones`);
  }
  return ingested.map((i) => i.source_id);
}

/**
 * A channel-owned TTS voice profile, written by the CHANNEL role exactly as an operator would
 * (`harness library voices add`, which validates the reference clip and converts it to 24 kHz mono), then
 * mirrored into the studio's DB with one `library sync` so `intake`/`media-tts` can resolve it right away
 * instead of waiting for the worker's own `sync_seconds` poll. `voiceId` bumps an existing profile
 * (revision + 1) instead of minting a new one.
 */
export function addVoice(world: LibraryWorld, voiceId?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "voiceref-"));
  const ref = join(dir, "ref.wav");
  makeWav(ref, 6);
  const args = [
    "library", "voices", "add", "--display-name", "Kênh một — giọng thử",
    "--ref", ref, "--ref-text", "This is the reference clip, word for word.",
    "--language", "en", "--origin", "synthetic", "--origin-note", "sinh bằng ffmpeg cho test",
    "--json",
  ];
  if (voiceId) args.push("--voice-id", voiceId);
  const r = cli(world.channel, args);
  if (r.code !== 0) throw new Error(`library voices add failed: ${r.err}\n${r.out}`);
  const profile = JSON.parse(r.out) as VoiceProfile;
  librarySync(world.studio);
  return profile.voice_id;
}

/**
 * A channel-owned brand profile in the kho (sub-project 5B), written by the CHANNEL role exactly as an
 * operator would (`harness library brands set --from <brand.json>`), then mirrored into the studio's DB with
 * one `library sync` so `intake`/`media-compose` resolve it right away.
 *
 * The harness ships no font, so the two font files are copies of whatever `systemFontPath()` finds; with no
 * system font this returns `false` and writes nothing -- the caller SKIPS that scenario instead of failing.
 * `withLogo` additionally generates a 64x64 PNG with ffmpeg (skipped, with `logo` left off the profile, when
 * ffmpeg is not on PATH). `music` is left empty here on purpose: `addTrack` fills it, so a test that wants a
 * brand without music simply never calls it.
 */
export function setBrand(world: LibraryWorld, channelId: string, o: { withLogo?: boolean; tracks?: string[]; subtitles?: "burn-in" | "karaoke" | "none" } = {}): boolean {
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
    ...(o.tracks ? { music: { tracks: o.tracks } } : {}),
  };
  const path = join(dir, "brand.json");
  writeFileSync(path, JSON.stringify(brand, null, 2));

  const r = cli(world.channel, ["library", "brands", "set", channelId, "--from", path, "--json"]);
  if (r.code !== 0) throw new Error(`library brands set ${channelId} failed: ${r.err}\n${r.out}`);
  librarySync(world.studio);
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
 * (`harness library music add`) from an 8 s sine wav, then mirrored into the studio DB. Returns `trackId`. */
export function addTrack(world: LibraryWorld, trackId: string, o: { mood?: string[]; seconds?: number; loopOk?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "track-"));
  const src = join(dir, `${trackId}.wav`);
  makeWav(src, o.seconds ?? 8);
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
  librarySync(world.studio);
  return trackId;
}

/**
 * Every run the studio autopilot planned for `requestId`, oldest first, read from the `request.auto_accepted`
 * events rather than from the run table -- the event carries `replan_no`, which is what separates a first
 * attempt from the replan the SP4 reject loop produced, and needs no join through ContentItem.
 */
export function autoAcceptedRuns(world: LibraryWorld, requestId: string): { run_id: string; replan_no: number }[] {
  const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
  try {
    return store.listEvents({ event_type: "request.auto_accepted" })
      .filter((e) => e.payload.request_id === requestId)
      .map((e) => ({ run_id: String(e.payload.run_id), replan_no: Number(e.payload.replan_no) }))
      .sort((a, b) => a.replan_no - b.replan_no);
  } finally {
    store.close();
  }
}

/** An artifact's on-disk path for one stage of one run (`status --json`'s artifacts carry a `uri` even though
 * `StatusJson` does not declare the field); undefined when that stage has not produced it (yet). */
export function artifactPathFor(project: string, runId: string, stageKey: string, type: string): string | undefined {
  const st = status(project, runId);
  const sid = st.stages.find((s) => s.stage_key === stageKey)?.stage_run_id;
  if (!sid) return undefined;
  const found = st.artifacts.find((a) => a.stage_run_id === sid && a.type === type) as unknown as { uri: string } | undefined;
  return found ? fileURLToPath(found.uri) : undefined;
}

/** Rewrites the studio project's `library.auto_accept.max_replans` in place (acceptance 28: forcing the
 * replan budget down to exercise the "exhausted" skip reason / `request_stuck` dashboard alert without
 * waiting for the default of 2). */
export function setMaxReplans(project: string, maxReplans: number): void {
  const path = join(project, "project.yaml");
  const cfg = parse(readFileSync(path, "utf8")) as { library: { auto_accept?: { max_replans: number } } };
  if (!cfg.library.auto_accept) throw new Error(`${path}: library.auto_accept is not set (need freshLibraryWorld({ autopilot: true }))`);
  cfg.library.auto_accept.max_replans = maxReplans;
  writeFileSync(path, stringify(cfg));
}
