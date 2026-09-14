import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { newId, type LibraryItem } from "@harness/contracts";
import { HARNESS_ROOT } from "@harness/core";
import { makeVideo } from "../media.js";
import { cli } from "./footage-helpers.js";

export { cli, cliAsync, drain, stageId, status, submitGate, SAMPLE_EDL } from "./footage-helpers.js";

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
 * resources) stays exactly as the fixture declares it. */
function writeProjectYaml(fixtureDir: string, dir: string, lib: string): void {
  const cfg = parse(readFileSync(join(fixtureDir, "project.yaml"), "utf8")) as { data_root: string; library: { root: string } };
  cfg.data_root = posix(join(dir, "data"));
  cfg.library.root = posix(lib);
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
 * (they need ffmpeg); the acceptance tests that hand-write kho files take `media: false`.
 */
export function freshLibraryWorld(o: { media?: boolean } = {}): LibraryWorld {
  const media = o.media ?? true;
  const lib = mkdtempSync(join(tmpdir(), "kho-"));
  // the three top-level kho directories a mounted share would already have; `doctor`'s `library:write` row
  // probes `styles/` (studio) and `requests/` (channel) and fails when they are missing.
  for (const sub of ["styles", "requests", "items"]) mkdirSync(join(lib, sub), { recursive: true });

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
 * `"checksum"` rewrites the data file after the manifest was computed.
 */
export function writeLibraryItem(lib: string, o: {
  itemId: string;
  styleId: string;
  status: LibraryItem["status"];
  titleHint?: string;
  requestId?: string;
  corrupt?: "manifest" | "checksum";
}): void {
  const dir = join(lib, "items", o.itemId);
  mkdirSync(dir, { recursive: true });
  const body = `fake episode bytes for ${o.itemId}\n`;
  writeFileSync(join(dir, "episode.mp4"), body);

  if (o.corrupt === "manifest") {
    writeFileSync(join(dir, "manifest.json"), "{ this is not valid JSON");
    return;
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
    files: [{ path: "episode.mp4", checksum: "sha256:" + createHash("sha256").update(body).digest("hex"), size_bytes: Buffer.byteLength(body), mime_type: "video/mp4" }],
    lineage: { project_id: "project-studio", run_id: newId("run"), content_id: newId("content_item"), source_ids: [] },
    review: { note: "" },
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(item, null, 2) + "\n");

  // after the manifest was written, so its checksum no longer describes what is on disk
  if (o.corrupt === "checksum") writeFileSync(join(dir, "episode.mp4"), `${body}tampered\n`);
}

/** `harness library sync --json` on a project, asserting it found nothing corrupt. */
export function librarySync(project: string): { imported: { styles: string[]; requests: string[]; items: string[] }; updated: { styles: string[]; requests: string[]; items: string[] }; corrupt: { path: string; reason: string }[] } {
  const r = cli(project, ["library", "sync", "--json"]);
  if (r.code !== 0) throw new Error(`library sync failed in ${project}: ${r.err}\n${r.out}`);
  return JSON.parse(r.out);
}
