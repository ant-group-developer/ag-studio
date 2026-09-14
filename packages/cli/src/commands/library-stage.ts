import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { start, type ScriptContext } from "@harness/script-sdk";
import { EditStyleSchema, HarnessError, isHarnessError, libraryBriefSchema, type LibraryBrief } from "@harness/contracts";
import { applyReview, claimRequest, exportItem, exportStyle } from "@harness/core";
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

function parseReview(raw: unknown): { decision: "approved" | "rejected"; note?: string } {
  if (!raw || typeof raw !== "object") throw new HarnessError("CONFIG_INVALID", "review.json must be a JSON object", { raw });
  const r = raw as Record<string, unknown>;
  if (r.decision !== "approved" && r.decision !== "rejected") throw new HarnessError("CONFIG_INVALID", 'review.json "decision" must be "approved" or "rejected"', { decision: r.decision });
  if (r.note !== undefined && typeof r.note !== "string") throw new HarnessError("CONFIG_INVALID", 'review.json "note" must be a string', { note: r.note });
  return { decision: r.decision, ...(typeof r.note === "string" ? { note: r.note } : {}) };
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

  if (brief.request_id) claimRequest({ store: app.store, fs: library.fs, clock: app.clock }, { request_id: brief.request_id, run: { project_id: run.project_id, run_id: run.run_id } });

  await writeOutput(sdk, "output/brief.json", { ...brief, style_snapshot: style }, "brief");
  await sdk.done();
}

/** stage 4 of `style-study`: publishes an approved style (plus optional evidence) into the kho (spec §3.1). */
async function styleExport(app: AppContext, sdk: ScriptContext): Promise<void> {
  const library = requireLibrary(app);
  const parsedStyle = EditStyleSchema.safeParse(readJsonFile(sdk.input("style")));
  if (!parsedStyle.success) throw new HarnessError("CONFIG_INVALID", "style.json failed schema validation", { issues: parsedStyle.error.issues });
  if (parsedStyle.data.status !== "active") throw new HarnessError("CONFIG_INVALID", `style ${parsedStyle.data.style_id} is ${parsedStyle.data.status}, not active`, { style_id: parsedStyle.data.style_id, status: parsedStyle.data.status });
  const evidenceDir = sdk.hasInput("style_evidence") ? sdk.input("style_evidence") : undefined;

  const { style, dir } = await exportStyle({ store: app.store, fs: library.fs, clock: app.clock }, { style: parsedStyle.data, ...(evidenceDir !== undefined ? { evidenceDir } : {}) });

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
    item_id, decision: review.decision, by: "gate:library-review",
    ...(review.note !== undefined ? { note: review.note } : {}),
  });

  await writeOutput(sdk, "output/apply-receipt.json", {
    item_id: item.item_id, status: item.status,
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
