import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { start, type ScriptContext } from "@harness/script-sdk";
import {
  AnySurveyIndexSchema, CompositionSchema, EdlSchema, HarnessError, isHarnessError, libraryBriefSchema, NarrationSchema, NarrationTimingSchema, OverlaysSchema,
  ShotsIndexSchema, SUBTITLE_MODES, TimelineSchema, TranscriptSchema,
  type AnySurveyIndex, type Composition, type Edl, type LibraryBrief, type Narration, type NarrationTiming, type Overlays, type ScriptCommand, type ShotsIndex,
  type SubtitleMode, type SurveyIndexV2, type Timeline, type Transcript, type VoiceProfile, type WatchIndex,
} from "@harness/contracts";
import {
  activeTracks, buildComposition, buildTimeline, eventFor, fitEdl, indexSources, loadBrand, probeNvenc, renderComposition, requireActiveVoice,
  synthesizeNarration, transcribeSources, verifyBrandFiles, watchFromExistingFrames, watchVideos,
  type LoadedBrand, type PreExtractedVideo, type WatchDeps, type WatchVideoInput,
} from "@harness/core";
import { probeDurationSync, probeSync } from "@harness/adapter-ffprobe";
import type { AppContext } from "../composition.js";
import { resolveNvencProbe } from "../media-probe-cache.js";
import { requireLibrary } from "./library-stage.js";
import { withContext } from "./shared.js";

const MODES = ["samples", "source", "episode"] as const;
type WatchMode = (typeof MODES)[number];

/** The six `media index|transcribe|tts|fit-edl|compose|render` built-in commands, task 8's counterpart to
 * `MODES` above (`compose`/`render` joined in sub-project 5B Task 8). */
const MEDIA_STAGE_NAMES = ["index", "transcribe", "tts", "fit-edl", "compose", "render"] as const;

/**
 * The three `harness media watch --mode <m>` re-invocations (task 2's spec §7 workflows wire `watch-samples`,
 * `watch-source`, `watch-episode` as `executor: { type: script, script: "watch-<mode>" }`), plus (task 8) the
 * four `media-index|media-transcribe|media-tts|media-fit-edl` re-invocations `library-production@1.2.0` wires
 * the same way -- built in the same shape as `builtinLibraryCommands`/`builtinPublishCommands` in
 * `composition.ts`: each re-invokes this CLI against the ops project, reading `stage-request.json` from the
 * `ScriptExecutor`-provided workspace.
 */
export function builtinMediaCommands(argv: string[], projectDir: string): Record<string, ScriptCommand> {
  const commands: Record<string, ScriptCommand> = {};
  for (const mode of MODES) commands[`watch-${mode}`] = { argv: [...argv, "--project", projectDir, "media", "watch", "--mode", mode], cwd: "." };
  for (const name of MEDIA_STAGE_NAMES) {
    commands[`media-${name}`] = {
      argv: [...argv, "--project", projectDir, "media", name], cwd: ".",
      ...(name === "render" ? { timeout_seconds: MEDIA_RENDER_TIMEOUT_SECONDS } : {}),
    };
  }
  return commands;
}

/** Outer wall-clock cap on one `media-render` stage (sub-project 5B Task 8, spec §6.1's `timeout_seconds:
 * 7200`). `stageDefinitionSchema` has no timeout key, so this lives on the ScriptCommand, which is what
 * `ScriptExecutor` actually reads (it takes `min(stage deadline, command timeout)`). The render itself
 * budgets a tighter window of its own (`renderTimeoutSeconds`); this is only the net that catches an ffmpeg
 * that hung past every inner timeout. */
export const MEDIA_RENDER_TIMEOUT_SECONDS = 7200;

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
 * `--mode samples`: reads `sample_set/samples.json` and decides **per entry** (final-review finding I-3 --
 * it used to be all-or-nothing, so one clip whose path no longer resolved dropped every other sample to the
 * frames-only path, contact sheets and all). A `path` that still resolves to a file here is re-watched with
 * ffmpeg via `watchVideos`; one that does not (a local reference recorded on another machine) falls back to
 * the frames `collect-samples` already extracted. `path`/`frames` may be relative to the `sample_set`
 * directory -- which is how a downloaded clip survives the workspace being renamed into `artifacts/` -- or
 * absolute, for a local file the wrapper only referenced and never copied.
 */
async function handleSamples(app: AppContext, sdk: ScriptContext, outDir: string): Promise<WatchIndex> {
  if (!sdk.hasInput("sample_set")) throw new HarnessError("CONFIG_INVALID", 'media watch --mode samples needs a "sample_set" input', {});
  const sampleSetDir = sdk.input("sample_set");
  const samplesJsonPath = join(sampleSetDir, "samples.json");
  if (!existsSync(samplesJsonPath)) throw new HarnessError("CONFIG_INVALID", `sample_set ${sampleSetDir} has no samples.json`, { dir: sampleSetDir });
  const entries = parseSampleEntries(readJsonFile(samplesJsonPath), samplesJsonPath);

  const resolve1 = (p: string): string => (isAbsolute(p) ? p : join(sampleSetDir, p));

  const videos: WatchVideoInput[] = [];
  const preExtracted: PreExtractedVideo[] = [];
  for (const e of entries) {
    const path = resolve1(e.path);
    if (existsSync(path)) videos.push({ label: e.label, path });
    else preExtracted.push({ label: e.label, source_path: e.path, frames: (e.frames ?? []).map(resolve1) });
  }

  if (videos.length === 0) return watchFromExistingFrames({ mode: "samples", outDir }, preExtracted);
  return watchVideos(watchDepsFor(app, sdk), { mode: "samples", outDir }, videos, preExtracted);
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

/**
 * `--mode source` (multi-source, `library-production@1.2.0`, task 8): every source of this run, labeled by
 * its `shots.json` `index` (3 digits, spec §2.4), watched at its own proxy from the `proxy_set` directory
 * `media-index` produced, at scene+interval marks plus its own shot boundaries. When a `transcript` input is
 * present, every source's transcript is handed to `watchVideos` as `transcriptBySource` (keyed by
 * `source_id`) instead of letting it invoke the `scripts.yaml` `transcribe` hook per video -- spec: "không
 * gọi hook transcribe của scripts.yaml" when a real transcript already exists.
 *
 * Final-review Important 3: a source whose proxy was never encoded (`shots.json` records why, in
 * `proxy_error`) is watched at its ORIGINAL file instead, with a warning. Pointing ffmpeg at a proxy that is
 * not there extracted no frames at all for that source, so the survey agent scored footage nobody ever
 * looked at -- and `emptyWatchLabels` could not catch it, because an input ffprobe cannot read reports
 * `duration_seconds: 0`, which that check deliberately ignores.
 */
async function handleSourceMulti(app: AppContext, sdk: ScriptContext, outDir: string): Promise<WatchIndex> {
  if (!sdk.hasInput("shots")) throw new HarnessError("CONFIG_INVALID", 'media watch --mode source needs a "shots" input', {});
  const shots = parseShotsDoc(readJsonFile(sdk.input("shots")));
  const proxySetDir = sdk.input("proxy_set");
  const originalPathOf = new Map(sdk.sources.map((s) => [s.source_id, sourcePathAndName(app, s).path]));

  let transcriptBySource: Record<string, { segments: { start: number; end: number; text: string }[] }> | undefined;
  if (sdk.hasInput("transcript")) {
    const transcript = parseTranscriptDoc(readJsonFile(sdk.input("transcript")));
    transcriptBySource = {};
    for (const src of transcript.sources) {
      transcriptBySource[src.source_id] = { segments: src.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) };
    }
  }

  const videos: WatchVideoInput[] = shots.sources.map((s) => {
    const proxyPath = join(proxySetDir, `${s.source_id}.mp4`);
    let path = proxyPath;
    if (!existsSync(proxyPath)) {
      const original = originalPathOf.get(s.source_id);
      if (original && existsSync(original)) {
        sdk.log.warn("media watch --mode source: proxy missing, watching the original source file instead", { source_id: s.source_id, proxy: proxyPath, original, proxy_error: s.proxy_error ?? null });
        path = original;
      } else {
        sdk.log.warn("media watch --mode source: proxy missing and no original file to fall back on", { source_id: s.source_id, proxy: proxyPath, proxy_error: s.proxy_error ?? null });
      }
    }
    return { label: String(s.index).padStart(3, "0"), path, shot_marks: s.shots.map((sh) => sh.in), source_id: s.source_id };
  });

  return watchVideos(
    watchDepsFor(app, sdk),
    { mode: "source", outDir, max_sheets: app.mediaConfig.watch.max_sheets, ...(transcriptBySource ? { transcriptBySource } : {}) },
    videos,
  );
}

/** `--mode source`: the proxy video index-source produced, watched at scene+interval marks plus every shot
 * boundary from `shots.json` (task-3 brief: `watchVideos([{ label: "source", path: proxy, shot_marks:
 * shots[].in }])`). `library-production@1.2.0`'s `media-index` output (`proxy_set`, a directory) is a
 * different input type entirely from 1.1.0's single-file `proxy_video`, so its presence alone tells the two
 * pipelines apart -- 1.1.0 (and every SP1-4 test) is untouched below the `if`, byte-for-byte. */
async function handleSource(app: AppContext, sdk: ScriptContext, outDir: string): Promise<WatchIndex> {
  if (sdk.hasInput("proxy_set")) return handleSourceMulti(app, sdk, outDir);
  if (!sdk.hasInput("proxy_video")) throw new HarnessError("CONFIG_INVALID", 'media watch --mode source needs a "proxy_video" input', {});
  if (!sdk.hasInput("shots")) throw new HarnessError("CONFIG_INVALID", 'media watch --mode source needs a "shots" input', {});
  const proxyPath = sdk.input("proxy_video");
  const shotsPath = sdk.input("shots");
  const shot_marks = parseShotMarks(readJsonFile(shotsPath), shotsPath);
  return watchVideos(watchDepsFor(app, sdk), { mode: "source", outDir }, [{ label: "source", path: proxyPath, shot_marks }]);
}

/** `--mode episode`: the assembled episode video, watched at scene+interval marks only (no shot list). */
async function handleEpisode(app: AppContext, sdk: ScriptContext, outDir: string): Promise<WatchIndex> {
  if (!sdk.hasInput("episode_video")) throw new HarnessError("CONFIG_INVALID", 'media watch --mode episode needs an "episode_video" input', {});
  const episodePath = sdk.input("episode_video");
  return watchVideos(watchDepsFor(app, sdk), { mode: "episode", outDir }, [{ label: "episode", path: episodePath }]);
}

const HANDLERS: Record<WatchMode, (app: AppContext, sdk: ScriptContext, outDir: string) => Promise<WatchIndex>> = {
  samples: handleSamples, source: handleSource, episode: handleEpisode,
};

/**
 * A video the prober gave a real duration for but that produced no frame at all means the frame extraction
 * never worked (ffmpeg missing or refusing this file), and shipping that as a SUCCEEDED but empty `watch/`
 * hands the agent stages downstream nothing to look at while everything reports green (final-review finding
 * I-2). `duration_seconds === 0` is left alone on purpose: that is the `watchFromExistingFrames` fallback
 * shape and an unprobeable input, neither of which this check can say anything useful about.
 */
export function emptyWatchLabels(index: WatchIndex): string[] {
  return index.videos.filter((v) => v.duration_seconds > 0 && v.frames.length === 0).map((v) => v.label);
}

/**
 * `harness media watch --mode <samples|source|episode>`: extracts frames (scene changes + interval, plus
 * shot marks for `source`) and contact sheets via ffmpeg, optionally runs the `transcribe` hook, and writes
 * `output/watch/watch.json` (task 2's `watchVideos`/`watchFromExistingFrames`). Every mode needs ffmpeg on
 * PATH; `app.proberAvailable` (ffprobe -- installed alongside ffmpeg in every supported setup, and already
 * the signal `harness doctor` reports) is the cheap pre-check, but it is ffprobe, not ffmpeg: a machine with
 * only one of the two is caught by `watch.ts`'s own spawn check and, as a last net, by the zero-frame check
 * below (`emptyWatchLabels`) -- both `contract`, never a green empty `watch/` (final-review finding I-2).
 */
async function watchStage(app: AppContext, sdk: ScriptContext, mode: string): Promise<void> {
  if (!MODES.includes(mode as WatchMode)) throw new HarnessError("CONFIG_INVALID", `unknown --mode "${mode}"; expected one of ${MODES.join("|")}`, { mode });
  if (!app.proberAvailable) throw new HarnessError("CONFIG_INVALID", "ffmpeg/ffprobe not found on PATH; media watch needs them (see `harness doctor`)", { mode });

  const outDir = join(sdk.workspace, "output", "watch");
  let index: WatchIndex;
  try {
    index = await HANDLERS[mode as WatchMode](app, sdk, outDir);
  } catch (e) {
    // `watch.ts` raises a missing/unstartable ffmpeg as `CONFIG_INVALID` itself (`assertFfmpegSpawned`), which
    // falls through untouched; this branch stays as a backstop for any other ENOENT that escapes a handler.
    if (e instanceof Error && !isHarnessError(e) && e.message.includes("ENOENT")) {
      throw new HarnessError("CONFIG_INVALID", `ffmpeg not available: ${e.message}`, { mode });
    }
    throw e;
  }

  const empty = emptyWatchLabels(index);
  if (empty.length > 0) {
    throw new HarnessError("CONFIG_INVALID", `media watch --mode ${mode}: no frames extracted for ${empty.join(", ")} (is ffmpeg on PATH?)`, { mode, labels: empty });
  }

  await sdk.out.dir("output/watch", { type: "watch" });
  await sdk.done();
}

/** Maps a thrown `HarnessError` (or anything else) to the sdk's `ctx.fail(kind, …)`, identical to
 * `library-stage.ts`/`publish-stage.ts`'s own `runStage`; shared by `runStage` (watch) and `runMediaStage`
 * (task 8's index/transcribe/tts/fit-edl) below so the mapping lives in exactly one place. */
async function reportFailure(sdk: ScriptContext, e: unknown): Promise<void> {
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

async function runStage(sdk: ScriptContext, app: AppContext, mode: string): Promise<void> {
  try {
    await watchStage(app, sdk, mode);
  } catch (e) {
    await reportFailure(sdk, e);
  }
}

// ---- Task 8: media index|transcribe|tts|fit-edl (spec §2.2-§2.3, §3.4, §4.1) ----

function parseShotsDoc(raw: unknown): ShotsIndex {
  const parsed = ShotsIndexSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "shots.json failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}
function parseTranscriptDoc(raw: unknown): Transcript {
  const parsed = TranscriptSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "transcript.json failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}
function parseEdlDoc(raw: unknown): Edl {
  const parsed = EdlSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "edl.json failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}
function parseNarrationDoc(raw: unknown): Narration {
  const parsed = NarrationSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "narration.json failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}
function parseNarrationTimingDoc(raw: unknown): NarrationTiming {
  const parsed = NarrationTimingSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "narration-timing.json failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}
function parseSurveyDoc(raw: unknown): AnySurveyIndex {
  const parsed = AnySurveyIndexSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "survey.json failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}
// `brief.json` may carry extra fields (`intake` also writes `style_snapshot`, `request_notes`); passthrough
// mirrors `library-checkers.ts`'s own `briefWithExtrasSchema`.
const briefWithExtrasSchema = libraryBriefSchema.passthrough();
function parseBriefDoc(raw: unknown): LibraryBrief {
  const parsed = briefWithExtrasSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "brief.json failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}

function writeJsonOutputFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** `basename(original_uri)`, decoded first when it is a `file:` URL -- same normalization
 * `auto-accept.ts`'s `decodedBasename` uses, kept local here since that one is not exported. */
function decodedBasename(uri: string): string {
  if (uri.startsWith("file:")) {
    try { return basename(fileURLToPath(uri)); } catch { /* fall through to the raw string below */ }
  }
  return basename(uri);
}

/** A `media-index`/`media-transcribe` source's filesystem path (from `sdk.sources[].uri`, a `file:` URL) and
 * display `file_name` (`basename` of the kho's own `original_uri`, read through `app.store.getSourceItem` --
 * task-8 brief: "file_name = basename của original_uri lấy qua app.store.getSourceItem"). A source id the
 * store mirror has never seen (should not happen in practice) falls back to the workspace-local uri's own
 * basename rather than throwing -- indexing is still possible from the materialized file alone. */
function sourcePathAndName(app: AppContext, s: { source_id: string; uri: string }): { path: string; file_name: string } {
  const path = s.uri.startsWith("file:") ? fileURLToPath(s.uri) : s.uri;
  const item = app.store.getSourceItem(s.source_id);
  const file_name = item ? decodedBasename(item.original_uri) : decodedBasename(s.uri);
  return { path, file_name };
}

/** `deadlineSeconds` every media engine call (`transcribe`/`tts`) is given: seconds remaining until
 * `request.limits.deadline_at`, minus a 30s margin so core's own timeout math never rounds up past the
 * stage's real deadline (task-8 brief §D). `transcribeSources`/`synthesizeNarration` already refuse a
 * non-positive deadline themselves, but only after doing real work first (extracting audio, reading the tts
 * cache); called at the top of each stage function, before any of that, so a stage with no time left fails
 * fast instead of doing wasted I/O first (fix round, task 8 review, adjacent item). */
function deadlineSecondsFor(sdk: ScriptContext): number {
  const seconds = Math.floor((Date.parse(sdk.request.limits.deadline_at) - Date.now()) / 1000) - 30;
  if (seconds <= 0) throw new HarnessError("IO_ERROR", "no time left before the stage deadline", { deadline_at: sdk.request.limits.deadline_at });
  return seconds;
}

/** Appends a `media.*` event through the same `store.appendEvent(eventFor(...))` shape every other built-in
 * stage uses (e.g. `publish-stage.ts`'s `channel.requests_created`); a no-op when the run row cannot be found
 * (should not happen for a real claimed stage, but this must never be the reason a stage fails). */
function appendMediaEvent(app: AppContext, sdk: ScriptContext, event_type: string, payload: Record<string, unknown>): void {
  const run = app.store.getRun(sdk.request.run_id);
  if (!run) return;
  const stageRun = app.store.getStageRun(sdk.request.stage_run_id) ?? null;
  const attempt = app.store.getAttempt(sdk.request.attempt_id) ?? null;
  app.store.appendEvent(eventFor(run, stageRun, attempt, event_type, "info", payload));
}

const ffmpegBin = (): string => process.env.FFMPEG_PATH ?? "ffmpeg";

/**
 * `media index` (spec §2.2): probes + scene-detects + proxies every one of this run's sources (`sdk.sources`),
 * writing `output/shots.json` (type `shots`, `harness.shots/v2`) and `output/proxy/` (type `proxy_set`). ffmpeg
 * missing is `contract`, exactly like `media watch`.
 */
async function mediaIndexStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  if (!app.proberAvailable) {
    throw new HarnessError("CONFIG_INVALID", "ffmpeg/ffprobe not found on PATH; media index needs them (see `harness doctor`)", {});
  }
  const sources = sdk.sources.map((s) => {
    const { path, file_name } = sourcePathAndName(app, s);
    return { source_id: s.source_id, path, file_name };
  });
  const shots = indexSources(
    { ffmpeg: ffmpegBin(), probe: (p) => probeSync(p), log: (level, msg, data) => sdk.log[level](msg, data) },
    { sources, scene: app.mediaConfig.scene, proxyDir: join(sdk.workspace, "output", "proxy") },
  );
  writeJsonOutputFile(join(sdk.workspace, "output", "shots.json"), shots);
  await sdk.out.file("output/shots.json", { type: "shots" });
  await sdk.out.dir("output/proxy", { type: "proxy_set" });
  await sdk.done();
}

/**
 * `media transcribe` (spec §2.3): transcribes every source's audio via `app.media` (the composition root's
 * `PythonMediaEngine`/`FakeMediaEngine`), writing `output/transcript.json` (type `transcript`) and an event
 * `media.transcribed`.
 */
async function mediaTranscribeStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const deadlineSeconds = deadlineSecondsFor(sdk); // checked first: no time left must not spend I/O first
  const shots = parseShotsDoc(readJsonFile(sdk.input("shots")));
  const sources = sdk.sources.map((s) => {
    const { path } = sourcePathAndName(app, s);
    const item = app.store.getSourceItem(s.source_id);
    return { source_id: s.source_id, path, language: item?.language ?? null };
  });
  const transcript = await transcribeSources(
    { engine: app.media, ffmpeg: ffmpegBin(), log: (level, msg, data) => sdk.log[level](msg, data) },
    { shots, sources, workDir: join(sdk.workspace, "work"), deadlineSeconds },
  );
  writeJsonOutputFile(join(sdk.workspace, "output", "transcript.json"), transcript);
  await sdk.out.file("output/transcript.json", { type: "transcript" });
  const seconds = shots.sources.reduce((a, s) => a + (s.has_audio && s.error === undefined ? s.duration_seconds : 0), 0);
  appendMediaEvent(app, sdk, "media.transcribed", { run_id: sdk.request.run_id, sources: transcript.sources.length, seconds });
  await sdk.done();
}

/**
 * `media tts` (spec §3.4): synthesizes every `narration.json` line via `app.media`, writing `output/voice/`
 * (type `voice_set`) and `output/narration-timing.json` (type `narration_timing`) plus a `media.tts_done`
 * event. `voice` other than `tts` (or an empty script) never touches the engine or the voice kho --
 * `synthesizeNarration` itself writes the empty timing and creates `output/voice/` (possibly empty).
 */
async function mediaTtsStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const deadlineSeconds = deadlineSecondsFor(sdk); // checked first: no time left must not spend I/O first
  const library = requireLibrary(app);
  const brief = parseBriefDoc(readJsonFile(sdk.input("brief")));
  const narration = parseNarrationDoc(readJsonFile(sdk.input("narration")));

  let voice: { profile: VoiceProfile; ref_audio_path: string } | undefined;
  if (brief.voice === "tts" && narration.lines.length > 0) {
    const profile = requireActiveVoice(app.store, brief.voice_id);
    if (brief.voice_checksum && profile.ref_audio.checksum !== brief.voice_checksum) {
      throw new HarnessError(
        "CONFIG_INVALID",
        `voice ${profile.voice_id}'s ref.wav checksum has changed since intake (brief: ${brief.voice_checksum}, current: ${profile.ref_audio.checksum})`,
        { voice_id: profile.voice_id, expected: brief.voice_checksum, actual: profile.ref_audio.checksum },
      );
    }
    // Final-review Important 1: `intake` snapshots `voice_revision` onto the brief precisely so this run is
    // pinned to one reading of the voice; a `--ref-text`-only re-add bumps the revision while leaving
    // `ref.wav` byte-identical, which the checksum guard above cannot see. `ttsCacheKey` now includes the
    // revision, so the cache is right either way -- this refuses the run instead of quietly reading the
    // script with a voice profile the editor never approved.
    if (brief.voice_revision !== undefined && profile.revision !== brief.voice_revision) {
      throw new HarnessError(
        "CONFIG_INVALID",
        `voice ${profile.voice_id} has changed since intake: brief pins revision ${brief.voice_revision}, the kho is at ${profile.revision}`,
        { voice_id: profile.voice_id, expected: brief.voice_revision, actual: profile.revision },
      );
    }
    voice = { profile, ref_audio_path: library.fs.paths.voiceRef(profile.voice_id) };
  }

  const timing = await synthesizeNarration(
    { engine: app.media, ffmpeg: ffmpegBin(), probeDuration: (p) => probeDurationSync(p), cacheDir: join(app.dataRoot, "cache", "tts"), log: (level, msg, data) => sdk.log[level](msg, data) },
    { narration, voiceMode: brief.voice, ...(voice ? { voice } : {}), cfg: app.mediaConfig.tts, outDir: join(sdk.workspace, "output", "voice"), deadlineSeconds },
  );
  writeJsonOutputFile(join(sdk.workspace, "output", "narration-timing.json"), timing);
  await sdk.out.file("output/narration-timing.json", { type: "narration_timing" });
  await sdk.out.dir("output/voice", { type: "voice_set" });
  const cached = timing.lines.filter((l) => l.cached).length;
  appendMediaEvent(app, sdk, "media.tts_done", { run_id: sdk.request.run_id, lines: timing.lines.length, cached, seconds: timing.total_seconds });
  await sdk.done();
}

/**
 * `media fit-edl` (spec §4.1): reshapes the agent's EDL to match the narration timing (or, for `voice:
 * original`, snaps cuts to word boundaries), writing `output/edl.json`, `output/fit-report.json` and
 * `output/timeline.json`. Every input is schema-validated up front (a parse failure is `contract`); the stage
 * itself never fails for a footage shortfall -- `fitEdl` is pure and always returns a result, and a non-empty
 * `report.shortfalls` only ever produces the `media.fit_shortfall` event, for `library-review` to act on.
 */
async function mediaFitEdlStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const brief = parseBriefDoc(readJsonFile(sdk.input("brief")));
  const edl = parseEdlDoc(readJsonFile(sdk.input("edl")));
  const timing = parseNarrationTimingDoc(readJsonFile(sdk.input("narration_timing")));
  const shots = parseShotsDoc(readJsonFile(sdk.input("shots")));

  // Fix round (task 8 review, Critical 1): `survey-source` declares TWO outputs -- `{ type: survey,
  // survey.md }` (markdown) and `{ type: survey_index, survey.json }` (the JSON this stage needs). Reading
  // by type "survey" resolved to the markdown file and `readJsonFile`/`parseSurveyDoc` threw `CONFIG_INVALID`
  // on every real run.
  let survey: SurveyIndexV2 | null = null;
  if (sdk.hasInput("survey_index")) {
    const parsed = parseSurveyDoc(readJsonFile(sdk.input("survey_index")));
    if (parsed.schema_version === "harness.survey-index/v2") survey = parsed;
  }
  let transcript: Transcript | null = null;
  if (sdk.hasInput("transcript")) transcript = parseTranscriptDoc(readJsonFile(sdk.input("transcript")));

  const fitted = fitEdl({
    edl, timing, shots, survey, transcript, voice: brief.voice,
    ...(brief.target_duration_seconds ? { target_duration_seconds: brief.target_duration_seconds } : {}),
  });
  const timeline = buildTimeline({ edl: fitted.edl, timing, transcript, voice: brief.voice, language: brief.language, orderMap: fitted.orderMap });

  writeJsonOutputFile(join(sdk.workspace, "output", "edl.json"), fitted.edl);
  await sdk.out.file("output/edl.json", { type: "edl" });
  writeJsonOutputFile(join(sdk.workspace, "output", "fit-report.json"), fitted.report);
  await sdk.out.file("output/fit-report.json", { type: "fit_report" });
  writeJsonOutputFile(join(sdk.workspace, "output", "timeline.json"), timeline);
  await sdk.out.file("output/timeline.json", { type: "timeline" });

  if (fitted.report.shortfalls.length > 0) {
    const missing_seconds = Math.round(fitted.report.shortfalls.reduce((a, s) => a + s.missing_seconds, 0) * 1000) / 1000;
    appendMediaEvent(app, sdk, "media.fit_shortfall", { run_id: sdk.request.run_id, missing_seconds });
  }
  await sdk.done();
}

// ---- Sub-project 5B Task 8: media compose|render (spec §4, §5, §6.1) ----

function parseTimelineDoc(raw: unknown): Timeline {
  const parsed = TimelineSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "timeline.json failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}
function parseOverlaysDoc(raw: unknown): Overlays {
  const parsed = OverlaysSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "overlays.json failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}
function parseCompositionDoc(raw: unknown): Composition {
  const parsed = CompositionSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "composition.json failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}

/**
 * The channel whose brand this episode is rendered with. `libraryBriefSchema` carries no `channel_id` of its
 * own (checked -- it has `request_id`, `style_id`, `voice*` and nothing about the requester), so it is read
 * off the originating request's `requested_by.channel_id` through the studio's own DB mirror. `null` means
 * "no channel to look a brand up for" (a hand-planned run with no request, or a request created without a
 * channel), which is the same outcome as "this channel has no brand yet": build the episode plain (spec
 * §2.1, "Không có brand -> tập vẫn dựng").
 */
function brandChannelIdFor(app: AppContext, brief: LibraryBrief): string | null {
  if (!brief.request_id) return null;
  return app.store.getContentRequest(brief.request_id)?.requested_by.channel_id ?? null;
}

/**
 * `subtitlesOverride` for this run, from the `subtitles` run option the `studio` profile's `options_schema`
 * declares (`burn-in | karaoke | none | true | false`, revision 4). `"false"` -- the historical value, which
 * meant nothing at all before 5B -- maps to `"none"`; `"true"` and an absent option map to `undefined`, i.e.
 * "the brand decides" (`brand.subtitles.mode`). Anything else is one of the three real modes.
 *
 * Deviation from the task brief, recorded in the task-8 report: the brief says `brief.options.subtitles`, but
 * a `library_brief` has no `options` field anywhere in `libraryBriefSchema` (nor does `ContentRequest`) --
 * per-run options live on `run.options`, which the stage request hands over as `sdk.options`, and that is the
 * value the profile's `options_schema` actually validates.
 */
function subtitlesOverrideFor(sdk: ScriptContext): SubtitleMode | undefined {
  const raw = sdk.options.subtitles;
  if (raw === undefined || raw === null || raw === "true") return undefined;
  const value = String(raw);
  if (value === "false") return "none";
  if ((SUBTITLE_MODES as readonly string[]).includes(value)) return value as SubtitleMode;
  throw new HarnessError("CONFIG_INVALID", `option "subtitles" must be one of ${SUBTITLE_MODES.join("|")}|true|false, got "${value}"`, { subtitles: value });
}

/**
 * The loaded brand for this run, with every file it references re-verified against `brand.json`'s checksums.
 * `intake` already did exactly this before claiming the request (spec §7), so a failure here means the kho
 * drifted mid-run -- cheap to re-check, and far better caught before a two-hour render than after it.
 */
async function loadVerifiedBrand(app: AppContext, lib: NonNullable<AppContext["library"]>, brief: LibraryBrief): Promise<LoadedBrand | null> {
  const channelId = brandChannelIdFor(app, brief);
  if (channelId === null) return null;
  const brand = loadBrand(lib.fs, channelId);
  if (brand === null) return null;
  const verified = await verifyBrandFiles(lib.fs, brand);
  if (!verified.ok) {
    throw new HarnessError("CONFIG_INVALID", `brand for channel ${channelId} is broken: ${verified.reason}`, { channel_id: channelId, reason: verified.reason });
  }
  return brand;
}

/**
 * `media compose` (spec §4): turns `timeline.json` + the agent's `overlays.json` + the channel's brand and
 * music into one `composition.json` plus the `captions/` and `overlay.ass` text it implies. Pure below this
 * function -- `buildComposition` never touches the filesystem, so everything it needs (source paths,
 * durations, fps, the brand directory, track paths) is resolved here and handed in.
 *
 * Fails only for machine reasons: a broken brand, a missing source, a `voice: tts` run with no `voice_set`.
 * Editorial problems (overlays too dense, an anchor that does not exist) already failed at `plan-edit`'s
 * `overlays-valid` and went round the SP4 replan loop -- they never reach this stage.
 */
async function mediaComposeStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const library = requireLibrary(app);
  const brief = parseBriefDoc(readJsonFile(sdk.input("brief")));
  if (!brief.request_id) {
    throw new HarnessError("CONFIG_INVALID", "media compose needs a brief with a request_id (composition.json is keyed by it)", {});
  }
  const timeline = parseTimelineDoc(readJsonFile(sdk.input("timeline")));
  // `media-compose` depends on BOTH `plan-edit` (for `overlays`/`narration`) and `media-fit-edl`, and both
  // emit an `edl` artifact -- `sdk.input("edl")` would hand back `plan-edit`'s PRE-FIT plan. Inputs arrive
  // in upstream-stage order, so the last `edl` is `media-fit-edl`'s fitted one, the only one that matches
  // `timeline.json`. (Same two-edl situation the `library-review` skill documents for its own stage.)
  const edlPaths = sdk.inputs("edl");
  const fittedEdlPath = edlPaths.at(-1);
  if (fittedEdlPath === undefined) throw new HarnessError("CONFIG_INVALID", "media compose needs an \"edl\" input", {});
  const edl = parseEdlDoc(readJsonFile(fittedEdlPath));
  const shots = parseShotsDoc(readJsonFile(sdk.input("shots")));
  const overlays = sdk.hasInput("overlays") ? parseOverlaysDoc(readJsonFile(sdk.input("overlays"))) : null;
  const narration = sdk.hasInput("narration") ? parseNarrationDoc(readJsonFile(sdk.input("narration"))) : null;
  const voiceSetDir = sdk.hasInput("voice_set") ? sdk.input("voice_set") : null;

  const brand = await loadVerifiedBrand(app, library, brief);
  const tracks = brand ? activeTracks(app.store, brand.brand.music.tracks) : [];

  // `duration_seconds`/`has_audio` come from `shots.json` (the one stage that already probed every source);
  // `fps` needs its own probe, since `shots.json` does not record it. A source ffprobe cannot read at all
  // contributes `fps: null`, which simply never votes in `buildComposition`'s fps election.
  const shotsBySource = new Map(shots.sources.map((s) => [s.source_id, s]));
  const sources = new Map<string, { path: string; duration_seconds: number; has_audio: boolean; fps: number | null }>();
  for (const s of sdk.sources) {
    const { path } = sourcePathAndName(app, s);
    const indexed = shotsBySource.get(s.source_id);
    const probed = await app.prober.probe(path);
    sources.set(s.source_id, {
      path,
      duration_seconds: indexed?.duration_seconds ?? probed?.duration_seconds ?? 0,
      has_audio: indexed?.has_audio ?? (probed?.audio != null),
      fps: probed?.video?.fps ?? null,
    });
  }

  const subtitlesOverride = subtitlesOverrideFor(sdk);
  const { composition, srt, vtt, ass } = buildComposition({
    timeline, overlays, narration, edl, brand, tracks,
    trackPath: (t) => join(library.fs.paths.trackDir(t.track_id), t.file),
    sources, voiceSetDir, request_id: brief.request_id,
    ...(subtitlesOverride !== undefined ? { subtitlesOverride } : {}),
    render: app.mediaConfig.render,
  });

  writeJsonOutputFile(join(sdk.workspace, "output", "composition.json"), composition);
  const captionsDir = join(sdk.workspace, "output", "captions");
  mkdirSync(captionsDir, { recursive: true });
  writeFileSync(join(captionsDir, "captions.srt"), srt);
  writeFileSync(join(captionsDir, "captions.vtt"), vtt);
  writeFileSync(join(sdk.workspace, "output", "overlay.ass"), ass);

  await sdk.out.file("output/composition.json", { type: "composition" });
  await sdk.out.dir("output/captions", { type: "captions" });
  await sdk.out.file("output/overlay.ass", { type: "overlay_ass" });

  for (const warning of composition.warnings) sdk.log.warn(`media compose: ${warning}`, { run_id: sdk.request.run_id });
  appendMediaEvent(app, sdk, "media.composed", {
    run_id: sdk.request.run_id,
    cues: composition.captions.cues.length,
    text_events: composition.text_events.length,
    music_track: composition.music?.track_id ?? null,
  });
  await sdk.done();
}

/** Whole-render wall-clock budget (task-8 brief): at least 20 minutes, otherwise 3x the programme length
 * plus 5 minutes of fixed overhead (probes, loudnorm pass, cache sweep) -- then clamped to whatever is left
 * before the stage's own deadline, minus a 30 s margin so ffmpeg is killed by us with a readable error
 * rather than by the lease expiring underneath it. */
export function renderTimeoutSeconds(totalSeconds: number, deadlineAt: string, nowMs: number): number {
  const budget = Math.max(1200, totalSeconds * 3 + 300);
  const untilDeadline = Math.floor((Date.parse(deadlineAt) - nowMs) / 1000) - 30;
  if (untilDeadline <= 0) throw new HarnessError("IO_ERROR", "no time left before the stage deadline", { deadline_at: deadlineAt });
  return Math.min(budget, untilDeadline);
}

/**
 * `media render` (spec §5): the two-tier ffmpeg render of one `composition.json` -- a cached mezzanine per
 * segment, then one 4K final encode with the ASS overlay burned in and music ducked under the voice. Writes
 * `full-episode.mp4`, `cuts/` (the `clip_set` `thumbnail-candidates` still consumes) and
 * `render-report.json`, all three straight into `output/` where `renderComposition` puts them.
 */
async function mediaRenderStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const library = requireLibrary(app);
  const composition = parseCompositionDoc(readJsonFile(sdk.input("composition")));
  const assPath = sdk.hasInput("overlay_ass") ? sdk.input("overlay_ass") : null;

  // Every segment's source checksum, folded into that segment's mezzanine cache key: re-ingesting a source
  // under the same id with different bytes must not serve the previous bytes' mezzanine (spec §5.1).
  const sourceChecksums = new Map<string, string>();
  for (const seg of composition.segments) {
    if (sourceChecksums.has(seg.source_id)) continue;
    const item = app.store.getSourceItem(seg.source_id);
    if (!item) throw new HarnessError("CONFIG_INVALID", `source item not found in the catalog: ${seg.source_id}`, { source_id: seg.source_id });
    sourceChecksums.set(seg.source_id, item.checksum);
  }

  // `safe_margin_px` places the logo overlay and is NOT carried in `composition.json` (only `brand.dir` is),
  // so the brand is re-loaded here by the channel the composition names.
  let safeMarginPx: number | undefined;
  if (composition.brand !== null) {
    const loaded = loadBrand(library.fs, composition.brand.channel_id);
    if (loaded) safeMarginPx = loaded.brand.safe_margin_px;
  }

  const cfg = app.mediaConfig.render;
  const ffmpeg = ffmpegBin();
  const outDir = join(sdk.workspace, "output");
  mkdirSync(outDir, { recursive: true });

  const { report } = await renderComposition(
    {
      ffmpeg,
      prober: app.prober,
      cache: { dir: join(app.dataRoot, "cache", "mezz"), maxBytes: cfg.cache_max_gb * 1024 ** 3 },
      nvencAvailable: () => resolveNvencProbe({ ffmpeg, probe: probeNvenc, nowMs: () => Date.now() }),
      clock: app.clock,
      log: (line) => sdk.log.info(line, { run_id: sdk.request.run_id }),
    },
    {
      composition, assPath, outDir,
      encoderCfg: cfg.encoder,
      timeoutSeconds: renderTimeoutSeconds(composition.total_seconds, sdk.request.limits.deadline_at, Date.now()),
      sourceChecksums,
      ...(safeMarginPx !== undefined ? { safe_margin_px: safeMarginPx } : {}),
    },
  );

  // `encoder: auto` that resolved to `cpu` is not an error, but it is the thing an operator wants to see on
  // the dashboard (spec §6.4's `render_cpu_fallback` alert reads this warning) -- appended after the fact,
  // since `renderComposition` knows nothing about the configured preference. Rewritten BEFORE `out.file`
  // hashes it.
  if (cfg.encoder === "auto" && report.encoder === "cpu" && !report.warnings.includes("encoder_cpu")) {
    report.warnings.push("encoder_cpu");
    writeJsonOutputFile(join(outDir, "render-report.json"), report);
  }

  await sdk.out.file("output/full-episode.mp4", { type: "episode_video" });
  await sdk.out.dir("output/cuts", { type: "clip_set" });
  await sdk.out.file("output/render-report.json", { type: "render_report" });

  appendMediaEvent(app, sdk, "media.rendered", {
    run_id: sdk.request.run_id,
    seconds: report.output.seconds,
    encoder: report.encoder,
    cached_segments: report.segments.cached,
    rendered_segments: report.segments.rendered,
    render_seconds: report.render_seconds,
  });
  await sdk.done();
}

const MEDIA_STAGES: Record<(typeof MEDIA_STAGE_NAMES)[number], (app: AppContext, sdk: ScriptContext) => Promise<void>> = {
  index: mediaIndexStage, transcribe: mediaTranscribeStage, tts: mediaTtsStage, "fit-edl": mediaFitEdlStage,
  compose: mediaComposeStage, render: mediaRenderStage,
};

async function runMediaStage(sdk: ScriptContext, app: AppContext, name: (typeof MEDIA_STAGE_NAMES)[number]): Promise<void> {
  try {
    await MEDIA_STAGES[name](app, sdk);
  } catch (e) {
    await reportFailure(sdk, e);
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
  for (const name of MEDIA_STAGE_NAMES) {
    media.command(name)
      .description(`built-in "media ${name}" stage (sub-projects 5A/5B): reads stage-request.json from $HARNESS_WORKSPACE, writes stage-result.json`)
      .action(async (_o: unknown, cmd: Command) => {
        const sdk = await start({ env: process.env });
        await withContext(cmd, {}, async (app) => runMediaStage(sdk, app, name));
      });
  }
}
