import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { start, type ScriptContext } from "@harness/script-sdk";
import {
  ChannelPackageDraftSchema, HarnessError, isHarnessError, LibraryItemSchema, PackageReceiptSchema, ScheduleReceiptSchema, UploadReceiptSchema,
  type ChannelPackageDraft, type PackageReceipt, type ScheduleReceipt, type UploadReceipt,
} from "@harness/contracts";
import { buildUploadManifest, commitPackage, createDraftPackage, createJob, manifestDigest, nextSlot, sha256File, transitionPublication, type LoadedChannel } from "@harness/core";
import type { AppContext } from "../composition.js";
import { requireLibrary } from "./library-stage.js";
import { withContext } from "./shared.js";

/** Every stage below that needs a channel needs `app.channels` to have loaded cleanly; a broken `channels/`
 * directory is a contract problem for the run, exactly like a missing brief or library. */
function requireChannel(app: AppContext, id: string): LoadedChannel {
  if (app.channelErrors.length > 0) {
    throw new HarnessError("CONFIG_INVALID", `channels/ in ${app.projectDir} failed to load: ${app.channelErrors.join("; ")}`, { errors: app.channelErrors });
  }
  return app.channels.get(id);
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

function parseDraft(raw: unknown): ChannelPackageDraft {
  const parsed = ChannelPackageDraftSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "channel_package_draft output failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}

function parsePackageReceipt(raw: unknown): PackageReceipt {
  const parsed = PackageReceiptSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "channel_package output failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}

function parseUploadReceipt(raw: unknown): UploadReceipt {
  const parsed = UploadReceiptSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "upload_receipt output failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}

/** Writes `value` as the named JSON output under the workspace and registers it with the sdk, mirroring
 * `library-stage.ts`'s `writeOutput`. */
async function writeJsonOutput(sdk: ScriptContext, relPath: string, value: unknown, type: string): Promise<void> {
  const abs = join(sdk.workspace, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(value, null, 2) + "\n");
  await sdk.out.file(relPath, { type });
}

function runOf(app: AppContext, sdk: ScriptContext) {
  const run = app.store.getRun(sdk.request.run_id);
  if (!run) throw new HarnessError("NOT_FOUND", `run not found: ${sdk.request.run_id}`, { run_id: sdk.request.run_id });
  if (!run.content_id) throw new HarnessError("CONFIG_INVALID", `run ${run.run_id} has no content_id`, { run_id: run.run_id });
  const content = app.store.getContentItem(run.content_id);
  if (!content) throw new HarnessError("NOT_FOUND", `content item not found: ${run.content_id}`, { content_id: run.content_id });
  return { run, content };
}

/** stage 1 of `channel-publish`: pulls the approved kho item's files into the workspace (spec §3). */
async function fetchStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const { content } = runOf(app, sdk);
  if (!content.library_item_id || !content.library_channel_id) {
    throw new HarnessError("CONFIG_INVALID", `content ${content.content_id} has no library_item_id/library_channel_id -- pick it via "library pick" first`, { content_id: content.content_id });
  }
  const library = requireLibrary(app);
  const itemId = content.library_item_id;
  const channelId = content.library_channel_id;

  const manifest = library.fs.readJson(library.fs.paths.manifest(itemId), LibraryItemSchema);
  if (manifest.status !== "approved") {
    throw new HarnessError("CONFIG_INVALID", `item ${itemId} is ${manifest.status}`, { item_id: itemId, status: manifest.status });
  }
  const claimFile = library.fs.paths.claimFile(itemId, channelId);
  if (!existsSync(claimFile)) {
    throw new HarnessError("CONFIG_INVALID", `no claim for channel ${channelId} on item ${itemId}`, { item_id: itemId, channel_id: channelId });
  }

  const itemDir = library.fs.paths.itemDir(itemId);
  const outputDir = join(sdk.workspace, "output");
  mkdirSync(join(outputDir, "thumbnails"), { recursive: true });

  for (const file of manifest.files) {
    let dest: string | undefined;
    if (file.path === "episode.mp4") dest = join(outputDir, "episode.mp4");
    else if (file.mime_type.startsWith("image/")) dest = join(outputDir, "thumbnails", file.path);
    else if (file.path.startsWith("captions")) dest = join(outputDir, "captions", file.path); // copied, never registered as an sdk output
    else continue;

    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(itemDir, file.path), dest);
    const { checksum } = await sha256File(dest);
    if (checksum !== file.checksum) {
      throw new HarnessError("IO_ERROR", `checksum mismatch copying ${file.path} for item ${itemId}`, { item_id: itemId, path: file.path, expected: file.checksum, actual: checksum });
    }
  }

  await writeJsonOutput(sdk, "output/brief.json", {
    item_id: itemId, title_hint: manifest.title_hint, summary: manifest.summary, duration_seconds: manifest.duration_seconds,
    style: manifest.style, ...(manifest.request_id ? { request_id: manifest.request_id } : {}), lineage: manifest.lineage, files: manifest.files,
  }, "library_brief");
  await sdk.out.file("output/episode.mp4", { type: "episode_video" });
  await sdk.out.dir("output/thumbnails", { type: "thumbnail_set" });
  await sdk.done();
}

/** stage 3 of `channel-publish`: turns the agent's draft + fetched files into a committed package under the
 * legacy channel repo, ready for the legacy Playwright upload script (spec §3). */
async function buildPackageStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const { run, content } = runOf(app, sdk);
  if (!content.library_channel_id) throw new HarnessError("CONFIG_INVALID", `content ${content.content_id} has no library_channel_id`, { content_id: content.content_id });
  const channel = requireChannel(app, content.library_channel_id);
  const draft = parseDraft(readJsonFile(sdk.input("channel_package_draft")));

  const repoDir = resolve(channel.config.repo_dir);
  if (!existsSync(repoDir)) throw new HarnessError("IO_ERROR", `channel repo not found: ${repoDir}`, { repo_dir: repoDir });

  let pkg = app.store.listChannelPackages({ run_id: run.run_id })[0];
  if (!pkg) {
    const variantId = run.variant_id;
    if (!variantId) throw new HarnessError("CONFIG_INVALID", `run ${run.run_id} has no variant_id`, { run_id: run.run_id });
    const videoInput = sdk.request.inputs.find((i) => i.type === "episode_video");
    const thumbInput = sdk.request.inputs.find((i) => i.type === "thumbnail_set");
    if (!videoInput) throw new HarnessError("CONFIG_INVALID", "build-package has no episode_video input", {});
    if (!thumbInput) throw new HarnessError("CONFIG_INVALID", "build-package has no thumbnail_set input", {});
    const episodesDir = join(repoDir, "outputs", channel.config.legacy_project_id, "episodes");
    pkg = createDraftPackage({ store: app.store, clock: app.clock }, {
      channel, run, content, draft, variant_id: variantId, video_artifact_id: videoInput.artifact_id, thumbnail_artifact_id: thumbInput.artifact_id, repoEpisodesDir: episodesDir,
    });
  }

  const nn = String(pkg.episode_no).padStart(2, "0");
  const episodeDir = pkg.episode_dir;
  const markerFile = join(episodeDir, ".harness-package-id");
  if (existsSync(episodeDir)) {
    const owner = existsSync(markerFile) ? readFileSync(markerFile, "utf8").trim() : undefined;
    if (owner !== pkg.package_id) {
      throw new HarnessError("CONFIG_INVALID", `episode directory ${episodeDir} already exists and was not created by package ${pkg.package_id}`, { episode_dir: episodeDir, package_id: pkg.package_id });
    }
  }
  for (const sub of ["full-episode", "thumbnails", "publish"]) mkdirSync(join(episodeDir, sub), { recursive: true });
  writeFileSync(markerFile, pkg.package_id);

  const videoDest = join(episodeDir, "full-episode", `episode-${nn}-full-episode.mp4`);
  copyFileSync(sdk.input("episode_video"), videoDest);

  const thumbDest = join(episodeDir, "thumbnails", "opt1.png");
  const candidate = join(sdk.input("thumbnail_set"), draft.hypothesis.chosen.thumbnail_candidate);
  const overlayScript = join(repoDir, "scripts", "gen-thumb-overlay.mjs");
  const overlayText = draft.hypothesis.chosen.overlay_text;
  const overlayRequested = sdk.request.options.overlay !== "none";
  if (channel.config.overlay.enabled && overlayText.length > 0 && existsSync(overlayScript) && overlayRequested) {
    const args = ["scripts/gen-thumb-overlay.mjs", "--bg", candidate, "--out", thumbDest, "--line1", overlayText[0]!];
    if (overlayText[1]) args.push("--line2", overlayText[1]);
    if (overlayText[2]) args.push("--line3", overlayText[2]);
    args.push("--side", channel.config.overlay.side, "--ep", nn);
    const r = spawnSync(process.execPath, args, { cwd: repoDir, timeout: 300_000, encoding: "utf8" });
    if (r.status !== 0) {
      throw new HarnessError("EXECUTOR_FAILED", `gen-thumb-overlay.mjs exited with code ${r.status}`, { status: r.status, stderr: r.stderr, stdout: r.stdout });
    }
  } else {
    copyFileSync(candidate, thumbDest);
  }

  const manifest = buildUploadManifest({ metadata: draft.metadata, videoPath: videoDest, thumbnailPath: thumbDest });
  const manifestRelPath = `publish/episode-${nn}-upload-manifest.json`;
  const manifestAbsPath = join(episodeDir, "publish", `episode-${nn}-upload-manifest.json`);
  writeFileSync(manifestAbsPath, JSON.stringify(manifest, null, 2) + "\n");

  const videoChecksum = (await sha256File(videoDest)).checksum;
  const thumbnailChecksum = (await sha256File(thumbDest)).checksum;
  const digest = manifestDigest(manifest);
  const committed = commitPackage({ store: app.store, clock: app.clock }, { package_id: pkg.package_id, video_checksum: videoChecksum, thumbnail_checksum: thumbnailChecksum, manifest_digest: digest });

  const job = app.store.listPublicationJobs({ run_id: run.run_id })[0] ?? createJob({ store: app.store, clock: app.clock }, { pkg: committed });

  const publicationDir = join(app.dataRoot, "publications", channel.config.channel_id, job.publication_job_id);
  mkdirSync(publicationDir, { recursive: true });
  copyFileSync(manifestAbsPath, join(publicationDir, "package-manifest.json"));
  const dashboardThumbDir = join(app.dataRoot, "dashboard", "thumbnails");
  mkdirSync(dashboardThumbDir, { recursive: true });
  copyFileSync(thumbDest, join(dashboardThumbDir, `${committed.package_id}.png`));

  const receipt: PackageReceipt = {
    schema_version: "harness.package-receipt/v1", package_id: committed.package_id, publication_job_id: job.publication_job_id, channel_id: channel.config.channel_id,
    episode_no: committed.episode_no, episode_dir: committed.episode_dir, manifest_path: manifestRelPath,
    video_checksum: videoChecksum, thumbnail_checksum: thumbnailChecksum, manifest_digest: digest,
  };
  await writeJsonOutput(sdk, "output/package-receipt.json", receipt, "channel_package");
  await sdk.done();
}

/** stage 4 of `channel-publish`: records intent, drives the publisher's upload, and settles the publication
 * job + external-operation journal on whichever outcome the publisher reports (spec §3, §4.1). */
async function uploadStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const receipt = parsePackageReceipt(readJsonFile(sdk.input("channel_package")));
  const job = app.store.getPublicationJob(receipt.publication_job_id);
  if (!job) throw new HarnessError("NOT_FOUND", `publication job not found: ${receipt.publication_job_id}`, { publication_job_id: receipt.publication_job_id });

  if (job.state === "PROCESSING" || job.state === "SCHEDULED" || job.state === "PUBLISHED") {
    const idempotent: UploadReceipt = { schema_version: "harness.upload-receipt/v1", publication_job_id: job.publication_job_id, video_id: job.youtube_video_id ?? "", operation_id: job.operation_id ?? "", state: job.state };
    await writeJsonOutput(sdk, "output/upload-receipt.json", idempotent, "upload_receipt");
    await sdk.done({ external_operations: job.operation_id ? [job.operation_id] : [] });
    return;
  }
  if (job.state !== "READY") {
    throw new HarnessError("INVALID_TRANSITION", `publication job ${job.publication_job_id} is ${job.state}; upload needs READY`, { publication_job_id: job.publication_job_id, state: job.state });
  }

  const pkg = app.store.getChannelPackage(receipt.package_id);
  if (!pkg) throw new HarnessError("NOT_FOUND", `channel package not found: ${receipt.package_id}`, { package_id: receipt.package_id });
  requireChannel(app, job.channel_id);

  const intent = app.journal.recordIntent({
    request: { run_id: sdk.request.run_id, stage_run_id: sdk.request.stage_run_id, attempt_id: sdk.request.attempt_id },
    provider: app.publisher.name, kind: "youtube-upload", target: job.channel_id, payload: { idempotency_key: job.idempotency_key },
  });
  app.store.updatePublicationJob({ ...job, operation_id: intent.operation_id });
  transitionPublication(app.store, job.publication_job_id, "READY", "UPLOADING");

  const outcome = await app.publisher.upload({
    channel: app.channels.toPublisherChannel(job.channel_id), episode_no: pkg.episode_no, episode_dir: pkg.episode_dir,
    intent_at: intent.created_at, timeout_seconds: 2700, log: (l) => sdk.log.info(l),
  });

  if (outcome.kind === "uploaded") {
    app.journal.confirmExternal(intent.operation_id, { provider_ref: outcome.video_id, receipt: outcome.receipt });
    const current = app.store.getPublicationJob(job.publication_job_id)!;
    app.store.updatePublicationJob({ ...current, youtube_video_id: outcome.video_id, receipt: outcome.receipt });
    transitionPublication(app.store, job.publication_job_id, "UPLOADING", "PROCESSING");
    const uploaded: UploadReceipt = { schema_version: "harness.upload-receipt/v1", publication_job_id: job.publication_job_id, video_id: outcome.video_id, operation_id: intent.operation_id, state: "PROCESSING" };
    await writeJsonOutput(sdk, "output/upload-receipt.json", uploaded, "upload_receipt");
    await sdk.done({ external_operations: [intent.operation_id] });
    return;
  }
  if (outcome.kind === "unknown") {
    app.journal.markLost(intent.operation_id, outcome.reason);
    transitionPublication(app.store, job.publication_job_id, "UPLOADING", "NEEDS_RECONCILIATION", { reason: outcome.reason });
    await sdk.unknown(outcome.reason, [intent.operation_id]);
    return;
  }
  if (outcome.kind === "refused") {
    app.journal.markFailed(intent.operation_id, outcome.reason);
    transitionPublication(app.store, job.publication_job_id, "UPLOADING", "READY", { reason: outcome.reason });
    await sdk.fail("contract", outcome.reason);
    return;
  }
  // busy
  app.journal.markFailed(intent.operation_id, outcome.reason);
  transitionPublication(app.store, job.publication_job_id, "UPLOADING", "READY", { reason: outcome.reason });
  await sdk.fail("transient", outcome.reason);
}

/** stage 5 of `channel-publish`: books the next free publish slot and drives the publisher's schedule call
 * (spec §3). No external-operation journal here -- `Publisher.schedule` is itself idempotent per video id, and
 * the workflow's own retry policy covers a transient failure. */
async function scheduleStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const receipt = parseUploadReceipt(readJsonFile(sdk.input("upload_receipt")));
  const job = app.store.getPublicationJob(receipt.publication_job_id);
  if (!job) throw new HarnessError("NOT_FOUND", `publication job not found: ${receipt.publication_job_id}`, { publication_job_id: receipt.publication_job_id });

  if (job.state === "SCHEDULED" || job.state === "PUBLISHED") {
    const idempotent: ScheduleReceipt = { schema_version: "harness.schedule-receipt/v1", publication_job_id: job.publication_job_id, video_id: job.youtube_video_id ?? "", scheduled_at: job.scheduled_at ?? app.clock.now() };
    await writeJsonOutput(sdk, "output/schedule-receipt.json", idempotent, "publication_receipt");
    await sdk.done();
    return;
  }
  if (job.state !== "PROCESSING") {
    throw new HarnessError("INVALID_TRANSITION", `publication job ${job.publication_job_id} is ${job.state}; schedule needs PROCESSING`, { publication_job_id: job.publication_job_id, state: job.state });
  }
  const videoId = job.youtube_video_id;
  if (!videoId) throw new HarnessError("CONFIG_INVALID", `publication job ${job.publication_job_id} has no youtube_video_id`, { publication_job_id: job.publication_job_id });
  const channel = requireChannel(app, job.channel_id);

  const taken = app.store.listPublicationJobs({ channel_id: job.channel_id })
    .filter((j) => j.state === "SCHEDULED" || j.state === "PUBLISHED")
    .map((j) => j.scheduled_at)
    .filter((at): at is string => at !== null);
  const at = nextSlot(channel.config.publication, taken, app.clock.now());

  const outcome = await app.publisher.schedule({ channel: app.channels.toPublisherChannel(job.channel_id), video_id: videoId, at, timeout_seconds: 900, log: (l) => sdk.log.info(l) });

  if (outcome.kind === "scheduled") {
    app.store.updatePublicationJob({ ...job, scheduled_at: at });
    transitionPublication(app.store, job.publication_job_id, "PROCESSING", "SCHEDULED");
    const scheduled: ScheduleReceipt = { schema_version: "harness.schedule-receipt/v1", publication_job_id: job.publication_job_id, video_id: videoId, scheduled_at: at };
    await writeJsonOutput(sdk, "output/schedule-receipt.json", scheduled, "publication_receipt");
    await sdk.done();
    return;
  }
  if (outcome.kind === "refused") { await sdk.fail("contract", outcome.reason); return; }
  await sdk.fail("transient", outcome.reason); // busy
}

const STAGES: Record<string, (app: AppContext, sdk: ScriptContext) => Promise<void>> = {
  fetch: fetchStage, "build-package": buildPackageStage, upload: uploadStage, schedule: scheduleStage,
};

/** Maps a thrown `HarnessError` (or anything else) to the sdk's `ctx.fail(kind, …)`, identical to
 * `library-stage.ts`'s `runStage`: `CONFIG_INVALID`/`INVALID_TRANSITION`/`NOT_FOUND` are contract problems with
 * this run's inputs; `IO_ERROR` (and anything unrecognized, including `EXECUTOR_FAILED`) is transient. */
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

export function registerPublishStage(publish: Command): void {
  const stage = publish.command("stage").description("run a built-in channel-publish script stage inside its ScriptExecutor-provided workspace");
  for (const name of Object.keys(STAGES)) {
    stage.command(name).description(`built-in "${name}" stage: reads stage-request.json from $HARNESS_WORKSPACE, writes stage-result.json`).action(async (_o, cmd) => {
      const sdk = await start({ env: process.env });
      await withContext(cmd, {}, async (app) => runStage(sdk, app, STAGES[name]!));
    });
  }
}
