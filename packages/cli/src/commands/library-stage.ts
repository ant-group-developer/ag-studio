import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { start, type ScriptContext } from "@harness/script-sdk";
import { EditStyleSchema, HarnessError, isHarnessError, libraryBriefSchema, reviewSchema, type EditStyle, type LibraryBrief } from "@harness/contracts";
import { applyReview, claimRequest, exportItem, exportStyle, readRequest, requireActiveVoice, sha256File } from "@harness/core";
import type { AppContext } from "../composition.js";
import { withContext } from "./shared.js";

/** Every stage below needs `app.library`; a project.yaml without it is a contract problem for the run, not a
 * crash -- the stage fails cleanly through `ctx.fail("contract", …)` like a missing brief or request would. */
export function requireLibrary(app: AppContext): NonNullable<AppContext["library"]> {
  if (!app.library) throw new HarnessError("CONFIG_INVALID", `project.yaml in ${app.projectDir} has no library configured`, { projectDir: app.projectDir });
  return app.library;
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
    throw new HarnessError("IO_ERROR", `invalid JSON in ${path}: ${(e as Error).message}`, { path });
  }
}

/** Writes `value` as the named output under the workspace and registers it with the sdk (which hashes the
 * file it just found on disk), mirroring the `ctx.out.file` contract every other script stage uses. */
async function writeOutput(sdk: ScriptContext, relPath: string, value: unknown, type: string): Promise<void> {
  const abs = join(sdk.workspace, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(value, null, 2) + "\n");
  await sdk.out.file(relPath, { type });
}

/** `review.json` is validated against `reviewSchema`, which keeps parsing the pre-Task-4 shape (just
 * `{ decision, note }`, no `schema_version`/`checks`) unchanged since both are optional/defaulted there. */
function parseReview(raw: unknown) {
  const parsed = reviewSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "review.json failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}

function parseExportReceiptItemId(raw: unknown): string {
  const itemId = raw && typeof raw === "object" ? (raw as Record<string, unknown>).item_id : undefined;
  if (typeof itemId !== "string" || !itemId) throw new HarnessError("CONFIG_INVALID", "export-receipt.json must have a string item_id", { raw });
  return itemId;
}

/** stage 1 of `library-production`/`style-study`: normalizes the request into `brief.json` (spec §3.2 #1). */
async function intake(app: AppContext, sdk: ScriptContext): Promise<void> {
  const library = requireLibrary(app);
  const run = app.store.getRun(sdk.request.run_id);
  if (!run) throw new HarnessError("NOT_FOUND", `run not found: ${sdk.request.run_id}`, { run_id: sdk.request.run_id });
  if (!run.content_id) throw new HarnessError("CONFIG_INVALID", `run ${run.run_id} has no content_id`, { run_id: run.run_id });
  const content = app.store.getContentItem(run.content_id);
  if (!content) throw new HarnessError("NOT_FOUND", `content item not found: ${run.content_id}`, { content_id: run.content_id });
  const brief = content.library_brief;
  if (!brief) throw new HarnessError("CONFIG_INVALID", `content ${content.content_id} has no library_brief`, { content_id: content.content_id });

  const style = library.fs.readJson(library.fs.paths.styleFile(brief.style_id), EditStyleSchema);
  if (style.status !== "active") throw new HarnessError("CONFIG_INVALID", `edit style ${brief.style_id} is ${style.status}, not active`, { style_id: brief.style_id, status: style.status });
  if (style.revision !== brief.style_revision) throw new HarnessError("CONFIG_INVALID", `edit style ${brief.style_id} is at revision ${style.revision}, brief expects ${brief.style_revision}`, { style_id: brief.style_id, revision: style.revision, expected_revision: brief.style_revision });

  let request_notes = "";
  let requestVoiceId: string | undefined;
  if (brief.request_id) {
    claimRequest({ store: app.store, fs: library.fs, clock: app.clock }, { request_id: brief.request_id, run: { project_id: run.project_id, run_id: run.run_id } });
    // NOT_FOUND here (a brief pointing at a request the kho no longer has) is a contract problem with this
    // run, not something to retry -- `runStage` maps it to kind "contract" the same as any other NOT_FOUND.
    const request = readRequest({ store: app.store, fs: library.fs, clock: app.clock }, brief.request_id);
    request_notes = request.notes;
    requestVoiceId = request.voice_id;
  }

  // Sub-project 5A: a "tts" brief must snapshot the exact voice revision this run commits to at intake time --
  // downstream stages (Task 8's media-tts) read voice_id/voice_revision/voice_checksum off the brief, never
  // back off the (possibly-changed-since) request. `requireActiveVoice` reads the studio's own store mirror
  // (kept current by `syncLibrary`, since a channel process is the only one ever allowed to write voices/**);
  // the checksum re-check below then catches the one thing the mirror alone cannot: the kho's `ref.wav` bytes
  // having drifted from what `voice.json` claims (a bad sync, a half-written file, tampering).
  let voiceFields: { voice_id: string; voice_revision: number; voice_checksum: string } | undefined;
  if (brief.voice === "tts") {
    const profile = requireActiveVoice(app.store, requestVoiceId);
    const refPath = library.fs.paths.voiceRef(profile.voice_id);
    if (!existsSync(refPath)) {
      throw new HarnessError("CONFIG_INVALID", `voice profile ${profile.voice_id} has no ref.wav in the kho: ${refPath}`, { voice_id: profile.voice_id, path: refPath });
    }
    const { checksum } = await sha256File(refPath);
    if (checksum !== profile.ref_audio.checksum) {
      throw new HarnessError("CONFIG_INVALID", `voice profile ${profile.voice_id}'s ref.wav checksum does not match voice.json (kho drift or tampering)`, { voice_id: profile.voice_id, path: refPath, expected: profile.ref_audio.checksum, actual: checksum });
    }
    voiceFields = { voice_id: profile.voice_id, voice_revision: profile.revision, voice_checksum: profile.ref_audio.checksum };
  }

  await writeOutput(sdk, "output/brief.json", { ...brief, request_notes, style_snapshot: style, ...(voiceFields ?? {}) }, "brief");
  await sdk.done();
}

/**
 * `style-export` depends on both `style-review` and `analyze-style`, and *both* stages output a `style`
 * artifact, so the workspace carries two `style` inputs -- in stage order, which means `sdk.input("style")`
 * hands back `analyze-style`'s **draft**. Read every one of them and take the reviewed (`active`) style
 * instead; approving the style is the whole point of the `style-review` gate. The last active one wins, so
 * a workflow that ever chains more than one reviewing gate exports the final word.
 */
function reviewedStyle(sdk: ScriptContext): EditStyle {
  const paths = sdk.inputs("style");
  if (paths.length === 0) throw new HarnessError("CONFIG_INVALID", "style-export has no style input", {});
  const styles: EditStyle[] = [];
  for (const path of paths) {
    const parsed = EditStyleSchema.safeParse(readJsonFile(path));
    if (!parsed.success) throw new HarnessError("CONFIG_INVALID", `style.json failed schema validation: ${path}`, { path, issues: parsed.error.issues });
    styles.push(parsed.data);
  }
  const active = styles.filter((s) => s.status === "active").at(-1);
  if (!active) {
    const statuses = styles.map((s) => `${s.style_id}=${s.status}`);
    throw new HarnessError("CONFIG_INVALID", `no style input is active (${statuses.join(", ")}); submit style-review with status: active`, { statuses });
  }
  return active;
}

/** stage 4 of `style-study`: publishes an approved style (plus optional evidence) into the kho (spec §3.1). */
async function styleExport(app: AppContext, sdk: ScriptContext): Promise<void> {
  const library = requireLibrary(app);
  const style_ = reviewedStyle(sdk);
  const evidenceDir = sdk.hasInput("style_evidence") ? sdk.input("style_evidence") : undefined;

  const { style, dir } = await exportStyle({ store: app.store, fs: library.fs, clock: app.clock }, { style: style_, ...(evidenceDir !== undefined ? { evidenceDir } : {}) });

  await writeOutput(sdk, "output/export-receipt.json", { style_id: style.style_id, revision: style.revision, dir }, "export_receipt");
  await sdk.done();
}

/** stage 9 of `library-production`: copies the finished episode + thumbnails into the kho as `pending_review` (spec §3.2 #9). */
async function exportStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const library = requireLibrary(app);
  const run = app.store.getRun(sdk.request.run_id);
  if (!run) throw new HarnessError("NOT_FOUND", `run not found: ${sdk.request.run_id}`, { run_id: sdk.request.run_id });
  if (!run.content_id) throw new HarnessError("CONFIG_INVALID", `run ${run.run_id} has no content_id`, { run_id: run.run_id });
  const content = app.store.getContentItem(run.content_id);
  if (!content) throw new HarnessError("NOT_FOUND", `content item not found: ${run.content_id}`, { content_id: run.content_id });

  const parsedBrief = libraryBriefSchema.passthrough().safeParse(readJsonFile(sdk.input("brief")));
  if (!parsedBrief.success) throw new HarnessError("CONFIG_INVALID", "brief.json failed schema validation", { issues: parsedBrief.error.issues });
  const brief: LibraryBrief = parsedBrief.data;

  const episodePath = sdk.input("episode_video");
  const thumbnailSetDir = sdk.input("thumbnail_set");
  const thumbnailPaths = readdirSync(thumbnailSetDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort()
    .map((name) => join(thumbnailSetDir, name));
  const editPlanPath = sdk.input("edit_plan");
  const captionsPath = sdk.hasInput("captions") ? sdk.input("captions") : undefined;
  const existingItemId = app.store.listLibraryItems().find((i) => i.lineage.run_id === run.run_id)?.item_id;

  const { receipt } = await exportItem({ store: app.store, fs: library.fs, clock: app.clock, prober: app.prober }, {
    run, content, brief, episodePath, thumbnailPaths, editPlanPath,
    ...(captionsPath !== undefined ? { captionsPath } : {}),
    ...(existingItemId !== undefined ? { existingItemId } : {}),
  });

  await writeOutput(sdk, "output/export-receipt.json", receipt, "export_receipt");
  await sdk.done();
}

/** stage 11 of `library-production`: reads the human decision from the `library-review` gate and applies it to the kho (spec §3.2 #11). */
async function applyReviewStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const library = requireLibrary(app);
  const review = parseReview(readJsonFile(sdk.input("review")));
  const item_id = parseExportReceiptItemId(readJsonFile(sdk.input("export_receipt")));

  const { item, request } = applyReview({ store: app.store, fs: library.fs, clock: app.clock }, {
    item_id, decision: review.decision, by: "gate:library-review", note: review.note,
  });
  const checks_failed = review.checks.filter((c) => !c.pass).length;

  await writeOutput(sdk, "output/apply-receipt.json", {
    item_id: item.item_id, status: item.status, checks_failed,
    ...(request ? { request_id: request.request_id, request_status: request.status } : {}),
  }, "apply_receipt");
  await sdk.done();
}

const STAGES: Record<string, (app: AppContext, sdk: ScriptContext) => Promise<void>> = {
  intake, "style-export": styleExport, export: exportStage, "apply-review": applyReviewStage,
};

/** Maps a thrown `HarnessError` (or anything else) to the sdk's `ctx.fail(kind, …)`, so the built-in stage
 * process always exits 0 with a `stage-result.json` the worker's `ScriptExecutor` can parse -- never a bare
 * process crash. `CONFIG_INVALID`/`INVALID_TRANSITION`/`NOT_FOUND` are contract problems with this run's
 * inputs; `IO_ERROR` (and anything unrecognized) is treated as transient and worth retrying. */
async function runStage(sdk: ScriptContext, app: AppContext, handler: (app: AppContext, sdk: ScriptContext) => Promise<void>): Promise<void> {
  try {
    await handler(app, sdk);
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

export function registerLibraryStage(library: Command): void {
  const stage = library.command("stage").description("run a built-in library script stage inside its ScriptExecutor-provided workspace");
  for (const name of Object.keys(STAGES)) {
    stage.command(name).description(`built-in "${name}" stage: reads stage-request.json from $HARNESS_WORKSPACE, writes stage-result.json`).action(async (_o, cmd) => {
      const sdk = await start({ env: process.env });
      await withContext(cmd, {}, async (app) => runStage(sdk, app, STAGES[name]!));
    });
  }
}
