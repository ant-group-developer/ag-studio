import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { newId, type ContentRequest, type LibraryItem } from "@harness/contracts";
import { HARNESS_ROOT } from "@harness/core";
import { hasFfmpeg, makeVideo } from "../media.js";
import { cli } from "./footage-helpers.js";

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
function writeProjectYaml(fixtureDir: string, dir: string, lib: string, o: { autopilot?: boolean } = {}): void {
  const cfg = parse(readFileSync(join(fixtureDir, "project.yaml"), "utf8")) as {
    data_root: string;
    library: { root: string; auto_accept?: unknown };
    adapters?: { agent?: string; agent_argv?: string[] };
  };
  cfg.data_root = posix(join(dir, "data"));
  cfg.library.root = posix(lib);
  if (fixtureDir === STUDIO_FIXTURE) {
    if (o.autopilot) {
      cfg.adapters = { agent: "cli", agent_argv: [process.execPath, posix(FAKE_AGENT_CLI), "{prompt}"] };
      // Task 8: the studio profile moved to library-production@1.2.0, but every sub-project 4 autopilot test
      // was written against 1.1.0's stage keys/counts -- pin the autopilot to the release it was written for
      // via `library.auto_accept.workflow_release` (the operator's own documented rollback knob) rather than
      // letting it silently follow the profile forward. Task 10 adds an opt-in for 1.2.0.
      const auto = (cfg.library.auto_accept ?? {}) as Record<string, unknown>;
      cfg.library.auto_accept = { ...auto, workflow_release: "library-production@1.1.0" };
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
 */
export function freshLibraryWorld(o: { media?: boolean; autopilot?: boolean } = {}): LibraryWorld {
  const media = o.media ?? true;
  const autopilot = o.autopilot ?? false;
  const lib = mkdtempSync(join(tmpdir(), "kho-"));
  // the top-level kho directories a mounted share would already have; `doctor`'s `library:write` row probes
  // `styles/` (studio) and `requests/` (channel) and fails when they are missing, and (sub-project 5A)
  // `library:voices` fails the same way for either role when `voices/` itself is absent.
  for (const sub of ["styles", "requests", "items", "voices"]) mkdirSync(join(lib, sub), { recursive: true });

  const studio = mkdtempSync(join(tmpdir(), "studio-"));
  writeProjectYaml(STUDIO_FIXTURE, studio, lib, { autopilot });
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
export function requestCreate(world: LibraryWorld, o: { topic: string; style: string; sourceHint?: string; voice?: string; duration?: [number, number] }): string {
  const [min, max] = o.duration ?? [1, 60];
  const args = ["library", "request", "create", "--portfolio", "portfolio-channel", "--channel", "channel-one", "--topic", o.topic, "--style", o.style, "--duration", `${min},${max}`, "--json"];
  if (o.sourceHint) args.push("--source-hint", o.sourceHint);
  if (o.voice) args.push("--voice", o.voice);
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
