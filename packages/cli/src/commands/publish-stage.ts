import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { start, type ScriptContext } from "@harness/script-sdk";
import {
  ChannelBriefSchema, ChannelPackageDraftSchema, DemandSchema, HarnessError, isHarnessError, LibraryItemSchema, PackageReceiptSchema,
  RequestsReceiptSchema, ScheduleReceiptSchema, TopicProposalSchema, UploadReceiptSchema,
  type ChannelPackageDraft, type LibraryItem, type PackageReceipt, type PublicationJob, type ScheduleReceipt, type UploadReceipt,
} from "@harness/contracts";
import { buildChannelBrief, buildUploadManifest, channelDemand, commitPackage, createDraftPackage, createJob, createRequest, eventFor, manifestDigest, nextSlot, sha256File, transitionPublication, type LoadedChannel } from "@harness/core";
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

/** The `upload`/`schedule` stages run in their own `harness publish stage …` CLI child process, spawned fresh
 * by the `ScriptExecutor` -- its `Redactor` only masks secret values *this* process has resolved
 * (`EnvSecretResolver.resolvedValues()`). The channel's `youtube.account_email_ref` is normally only resolved
 * by the `channel-identity` checker back in the `build-package` process, so without this call a legacy script
 * that echoes the account email (the real `upload-youtube-playwright.mjs` logs it as an account gate) would land
 * unredacted in this process's attempt log and `log_tail`. Resolving here purely registers the value with the
 * Redactor; an unresolved secret must not fail the stage -- `channel-identity` already reports that separately
 * -- so failures are swallowed, and the resolved value is never logged or stored. */
function registerAccountEmailForRedaction(app: AppContext, channel: LoadedChannel): void {
  try {
    app.secrets.resolve(channel.config.youtube.account_email_ref);
  } catch {
    // unresolved: channel-identity (build-package) already fails the run for this
  }
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

function parseDemand(raw: unknown) {
  const parsed = DemandSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "demand input failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}

function parseChannelBrief(raw: unknown) {
  const parsed = ChannelBriefSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "channel_brief input failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}

function parseTopicProposal(raw: unknown) {
  const parsed = TopicProposalSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", "topic_proposal input failed schema validation", { issues: parsed.error.issues });
  return parsed.data;
}

/** lowercase, trim, collapse internal whitespace -- same normalization `learningCheckers`'s `topics-valid`
 * uses (packages/core/src/learning/checkers.ts) for duplicate-topic detection. */
function normalizeTopic(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
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
  // marker written first: a crash between here and the subdirectories existing must not leave an unmarked
  // directory the guard above would reject forever on the next attempt.
  mkdirSync(episodeDir, { recursive: true });
  writeFileSync(markerFile, pkg.package_id);
  for (const sub of ["full-episode", "thumbnails", "publish"]) mkdirSync(join(episodeDir, sub), { recursive: true });

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
  // `draft.metadata`/`draft.hypothesis` go in too, not just the checksums: on a rerun `pkg` is the row an
  // earlier attempt inserted, whose metadata may predate the draft this manifest was just built from.
  const committed = commitPackage({ store: app.store, clock: app.clock }, {
    package_id: pkg.package_id, video_checksum: videoChecksum, thumbnail_checksum: thumbnailChecksum, manifest_digest: digest,
    metadata: draft.metadata, hypothesis: draft.hypothesis,
  });

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

/**
 * A previous attempt died somewhere mid-upload, leaving the job `UPLOADING`. What happens next depends on
 * exactly where its operation got to before the crash -- the upload may already have completed (`CONFIRMED`),
 * definitely didn't (`FAILED`), or is still genuinely unresolved (`INTENT_RECORDED`/`DISPATCHED`/already
 * `NEEDS_RECONCILIATION`, or the operation row itself is gone). Returns `undefined` once it has written this
 * attempt's `stage-result.json` itself (nothing left for `uploadStage` to do); returns the job's fresh state
 * when the caller should fall through into the normal `READY` upload path in this same attempt (the `FAILED`
 * case -- the upload never happened, so there's no reason to make the run wait for another retry).
 */
async function recoverUploading(app: AppContext, sdk: ScriptContext, job: PublicationJob): Promise<PublicationJob | undefined> {
  const reason = "a previous attempt died during upload; outcome unknown";
  const op = job.operation_id ? app.store.getExternalOperation(job.operation_id) : undefined;

  if (op?.status === "CONFIRMED") {
    if (!op.provider_ref) throw new HarnessError("CONFIG_INVALID", `operation ${op.operation_id} is CONFIRMED with no provider_ref`, { operation_id: op.operation_id });
    app.store.updatePublicationJob({ ...job, youtube_video_id: op.provider_ref, receipt: op.receipt });
    transitionPublication(app.store, job.publication_job_id, "UPLOADING", "PROCESSING");
    const uploaded: UploadReceipt = { schema_version: "harness.upload-receipt/v1", publication_job_id: job.publication_job_id, video_id: op.provider_ref, operation_id: op.operation_id, state: "PROCESSING" };
    await writeJsonOutput(sdk, "output/upload-receipt.json", uploaded, "upload_receipt");
    await sdk.done({ external_operations: [op.operation_id] });
    return undefined;
  }
  if (op?.status === "FAILED") {
    transitionPublication(app.store, job.publication_job_id, "UPLOADING", "READY");
    return app.store.getPublicationJob(job.publication_job_id)!;
  }
  // INTENT_RECORDED, DISPATCHED, already NEEDS_RECONCILIATION, or the operation row itself is missing: all
  // mean "we do not know whether the upload happened", exactly like a live `unknown` outcome from the
  // publisher. `markLost` only applies to an op that hasn't already been journaled lost.
  if (op && (op.status === "INTENT_RECORDED" || op.status === "DISPATCHED")) app.journal.markLost(op.operation_id, reason);
  transitionPublication(app.store, job.publication_job_id, "UPLOADING", "NEEDS_RECONCILIATION", { reason });
  await sdk.unknown(reason, op ? [op.operation_id] : []);
  return undefined;
}

/** stage 4 of `channel-publish`: records intent, drives the publisher's upload, and settles the publication
 * job + external-operation journal on whichever outcome the publisher reports (spec §3, §4.1). */
async function uploadStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const receipt = parsePackageReceipt(readJsonFile(sdk.input("channel_package")));
  let job = app.store.getPublicationJob(receipt.publication_job_id);
  if (!job) throw new HarnessError("NOT_FOUND", `publication job not found: ${receipt.publication_job_id}`, { publication_job_id: receipt.publication_job_id });

  if (job.state === "PROCESSING" || job.state === "SCHEDULED" || job.state === "PUBLISHED") {
    const idempotent: UploadReceipt = { schema_version: "harness.upload-receipt/v1", publication_job_id: job.publication_job_id, video_id: job.youtube_video_id ?? "", operation_id: job.operation_id ?? "", state: job.state };
    await writeJsonOutput(sdk, "output/upload-receipt.json", idempotent, "upload_receipt");
    await sdk.done({ external_operations: job.operation_id ? [job.operation_id] : [] });
    return;
  }

  // Not a contract problem for *this* attempt to fail on: recoverUploading either finishes the stage-result
  // itself, or hands back the job now back at READY so this attempt can just retry the upload below.
  if (job.state === "UPLOADING") {
    const retried = await recoverUploading(app, sdk, job);
    if (!retried) return;
    job = retried;
  }
  if (job.state !== "READY") {
    throw new HarnessError("INVALID_TRANSITION", `publication job ${job.publication_job_id} is ${job.state}; upload needs READY`, { publication_job_id: job.publication_job_id, state: job.state });
  }

  const pkg = app.store.getChannelPackage(receipt.package_id);
  if (!pkg) throw new HarnessError("NOT_FOUND", `channel package not found: ${receipt.package_id}`, { package_id: receipt.package_id });
  const channel = requireChannel(app, job.channel_id);
  registerAccountEmailForRedaction(app, channel);

  const intent = app.journal.recordIntent({
    request: { run_id: sdk.request.run_id, stage_run_id: sdk.request.stage_run_id, attempt_id: sdk.request.attempt_id },
    provider: app.publisher.name, kind: "youtube-upload", target: job.channel_id, payload: { idempotency_key: job.idempotency_key },
  });
  app.store.updatePublicationJob({ ...job, operation_id: intent.operation_id });
  transitionPublication(app.store, job.publication_job_id, "READY", "UPLOADING");

  // Marked DISPATCHED *before* the (up to 45-minute) upload call, not after: if this process dies mid-upload,
  // the op must already be past INTENT_RECORDED so `journal.markLost`/`markFailed` (called by the next
  // attempt's UPLOADING-recovery branch above, or by `harness publish reconcile`) can act on it. `recordIntent`
  // returns an *existing* op verbatim when one is already current for this idempotency key, so this is a no-op
  // on a retry that already got past this point.
  if (intent.status === "INTENT_RECORDED") {
    const run = app.store.getRun(sdk.request.run_id)!;
    const stageRun = app.store.getStageRun(sdk.request.stage_run_id) ?? null;
    const attempt = app.store.getAttempt(sdk.request.attempt_id) ?? null;
    app.store.transition("external_operation", intent.operation_id, "INTENT_RECORDED", "DISPATCHED", eventFor(run, stageRun, attempt, "external_operation.dispatched", "info", { operation_id: intent.operation_id }));
  }

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

/**
 * Asks the publisher whether `videoId` is *already* scheduled for a future time, returning that time. A lookup
 * that fails (no network, logged-out Studio profile, `error: true`) or that reports anything else returns
 * `undefined`: the caller then books a slot as usual, exactly as it did before this check existed.
 */
async function alreadyScheduledAt(app: AppContext, channelId: string, videoId: string, sdk: ScriptContext): Promise<string | undefined> {
  let outcome;
  try {
    outcome = await app.publisher.lookup({ channel: app.channels.toPublisherChannel(channelId), video_id: videoId });
  } catch (e) {
    sdk.log.warn(`schedule pre-check lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  if (!outcome.found) {
    if (outcome.error) sdk.log.warn(`schedule pre-check lookup failed: ${outcome.reason}`);
    return undefined;
  }
  if (outcome.visibility !== "scheduled" || !outcome.publish_at) return undefined;
  if (Date.parse(outcome.publish_at) <= Date.parse(app.clock.now())) return undefined;
  return outcome.publish_at;
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
  registerAccountEmailForRedaction(app, channel);

  // Spec §3 stage 5: a retry must ask YouTube before booking anything. `schedule_attempted_at` is written
  // onto the job receipt immediately before every `Publisher.schedule` call, so its presence means an earlier
  // attempt already drove the legacy script -- possibly far enough to book the slot before dying. Booking a
  // second slot for the same video is a real, visible mistake (the channel's schedule fills up with ghosts),
  // so when the lookup says the video is already scheduled for a future time, that time is simply recorded.
  const priorReceipt = { ...(job.receipt ?? {}) } as Record<string, unknown>;
  if (typeof priorReceipt.schedule_attempted_at === "string") {
    const already = await alreadyScheduledAt(app, job.channel_id, videoId, sdk);
    if (already) {
      app.store.updatePublicationJob({ ...job, scheduled_at: already });
      transitionPublication(app.store, job.publication_job_id, "PROCESSING", "SCHEDULED");
      const recovered: ScheduleReceipt = { schema_version: "harness.schedule-receipt/v1", publication_job_id: job.publication_job_id, video_id: videoId, scheduled_at: already };
      await writeJsonOutput(sdk, "output/schedule-receipt.json", recovered, "publication_receipt");
      await sdk.done();
      return;
    }
  }

  const taken = app.store.listPublicationJobs({ channel_id: job.channel_id })
    .filter((j) => j.state === "SCHEDULED" || j.state === "PUBLISHED")
    .map((j) => j.scheduled_at)
    .filter((at): at is string => at !== null);
  const at = nextSlot(channel.config.publication, taken, app.clock.now());

  // Durable *before* the call, so the next attempt knows a booking may already have happened (above).
  app.store.updatePublicationJob({ ...job, receipt: { ...priorReceipt, schedule_attempted_at: app.clock.now() } });

  const outcome = await app.publisher.schedule({ channel: app.channels.toPublisherChannel(job.channel_id), video_id: videoId, at, timeout_seconds: 900, log: (l) => sdk.log.info(l) });

  if (outcome.kind === "scheduled") {
    const current = app.store.getPublicationJob(job.publication_job_id)!;
    app.store.updatePublicationJob({ ...current, scheduled_at: at });
    transitionPublication(app.store, job.publication_job_id, "PROCESSING", "SCHEDULED");
    const scheduled: ScheduleReceipt = { schema_version: "harness.schedule-receipt/v1", publication_job_id: job.publication_job_id, video_id: videoId, scheduled_at: at };
    await writeJsonOutput(sdk, "output/schedule-receipt.json", scheduled, "publication_receipt");
    await sdk.done();
    return;
  }
  if (outcome.kind === "refused") { await sdk.fail("contract", outcome.reason); return; }
  await sdk.fail("transient", outcome.reason); // busy
}

/** shared by `channel-brief`/`demand`/`create-requests`: every one of them needs this run's channel, resolved
 * from `content.library_channel_id` -- missing it is a contract problem with this run, not something to retry. */
function requireRunChannel(app: AppContext, sdk: ScriptContext): { channel: LoadedChannel; channelId: string; content: ReturnType<typeof runOf>["content"]; run: ReturnType<typeof runOf>["run"] } {
  const { run, content } = runOf(app, sdk);
  if (!content.library_channel_id) throw new HarnessError("CONFIG_INVALID", `content ${content.content_id} has no library_channel_id`, { content_id: content.content_id });
  return { channel: requireChannel(app, content.library_channel_id), channelId: content.library_channel_id, content, run };
}

/** `channel-brief` stage (spec §3.3, §4.2): assembles `output/channel-brief.json` for both `channel-publish`
 * (after `fetch-library-item`, where `content.library_item_id` is always set -- the item is read from the kho)
 * and `channel-planning` (planning content carries no `library_item_id` yet -- `item` is simply `null`, the
 * normal case for a planning run, not an error). */
async function channelBriefStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const { channel, content } = requireRunChannel(app, sdk);
  let item: LibraryItem | null = null;
  if (content.library_item_id) {
    const library = requireLibrary(app);
    item = library.fs.readJson(library.fs.paths.manifest(content.library_item_id), LibraryItemSchema);
  }
  const brief = buildChannelBrief({ store: app.store, clock: app.clock, channel, item });
  await writeJsonOutput(sdk, "output/channel-brief.json", brief, "channel_brief");
  await sdk.done();
}

/** `demand` stage (spec §4.2): assembles `output/demand.json` -- how many more episodes this channel's
 * publish schedule needs, and how much of that is already covered. */
async function demandStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const { channel } = requireRunChannel(app, sdk);
  const library = requireLibrary(app);
  const libraryItems = app.store.listLibraryItems({ status: "approved" });
  const demand = channelDemand({ store: app.store, clock: app.clock, channel, libraryItems, libraryClaimsOf: (itemId) => library.fs.listClaims(itemId) });
  await writeJsonOutput(sdk, "output/demand.json", demand, "demand");
  await sdk.done();
}

/** Resolves the edit style a planned topic buys: the topic's own `style_id` when it named one, else the
 * channel's most recently created active style (`listEditStyles` is insertion-ordered, so the last entry is
 * the newest). Either way the style's *current* `revision` is read back from the store -- a `TopicProposal`
 * never carries a revision of its own. No active style anywhere is a contract problem: `create-requests` has
 * nothing to assign the planned topic to. */
function resolveStyleFor(app: AppContext, topicStyleId: string | undefined): { style_id: string; style_revision: number } {
  if (topicStyleId) {
    const style = app.store.getEditStyle(topicStyleId);
    if (!style) throw new HarnessError("NOT_FOUND", `edit style not found: ${topicStyleId}`, { style_id: topicStyleId });
    return { style_id: style.style_id, style_revision: style.revision };
  }
  const active = app.store.listEditStyles({ status: "active" }).at(-1);
  if (!active) throw new HarnessError("CONFIG_INVALID", "no active edit style available to assign to a planned topic", {});
  return { style_id: active.style_id, style_revision: active.revision };
}

/** `create-requests` stage (spec §4.2): turns proposed topics into kho content requests, capped by three
 * independent limits at once -- `demand.needed` (the publish schedule doesn't need more), `room` (the
 * channel's `max_open_requests` headroom: `max_open_requests - open_requests`, so the studio is never handed
 * more open work than the channel is allowed to have queued), and `demand.topics_per_run` (the channel's own
 * per-run cap). Without `room` in the mix, a channel with a generous `lookahead_slots` but a tight
 * `max_open_requests` could have every one of `demand.needed`'s slots turned into an open request in a single
 * run, blowing straight through the open-request cap `planningNeeded` is supposed to enforce.
 * Idempotent per run -- a topic whose normalized text matches an existing request already carrying this
 * run's id in its `notes` is left alone (its id is still reported in the receipt), so a retried attempt never
 * double-books the same topic. */
async function createRequestsStage(app: AppContext, sdk: ScriptContext): Promise<void> {
  const { run, channelId } = requireRunChannel(app, sdk);
  const library = requireLibrary(app);

  const proposal = parseTopicProposal(readJsonFile(sdk.input("topic_proposal")));
  const demand = parseDemand(readJsonFile(sdk.input("demand")));
  const brief = parseChannelBrief(readJsonFile(sdk.input("channel_brief")));

  const room = Math.max(0, demand.max_open_requests - demand.open_requests);
  const cap = Math.min(demand.needed, room, demand.topics_per_run);
  const candidates = proposal.topics.slice(0, cap);
  const existingForRun = app.store.listContentRequests({}).filter((r) => r.requested_by.channel_id === channelId && r.notes.includes(run.run_id));
  const byTopic = new Map(existingForRun.map((r) => [normalizeTopic(r.topic), r.request_id]));

  const requestIds: string[] = [];
  const createdIds: string[] = [];
  for (const topic of candidates) {
    const key = normalizeTopic(topic.topic);
    const existingId = byTopic.get(key);
    if (existingId) { requestIds.push(existingId); continue; }

    const { style_id, style_revision } = resolveStyleFor(app, topic.style_id);
    const created = createRequest({ store: app.store, fs: library.fs, clock: app.clock }, {
      requested_by: { portfolio_id: run.portfolio_id, channel_id: channelId },
      topic: topic.topic, style_id, style_revision, voice: topic.voice ?? "none", language: brief.channel.seo.language,
      ...(topic.target_duration_seconds !== undefined ? { target_duration_seconds: topic.target_duration_seconds } : {}),
      ...(topic.source_hint !== undefined ? { source_hint: topic.source_hint } : {}),
      notes: `auto-plan ${run.run_id}: ${topic.why}`,
    });
    requestIds.push(created.request_id);
    createdIds.push(created.request_id);
    byTopic.set(key, created.request_id); // guards against duplicate topics inside the same proposal
  }

  if (createdIds.length > 0) {
    const stageRun = app.store.getStageRun(sdk.request.stage_run_id) ?? null;
    const attempt = app.store.getAttempt(sdk.request.attempt_id) ?? null;
    app.store.appendEvent(eventFor(run, stageRun, attempt, "channel.requests_created", "info", { channel_id: channelId, run_id: run.run_id, request_ids: createdIds }));
  }

  const receipt = RequestsReceiptSchema.parse({ schema_version: "harness.requests-receipt/v1", request_ids: requestIds });
  await writeJsonOutput(sdk, "output/requests-receipt.json", receipt, "requests_receipt");
  await sdk.done();
}

const STAGES: Record<string, (app: AppContext, sdk: ScriptContext) => Promise<void>> = {
  fetch: fetchStage, "build-package": buildPackageStage, upload: uploadStage, schedule: scheduleStage,
  "channel-brief": channelBriefStage, demand: demandStage, "create-requests": createRequestsStage,
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
