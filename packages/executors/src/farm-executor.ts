/**
 * `farm` executor: delegates a stage to ag-farm (OmniWorker cluster). The executor:
 *  1. Uploads stage input artifacts to the production's object store under a deterministic
 *     per-attempt prefix (`productions/<prodId>/jobs/<stageKey>/<attemptId>/in/<input.path>`).
 *     The full relative path is preserved so farm_payload can reference inputs as
 *     `stage:<input.path>` (e.g. `stage:renders/1/composition.json`). The farm sign_url
 *     endpoint resolves `stage:<path>` → `${inputPrefix}<path>`.
 *  2. Submits the job to ag-farm (requirements: `requirementsFor`, else `stage_config.requirements`, else any
 *     node) using `stage_config.farm_payload` directly — the payload must
 *     already conform to the schema for the job type (StudioTtsPayloadSchema /
 *     StudioRenderPayloadSchema). The payload is validated before submission; an extra `inputs:`
 *     key is never added (the strict hub schema would reject it).
 *  3. Calls `onSubmitted` so that `studio_farm_jobs` is populated before the worker can call
 *     `/farm/sign`.
 *  4. Polls ag-farm until the job reaches a terminal state; heartbeat on the stage keeps the
 *     lease alive while we wait.
 *  5. On completion reads `result.manifest` (e.g. `tts.json` / `render.json`) from the
 *     production's output prefix, validates it with the appropriate schema, and downloads the
 *     listed output artifacts into the stage workspace so checkers and downstream stages can
 *     read them exactly like any other stage output.
 *  0. Takes over the job an earlier attempt of the stage left on the farm when it would send it again unchanged
 *     (`earlierJobsFor`, `farmJobFingerprint`), and cancels the other earlier jobs.
 *  6. Cancels the farm job when the stage deadline is exceeded or the run is cancelled (`STAGE_CANCELLED`); a worker
 *     stopping or a lost lease leaves it for the next attempt to take over.
 *  7. Acks the job (marks it consumed by the owner).
 */
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, existsSync, copyFileSync, writeFileSync, createReadStream } from "node:fs";
import { join, basename, dirname } from "node:path";
import { directoryDigest, listDirectoryFiles } from "@harness/core";
import { FarmOwnerClient } from "@ag-farm/owner-client";
import {
  StudioTtsPayloadSchema,
  StudioRenderPayloadSchema,
  StudioTranscribePayloadSchema,
  TranscribeManifestSchema,
  TtsManifestSchema,
  RenderManifestSchema,
  type JobType,
  type JobResult,
} from "@ag-farm/protocol";
import {
  HarnessError,
  STAGE_CANCELLED,
  type Executor,
  type ExecutorContext,
  type StageRequest,
  type StageResult,
} from "@harness/contracts";

// ---------------------------------------------------------------------------
// Key-layout helpers — single source of truth for executor AND sign endpoint.
// The same logic is inlined in apps/api/src/farm/sign-schemas.ts (CJS); a
// shared test vector in apps/api/src/farm/sign.spec.ts asserts both produce
// identical results.
// ---------------------------------------------------------------------------

/**
 * S3 prefix for stage inputs uploaded by the executor before job submission.
 * Sign endpoint authorises `stage:<filename>` → this prefix + filename.
 */
export function stageInputPrefix(
  productionId: string,
  stageKey: string,
  attemptId: string,
): string {
  return `productions/${productionId}/jobs/${stageKey}/${attemptId}/in/`;
}

/**
 * S3 prefix for one job's output objects (the base path the sign endpoint uses
 * when resolving a `put { output }` relative path). Every job writes under its
 * own prefix, so two jobs of one production can never overwrite each other's
 * `tts.json` / `render.json` (the farm protocol's "output directory of the job").
 */
export function jobOutputPrefix(
  productionId: string,
  stageKey: string,
  attemptId: string,
): string {
  return `productions/${productionId}/jobs/${stageKey}/${attemptId}/out/`;
}

// ---------------------------------------------------------------------------
// Storage facade
// ---------------------------------------------------------------------------

/** Minimal S3-compatible storage facade used by the farm executor.
 *  Production implementations call ag-studio's sign-URL endpoint or use the
 *  S3 client directly for downloads; test stubs use local files. */
export interface StudioStorage {
  /**
   * Upload a local file to the shared store at the given object key.
   * Returns the logical input name the farm worker should use (e.g. `stage:<input.path>`).
   */
  upload(localPath: string, objectKey: string): Promise<string>;
  /**
   * Download a remote object to a local file using a pre-signed URL.
   * Used when a download URL is already known (e.g. from a manifest entry).
   */
  download(url: string, localPath: string): Promise<void>;
  /**
   * Download a completed worker output object by its relative path under the
   * job's output prefix (`jobOutputPrefix`). The implementation resolves the S3
   * key as `<outputPrefix><relPath>` and downloads directly (using the API's own
   * S3 credentials — no ticket required).
   */
  downloadOutput(
    outputPrefix: string,
    relPath: string,
    localPath: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// onSubmitted callback
// ---------------------------------------------------------------------------

export interface SubmittedInfo {
  farmJobId: string;
  runId: string;
  stageKey: string;
  attemptId: string;
  productionId: string;
  jobType: string;
  isFinalRender: boolean;
  /** The ag-farm `requirements` the job was submitted with. */
  requirements?: Record<string, unknown>;
  /** `farmJobFingerprint` of the job: a later attempt that would send the same job takes this one over. */
  fingerprint?: string;
}

/** A farm job an earlier attempt of the stage submitted (Studio: a `studio_farm_jobs` row), newest first. */
export interface EarlierFarmJob {
  farmJobId: string;
  attemptId: string;
  /** `farmJobFingerprint` it was sent with; null for a job recorded before fingerprints were kept. */
  fingerprint: string | null;
}

/**
 * What a farm job does, whatever attempt sends it: its type, requirements, payload (the attempt id, which some
 * builders put in output paths, replaced by a placeholder) and the bytes of every file it reads. Two attempts with
 * the same fingerprint would make the same job, so the later one may take over the earlier one's. Files are hashed
 * as streams: the Studio worker runs every stage in one process, so nothing here may block it.
 */
export async function farmJobFingerprint(p: {
  jobType: string;
  requirements: Record<string, unknown>;
  payload: unknown;
  attemptId: string;
  files: { relPath: string; localPath: string }[];
}): Promise<string> {
  const h = createHash("sha256");
  const payload = JSON.stringify(p.payload ?? null).split(p.attemptId).join("{attempt}");
  h.update(JSON.stringify({ type: p.jobType, requirements: p.requirements, payload }));
  for (const f of [...p.files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    h.update(`\n${f.relPath}\n`);
    for await (const chunk of createReadStream(f.localPath)) h.update(chunk as Buffer);
  }
  return `sha256:${h.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Builds the farm payload of a stage from its inputs at run time (GĐ4): the TTS lines come from
 * `narration.json`, the composition from `timeline.json`, and neither exists when the workflow is written.
 * Selected by `stage_config.payload_builder`; without one the static `stage_config.farm_payload` is used.
 */
export interface FarmPayloadBuild {
  productionId: string;
  payload: unknown;
  /** Extra local files to upload under the attempt's input prefix, referenced as `stage:<relPath>`. */
  extraUploads?: { localPath: string; relPath: string }[];
  /** Downloaded output path (relative to `output/`) -> the stage's declared output name. */
  rename?: Record<string, string>;
  /**
   * Nothing to send (every narration line is already in the voice store, no source has speech…): these files,
   * relative to `output/`, are the stage's outputs and no job is submitted (phase 5).
   */
  skip?: { files: Record<string, string | Buffer> };
}
export type FarmPayloadBuilder = (request: StageRequest, ctx: ExecutorContext) => Promise<FarmPayloadBuild>;

export interface FarmExecutorOptions {
  client: FarmOwnerClient;
  payloadBuilders?: Record<string, FarmPayloadBuilder>;
  storage: StudioStorage;
  /**
   * Called immediately after a farm job is successfully submitted.
   * Must insert a row into `studio_farm_jobs` so that `/farm/sign` can
   * look up the job when the worker calls it.
   */
  onSubmitted?: (info: SubmittedInfo) => Promise<void> | void;
  /** Poll interval in ms (default 5000). */
  pollIntervalMs?: number;
  /**
   * ag-farm `requirements` for this attempt, chosen at run time (the machine type a person picked for a final
   * render). `undefined` leaves `stage_config.requirements`, else `{}` (any node).
   */
  requirementsFor?: (request: StageRequest) => Record<string, unknown> | undefined;
  /**
   * Farm jobs that earlier attempts of this stage submitted (Studio: `studio_farm_jobs`), newest first. An attempt
   * that ends without its executor seeing it out (the worker restarted, the lease expired) leaves its job on the
   * farm. The next attempt takes over the newest one it would send again unchanged (same `farmJobFingerprint`) while
   * that job is still waiting, running or done, so a restart neither loses its place in the farm queue nor renders
   * twice; it cancels every other.
   */
  earlierJobsFor?: (request: StageRequest) => EarlierFarmJob[];
  /**
   * How long a job may sit `queued` (taken by no node) before it is cancelled and the stage fails as a contract
   * failure (not retried: the same job would wait again). The farm never times a queued job out, so without this a
   * job no node fits waits for the whole stage deadline. `undefined`: no limit. A paused job is not counted.
   */
  queueTimeoutMsFor?: (request: StageRequest) => number | undefined;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class FarmExecutor implements Executor {
  readonly version = "0.5.0";

  constructor(private readonly opts: FarmExecutorOptions) {}

  async execute(
    request: StageRequest,
    ctx: ExecutorContext,
  ): Promise<StageResult> {
    const started = Date.now();
    const failed = (
      kind: "transient" | "contract",
      message: string,
      details: Record<string, unknown> = {},
    ): StageResult => ({
      schema_version: "harness.stage-result/v1",
      attempt_id: request.attempt_id,
      outcome: "failed",
      outputs: [],
      checks: [],
      usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: 0 },
      external_operations: [],
      errors: [{ kind, message, details }],
    });

    // -----------------------------------------------------------------------
    // 0. Extract required stage-config fields
    // -----------------------------------------------------------------------
    const cfg = request.stage_config as Record<string, unknown>;
    const jobTypeRaw =
      typeof cfg.job_type === "string" ? cfg.job_type
        : typeof cfg.__farm_job === "string" ? cfg.__farm_job
          : "studio.tts";
    const jobType = jobTypeRaw as JobType;
    const isFinalRender = jobType === "studio.render_final";
    const earlier = this.earlierJobs(request, ctx);

    let build: FarmPayloadBuild | null = null;
    if (typeof cfg.payload_builder === "string") {
      const builder = this.opts.payloadBuilders?.[cfg.payload_builder];
      if (!builder) {
        return failed("contract", `no farm payload builder registered as "${cfg.payload_builder}"`, { payload_builder: cfg.payload_builder });
      }
      try {
        build = await builder(request, ctx);
      } catch (e) {
        return failed("contract", `farm payload builder "${cfg.payload_builder}" failed: ${String(e)}`, { payload_builder: cfg.payload_builder });
      }
      if (build.skip) {
        await this.cancelJobs(earlier.map((j) => j.farmJobId), ctx);
        const outDir = join(ctx.workspaceDir, "output");
        for (const [rel, content] of Object.entries(build.skip.files)) {
          mkdirSync(dirname(join(outDir, rel)), { recursive: true });
          writeFileSync(join(outDir, rel), content);
        }
        ctx.logger.info("nothing to send to the farm: outputs written by the payload builder", { files: Object.keys(build.skip.files) });
        return this.collectOutputs(request, ctx, started, failed);
      }
    }

    const productionId =
      build?.productionId ?? (typeof cfg.production_id === "string" ? cfg.production_id : null);
    if (!productionId) {
      return failed(
        "contract",
        "stage_config.production_id is required for farm executor",
        { stage_config: cfg },
      );
    }

    const uploads = [
      ...request.inputs.filter((i) => i.kind !== "directory").map((i) => ({ localPath: join(ctx.workspaceDir, i.path), relPath: i.path })),
      ...(build?.extraUploads ?? []),
    ];

    // -----------------------------------------------------------------------
    // 1. Validate farm_payload against the protocol schema
    // -----------------------------------------------------------------------
    const rawPayload = build ? build.payload : (cfg.farm_payload ?? {});
    let validatedPayload: unknown;
    try {
      if (
        jobType === "studio.tts"
      ) {
        validatedPayload = StudioTtsPayloadSchema.parse(rawPayload);
      } else if (
        jobType === "studio.render_preview" ||
        jobType === "studio.render_final"
      ) {
        validatedPayload = StudioRenderPayloadSchema.parse(rawPayload);
      } else if (jobType === "studio.transcribe") {
        validatedPayload = StudioTranscribePayloadSchema.parse(rawPayload);
      } else {
        // Unknown job type: pass the payload through without schema validation
        validatedPayload = rawPayload;
      }
    } catch (e) {
      return failed(
        "contract",
        `farm_payload failed schema validation for ${jobType}: ${String(e)}`,
        { job_type: jobType, error: String(e) },
      );
    }

    const requirements = this.opts.requirementsFor?.(request)
      ?? (typeof cfg.requirements === "object" && cfg.requirements !== null ? (cfg.requirements as Record<string, unknown>) : {});
    let fingerprint: string;
    try {
      fingerprint = await farmJobFingerprint({ jobType, requirements, payload: validatedPayload, attemptId: request.attempt_id, files: uploads });
    } catch (e) {
      return failed("transient", `failed to read the inputs of the farm job: ${String(e)}`, { error: String(e) });
    }

    // -----------------------------------------------------------------------
    // 2. Take over the job of an earlier attempt that would be sent again unchanged; cancel the others
    // -----------------------------------------------------------------------
    const adopted = await this.adoptEarlierJob(earlier, fingerprint, ctx);
    let jobId: string;
    /** The attempt whose prefixes the job reads its inputs from and writes its outputs to. */
    let jobAttemptId = request.attempt_id;
    if (adopted) {
      jobId = adopted.farmJobId;
      jobAttemptId = adopted.attemptId;
      ctx.logger.info(`took over farm job ${jobId} of attempt ${jobAttemptId}`, { job_id: jobId, from_attempt: jobAttemptId });
    } else {
      // ---------------------------------------------------------------------
      // 3. Upload input artifacts to the per-attempt input prefix
      // ---------------------------------------------------------------------
      const inputPrefix = stageInputPrefix(productionId, request.stage_key, request.attempt_id);
      for (const up of uploads) {
        // Preserve the full relative path so farm_payload can reference the file
        // by its exact path (e.g. `stage:renders/1/composition.json`).
        // The sign endpoint resolves `stage:<path>` → `${inputPrefix}<path>`.
        const objectKey = inputPrefix + up.relPath;
        try {
          await this.opts.storage.upload(up.localPath, objectKey);
          ctx.logger.info(`uploaded input ${up.relPath} → stage:${up.relPath}`, { object_key: objectKey });
        } catch (e) {
          return failed("transient", `failed to upload input ${up.relPath}: ${String(e)}`, { path: up.relPath });
        }
      }

      // ---------------------------------------------------------------------
      // 4. Submit job (idempotent via correlation_id = attempt_id)
      // ---------------------------------------------------------------------
      try {
        const resp = await this.opts.client.submitJob({
          type: jobType,
          affinity_key: productionId,
          correlation_id: request.attempt_id,
          payload: validatedPayload,
          // One farm-level retry: a worker that dies mid-render (lease expired) is requeued right away on
          // another slot instead of failing the stage and waiting for the stage backoff.
          max_attempts: 2,
          requirements,
        });
        jobId = resp.job.id;
        ctx.logger.info(`farm job submitted id=${jobId} created=${resp.created}`, { job_id: jobId, job_type: jobType, requirements });
      } catch (e) {
        return failed("transient", `failed to submit farm job: ${String(e)}`, { error: String(e) });
      }

      // ---------------------------------------------------------------------
      // 5. Notify recorder so studio_farm_jobs row exists before sign can be called
      // ---------------------------------------------------------------------
      if (this.opts.onSubmitted) {
        try {
          await this.opts.onSubmitted({
            farmJobId: jobId,
            runId: request.run_id,
            stageKey: request.stage_key,
            attemptId: request.attempt_id,
            productionId,
            jobType,
            isFinalRender,
            requirements,
            fingerprint,
          });
        } catch (e) {
          // Recorder failure is fatal: the worker would get 403 on every sign call.
          await this.opts.client.cancelJob(jobId).catch(() => {});
          return failed("contract", `onSubmitted recorder failed: ${String(e)}`, { error: String(e) });
        }
      }
    }

    // -----------------------------------------------------------------------
    // 5. Poll until terminal or deadline
    // -----------------------------------------------------------------------
    const deadlineMs =
      Date.parse(request.limits.deadline_at) - Date.parse(ctx.clock.now());
    const pollMs = this.opts.pollIntervalMs ?? 5000;
    const deadline = Date.now() + Math.max(deadlineMs, 0);

    const queueTimeoutMs = this.opts.queueTimeoutMsFor?.(request);
    let queuedSince = Date.now();
    let jobResult: JobResult | null = null;
    pollLoop: while (Date.now() < deadline) {
      if (ctx.signal?.aborted) {
        // a cancelled run will not read the job; a worker stopping or a lost lease leaves it to the next attempt
        const cancelled = ctx.signal.reason === STAGE_CANCELLED;
        if (cancelled) await this.opts.client.cancelJob(jobId).catch(() => {});
        return failed(
          "transient",
          cancelled ? "stage cancelled while waiting for farm job" : "stage stopped while waiting for farm job; the job stays for the next attempt",
          { job_id: jobId, reason: String(ctx.signal.reason) },
        );
      }
      await delay(pollMs);
      let job;
      try {
        job = await this.opts.client.getJob(jobId);
      } catch (e) {
        ctx.logger.warn(`farm poll error: ${String(e)}`, { job_id: jobId });
        continue;
      }
      ctx.logger.info(`farm job status=${job.status}`, {
        job_id: jobId,
        status: job.status,
        progress: job.progress_percent,
      });
      if (job.status === "completed") {
        jobResult = job.result as JobResult | null;
        break pollLoop;
      }
      if (job.status !== "queued") queuedSince = Date.now();
      else if (queueTimeoutMs !== undefined && Date.now() - queuedSince > queueTimeoutMs) {
        await this.opts.client.cancelJob(jobId).catch(() => {});
        const minutes = Math.round(queueTimeoutMs / 60_000);
        return failed(
          "contract",
          `no farm node took the job in ${minutes} min (requirements ${JSON.stringify(requirements)}): is a fitting machine running?`,
          { job_id: jobId, farm_status: "queued", queue_timeout_ms: queueTimeoutMs, requirements },
        );
      }
      if (job.status === "failed" || job.status === "cancelled") {
        await this.opts.client.ackJob(jobId).catch(() => {});
        return failed(
          "transient",
          `farm job ${job.status}: ${(job.error as { message?: string } | null)?.message ?? "unknown"}`,
          {
            job_id: jobId,
            farm_status: job.status,
            farm_error: job.error,
          },
        );
      }
    }

    if (!jobResult) {
      // Deadline exceeded — cancel the farm job so the worker slot is freed.
      await this.opts.client.cancelJob(jobId).catch(() => {});
      return failed(
        "transient",
        "farm job did not complete before stage deadline",
        { job_id: jobId },
      );
    }

    // -----------------------------------------------------------------------
    // 6. Download outputs to workspace output directory
    // -----------------------------------------------------------------------
    const outDir = join(ctx.workspaceDir, "output");
    mkdirSync(outDir, { recursive: true });

    const outputPrefix = jobOutputPrefix(productionId, request.stage_key, jobAttemptId);
    // a job taken over names its files after the attempt that sent it (render: `final-<attempt>.mp4`)
    const rename = Object.fromEntries(Object.entries(build?.rename ?? {}).map(([from, to]) => [from.split(request.attempt_id).join(jobAttemptId), to]));
    const manifestRelPath = jobResult.manifest;
    if (!manifestRelPath) {
      // No manifest — job produced no output files (unusual but not fatal)
      ctx.logger.warn("farm job completed without a manifest", { job_id: jobId });
    } else {
      // 6a. Download the manifest file
      const manifestLocalPath = join(outDir, basename(manifestRelPath));
      try {
        await this.opts.storage.downloadOutput(
          outputPrefix,
          manifestRelPath,
          manifestLocalPath,
        );
      } catch (e) {
        await this.opts.client.ackJob(jobId).catch(() => {});
        return failed(
          "transient",
          `failed to download manifest ${manifestRelPath}: ${String(e)}`,
          { manifest: manifestRelPath, error: String(e) },
        );
      }

      // 6b. Parse + validate manifest, then download listed output artifacts
      const manifestRaw = JSON.parse(
        readFileSync(manifestLocalPath, "utf8"),
      ) as unknown;

      try {
        if (jobType === "studio.transcribe") {
          // the manifest IS the output (`transcribe.json`): nothing else to download
          TranscribeManifestSchema.parse(manifestRaw);
        } else if (jobType === "studio.tts") {
          const m = TtsManifestSchema.parse(manifestRaw);
          for (const line of m.lines) {
            const dest = join(outDir, line.output);
            mkdirSync(dirname(dest), { recursive: true });
            await this.opts.storage.downloadOutput(
              outputPrefix,
              line.output,
              dest,
            );
            ctx.logger.info(`downloaded tts output ${line.output}`);
          }
        } else if (
          jobType === "studio.render_preview" ||
          jobType === "studio.render_final"
        ) {
          const m = RenderManifestSchema.parse(manifestRaw);
          const videoDest = join(outDir, m.output);
          mkdirSync(dirname(videoDest), { recursive: true });
          await this.opts.storage.downloadOutput(
            outputPrefix,
            m.output,
            videoDest,
          );
          ctx.logger.info(
            `downloaded render output ${m.output} (${m.size_bytes} bytes)`,
          );
          // Download any additional rename-map sources (e.g. thumbnails) that
          // the render worker places alongside the video.
          for (const [from] of Object.entries(rename)) {
            if (from === m.output) continue; // already downloaded
            const dest = join(outDir, from);
            try {
              mkdirSync(dirname(dest), { recursive: true });
              await this.opts.storage.downloadOutput(outputPrefix, from, dest);
              ctx.logger.info(`downloaded rename source ${from}`);
            } catch (e) {
              ctx.logger.warn(`failed to download rename source ${from}: ${String(e)}`);
            }
          }
        }
      } catch (e) {
        // Schema validation of the manifest: fail as contract error (not retryable
        // unless the worker uploads a corrected manifest on retry).
        const isValidation =
          String(e).includes("ZodError") || String(e).includes("invalid_type");
        await this.opts.client.ackJob(jobId).catch(() => {});
        return failed(
          isValidation ? "contract" : "transient",
          `failed to process farm job manifest: ${String(e)}`,
          { manifest: manifestRelPath, error: String(e) },
        );
      }
    }

    // -----------------------------------------------------------------------
    // 7. Ack job
    // -----------------------------------------------------------------------
    try {
      await this.opts.client.ackJob(jobId);
    } catch (e) {
      ctx.logger.warn(
        `failed to ack farm job ${jobId}: ${String(e)}`,
        { job_id: jobId },
      );
    }

    for (const [from, to] of Object.entries(rename)) {
      const src = join(outDir, from);
      if (existsSync(src)) {
        mkdirSync(dirname(join(outDir, to)), { recursive: true });
        copyFileSync(src, join(outDir, to));
      }
    }

    return this.collectOutputs(request, ctx, started, failed);
  }

  /** The farm jobs earlier attempts of this stage submitted; none when they cannot be listed (never fails the stage). */
  private earlierJobs(request: StageRequest, ctx: ExecutorContext): EarlierFarmJob[] {
    if (!this.opts.earlierJobsFor) return [];
    try {
      return this.opts.earlierJobsFor(request);
    } catch (e) {
      ctx.logger.warn(`could not list the farm jobs of earlier attempts: ${String(e)}`, {});
      return [];
    }
  }

  /**
   * The newest earlier job this attempt would send again unchanged, while the farm still has it waiting, running or
   * done; every other earlier job is cancelled. A job the farm answers as failed or cancelled, or does not answer
   * for, is not taken over: this attempt sends its own.
   */
  private async adoptEarlierJob(earlier: EarlierFarmJob[], fingerprint: string, ctx: ExecutorContext): Promise<EarlierFarmJob | null> {
    let adopted: EarlierFarmJob | null = null;
    const cancel: string[] = [];
    for (const job of earlier) {
      if (!adopted && job.fingerprint === fingerprint) {
        const status = await this.opts.client.getJob(job.farmJobId).then((j) => j.status as string, (e: unknown) => {
          ctx.logger.warn(`could not look up farm job ${job.farmJobId} of an earlier attempt: ${String(e)}`, { job_id: job.farmJobId });
          return null;
        });
        if (status !== null && ADOPTABLE.has(status)) { adopted = job; continue; }
        if (status === "failed" || status === "cancelled") continue;
      }
      cancel.push(job.farmJobId);
    }
    await this.cancelJobs(cancel, ctx);
    return adopted;
  }

  /**
   * Cancels jobs earlier attempts of this stage left on the farm. Best effort: the farm answers a job that already
   * ended as it is, and a failed cancel does not stop this attempt.
   */
  private async cancelJobs(ids: string[], ctx: ExecutorContext): Promise<void> {
    for (const id of ids) {
      try {
        await this.opts.client.cancelJob(id);
      } catch (e) {
        ctx.logger.warn(`could not cancel farm job ${id} of an earlier attempt: ${String(e)}`, { job_id: id });
      }
    }
    if (ids.length > 0) ctx.logger.info("cancelled the farm jobs of earlier attempts", { job_ids: ids });
  }

  /** 8. Build the stage result from the workspace output files. */
  private async collectOutputs(
    request: StageRequest,
    ctx: ExecutorContext,
    started: number,
    failed: (kind: "transient" | "contract", message: string, details?: Record<string, unknown>) => StageResult,
  ): Promise<StageResult> {
    const outputs: StageResult["outputs"] = [];
    for (const eo of request.expected_outputs) {
      if (!eo.name) continue;
      const rel = `output/${eo.name}`;
      const abs = join(ctx.workspaceDir, rel);
      if (!existsSync(abs)) {
        if (eo.optional) continue;
        return failed("contract", `farm job output missing: ${eo.name}`, {
          name: eo.name,
        });
      }
      if (eo.kind === "directory") {
        const { checksum, size_bytes } = directoryDigest(await listDirectoryFiles(abs));
        outputs.push({ path: rel, type: eo.type, checksum, size_bytes, kind: "directory" as const });
        continue;
      }
      const bytes = readFileSync(abs);
      const { createHash } = await import("node:crypto");
      const checksum =
        "sha256:" + createHash("sha256").update(bytes).digest("hex");
      outputs.push({
        path: rel,
        type: eo.type,
        checksum,
        size_bytes: bytes.length,
        kind: "file" as const,
      });
    }

    return {
      schema_version: "harness.stage-result/v1",
      attempt_id: request.attempt_id,
      outcome: "succeeded",
      outputs,
      checks: [],
      usage: {
        wall_seconds: (Date.now() - started) / 1000,
        cost_usd: 0,
      },
      external_operations: [],
      errors: [],
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Farm job states an attempt may take over: still waiting, running, or done with outputs to read. */
const ADOPTABLE = new Set(["queued", "paused", "leased", "completed"]);
