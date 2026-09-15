import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Command } from "commander";
import { start, type ScriptContext } from "@harness/script-sdk";
import { HarnessError, isHarnessError, type ScriptCommand } from "@harness/contracts";
import { watchFromExistingFrames, watchVideos, type WatchDeps, type WatchVideoInput } from "@harness/core";
import type { AppContext } from "../composition.js";
import { withContext } from "./shared.js";

const MODES = ["samples", "source", "episode"] as const;
type WatchMode = (typeof MODES)[number];

/**
 * The three `harness media watch --mode <m>` re-invocations (task 2's spec §7 workflows wire `watch-samples`,
 * `watch-source`, `watch-episode` as `executor: { type: script, script: "watch-<mode>" }`), built in the same
 * shape as `builtinLibraryCommands`/`builtinPublishCommands` in `composition.ts`: each re-invokes this CLI
 * against the ops project, reading `stage-request.json` from the `ScriptExecutor`-provided workspace.
 */
export function builtinMediaCommands(argv: string[], projectDir: string): Record<string, ScriptCommand> {
  const commands: Record<string, ScriptCommand> = {};
  for (const mode of MODES) commands[`watch-${mode}`] = { argv: [...argv, "--project", projectDir, "media", "watch", "--mode", mode], cwd: "." };
  return commands;
}

/** Env for the transcribe hook's child process: everything the harness process itself has, minus every
 * `HARNESS_SECRET_*` var -- transcription needs no secrets, and this is the only allowlist/denylist this
 * hook gets (spec: "child processes never receive HARNESS_SECRET_*"). */
function childEnvWithoutSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.toUpperCase().startsWith("HARNESS_SECRET_")) continue;
    out[k] = v;
  }
  return out;
}

/**
 * `app.scripts?.scripts.transcribe`, resolved into `WatchDeps["transcribe"]` the same way
 * `scriptCommandsFrom` (packages/core/src/config/scripts.ts) resolves every other script entry's `cwd`
 * against the project directory -- `argv`/`timeout_seconds` pass straight through. `env_refs` on this entry
 * is deliberately never resolved here (unlike `scriptCommandsFrom`): a transcription CLI has no legitimate
 * reason to see a secret, so this hook simply never mints one.
 */
function transcribeHookFor(app: AppContext): WatchDeps["transcribe"] | undefined {
  const spec = app.scripts?.scripts.transcribe;
  if (!spec) return undefined;
  return { argv: spec.argv, cwd: resolve(app.projectDir, spec.cwd), timeout_seconds: spec.timeout_seconds ?? 900, env: childEnvWithoutSecrets() };
}

function watchDepsFor(app: AppContext, sdk: ScriptContext): WatchDeps {
  const transcribe = transcribeHookFor(app);
  return { prober: app.prober, log: (level, msg, data) => sdk.log[level](msg, data), ...(transcribe ? { transcribe } : {}) };
}

function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new HarnessError("IO_ERROR", `cannot read ${path}: ${(e as Error).message}`, { path });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new HarnessError("CONFIG_INVALID", `${path} is not valid JSON: ${(e as Error).message}`, { path });
  }
}

interface SampleEntry { label: string; path: string; frames?: string[] }

/** `samples.json` as `collect-samples.mjs` (fixtures/ops-project-studio) writes it today: `[{ index, path,
 * frames }]`, no `label` -- a future Task 6 wrapper adds `label`/`url`, so `label` is read defensively and
 * falls back to `String(index ?? <array position>)` per the task-3 brief. */
function parseSampleEntries(raw: unknown, samplesJsonPath: string): SampleEntry[] {
  if (!Array.isArray(raw)) throw new HarnessError("CONFIG_INVALID", `${samplesJsonPath} must be a JSON array`, { path: samplesJsonPath });
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object") throw new HarnessError("CONFIG_INVALID", `${samplesJsonPath}[${i}] must be an object`, { path: samplesJsonPath, index: i });
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== "string" || !e.path) throw new HarnessError("CONFIG_INVALID", `${samplesJsonPath}[${i}] must have a non-empty string "path"`, { path: samplesJsonPath, index: i });
    const label = typeof e.label === "string" && e.label ? e.label : String((e.index as unknown) ?? i);
    const frames = Array.isArray(e.frames) ? e.frames.filter((f): f is string => typeof f === "string") : undefined;
    return { label, path: e.path, ...(frames ? { frames } : {}) };
  });
}

/**
 * `--mode samples`: reads `sample_set/samples.json`. When every listed `path` still resolves to a file on
 * this machine, re-extracts frames from the real videos via `watchVideos` (ffmpeg); otherwise (the studio
 * fixture's shape today -- `path` was only ever meaningful on the machine `collect-samples` ran on) falls
 * back to the frames `collect-samples` already extracted, via `watchFromExistingFrames`. `path`/`frames`
 * entries may be relative to the `sample_set` directory or absolute (task-3 brief).
 */
async function handleSamples(app: AppContext, sdk: ScriptContext, outDir: string): Promise<void> {
  if (!sdk.hasInput("sample_set")) throw new HarnessError("CONFIG_INVALID", 'media watch --mode samples needs a "sample_set" input', {});
  const sampleSetDir = sdk.input("sample_set");
  const samplesJsonPath = join(sampleSetDir, "samples.json");
  if (!existsSync(samplesJsonPath)) throw new HarnessError("CONFIG_INVALID", `sample_set ${sampleSetDir} has no samples.json`, { dir: sampleSetDir });
  const entries = parseSampleEntries(readJsonFile(samplesJsonPath), samplesJsonPath);

  const resolvedPaths = entries.map((e) => (isAbsolute(e.path) ? e.path : join(sampleSetDir, e.path)));
  const allPathsExist = resolvedPaths.length > 0 && resolvedPaths.every((p) => existsSync(p));

  if (allPathsExist) {
    const videos: WatchVideoInput[] = entries.map((e, i) => ({ label: e.label, path: resolvedPaths[i]! }));
    await watchVideos(watchDepsFor(app, sdk), { mode: "samples", outDir }, videos);
    return;
  }
  const groups = entries.map((e) => ({
    label: e.label,
    source_path: e.path,
    frames: (e.frames ?? []).map((f) => (isAbsolute(f) ? f : join(sampleSetDir, f))),
  }));
  watchFromExistingFrames({ mode: "samples", outDir }, groups);
}

interface ShotsFile { shots: unknown }

/** `shots.json`: `{ shots: [{ in, out? }, ...] }` -- only `in` feeds `watchVideos`'s `shot_marks` (a frame at
 * every shot boundary, in addition to detected scene changes / interval sampling). */
function parseShotMarks(raw: unknown, shotsPath: string): number[] {
  const obj = raw as ShotsFile | null;
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.shots)) {
    throw new HarnessError("CONFIG_INVALID", `${shotsPath} must have a "shots" array`, { path: shotsPath });
  }
  return obj.shots.map((s, i) => {
    const inAt = (s as Record<string, unknown> | null)?.in;
    if (typeof inAt !== "number") throw new HarnessError("CONFIG_INVALID", `${shotsPath}.shots[${i}] must have a numeric "in"`, { path: shotsPath, index: i });
    return inAt;
  });
}

/** `--mode source`: the proxy video index-source produced, watched at scene+interval marks plus every shot
 * boundary from `shots.json` (task-3 brief: `watchVideos([{ label: "source", path: proxy, shot_marks:
 * shots[].in }])`). */
async function handleSource(app: AppContext, sdk: ScriptContext, outDir: string): Promise<void> {
  if (!sdk.hasInput("proxy_video")) throw new HarnessError("CONFIG_INVALID", 'media watch --mode source needs a "proxy_video" input', {});
  if (!sdk.hasInput("shots")) throw new HarnessError("CONFIG_INVALID", 'media watch --mode source needs a "shots" input', {});
  const proxyPath = sdk.input("proxy_video");
  const shotsPath = sdk.input("shots");
  const shot_marks = parseShotMarks(readJsonFile(shotsPath), shotsPath);
  await watchVideos(watchDepsFor(app, sdk), { mode: "source", outDir }, [{ label: "source", path: proxyPath, shot_marks }]);
}

/** `--mode episode`: the assembled episode video, watched at scene+interval marks only (no shot list). */
async function handleEpisode(app: AppContext, sdk: ScriptContext, outDir: string): Promise<void> {
  if (!sdk.hasInput("episode_video")) throw new HarnessError("CONFIG_INVALID", 'media watch --mode episode needs an "episode_video" input', {});
  const episodePath = sdk.input("episode_video");
  await watchVideos(watchDepsFor(app, sdk), { mode: "episode", outDir }, [{ label: "episode", path: episodePath }]);
}

const HANDLERS: Record<WatchMode, (app: AppContext, sdk: ScriptContext, outDir: string) => Promise<void>> = {
  samples: handleSamples, source: handleSource, episode: handleEpisode,
};

/**
 * `harness media watch --mode <samples|source|episode>`: extracts frames (scene changes + interval, plus
 * shot marks for `source`) and contact sheets via ffmpeg, optionally runs the `transcribe` hook, and writes
 * `output/watch/watch.json` (task 2's `watchVideos`/`watchFromExistingFrames`). Every mode needs ffmpeg on
 * PATH; `app.proberAvailable` (ffprobe -- installed alongside ffmpeg in every supported setup, and already
 * the signal `harness doctor` reports) stands in for that check so a missing toolchain fails the same way
 * `doctor` already flags it, without this stage separately shelling `ffmpeg -version`.
 */
async function watchStage(app: AppContext, sdk: ScriptContext, mode: string): Promise<void> {
  if (!MODES.includes(mode as WatchMode)) throw new HarnessError("CONFIG_INVALID", `unknown --mode "${mode}"; expected one of ${MODES.join("|")}`, { mode });
  if (!app.proberAvailable) throw new HarnessError("CONFIG_INVALID", "ffmpeg/ffprobe not found on PATH; media watch needs them (see `harness doctor`)", { mode });

  const outDir = join(sdk.workspace, "output", "watch");
  try {
    await HANDLERS[mode as WatchMode](app, sdk, outDir);
  } catch (e) {
    // Every ffmpeg spawn inside watch.ts reports a missing binary through spawnSync's returned `error`
    // (logged as a warn, frames just come up empty) rather than a thrown exception, so this branch is a
    // defensive backstop for the task-3 brief's "spawn ENOENT -> contract" case, not the primary path.
    if (e instanceof Error && e.message.includes("ENOENT")) {
      throw new HarnessError("CONFIG_INVALID", `ffmpeg not available: ${e.message}`, { mode });
    }
    throw e;
  }

  await sdk.out.dir("output/watch", { type: "watch" });
  await sdk.done();
}

/** Maps a thrown `HarnessError` (or anything else) to the sdk's `ctx.fail(kind, …)`, identical to
 * `library-stage.ts`/`publish-stage.ts`'s own `runStage`. */
async function runStage(sdk: ScriptContext, app: AppContext, mode: string): Promise<void> {
  try {
    await watchStage(app, sdk, mode);
  } catch (e) {
    if (isHarnessError(e, "CONFIG_INVALID") || isHarnessError(e, "INVALID_TRANSITION") || isHarnessError(e, "NOT_FOUND")) {
      await sdk.fail("contract", e.message, { code: e.code, ...e.details });
      return;
    }
    if (isHarnessError(e, "IO_ERROR")) {
      await sdk.fail("transient", e.message, { code: e.code, ...e.details });
      return;
    }
    await sdk.fail("transient", e instanceof Error ? e.message : String(e), {});
  }
}

export function registerMedia(program: Command): void {
  const media = program.command("media").description("built-in media watch stage (spec sub-project 4): frames + contact sheets + transcript for samples|source|episode");
  media.command("watch")
    .requiredOption("--mode <mode>", "samples|source|episode")
    .description('built-in "watch" stage: reads stage-request.json from $HARNESS_WORKSPACE, writes stage-result.json')
    .action(async (o: { mode: string }, cmd: Command) => {
      const sdk = await start({ env: process.env });
      await withContext(cmd, {}, async (app) => runStage(sdk, app, o.mode));
    });
}
