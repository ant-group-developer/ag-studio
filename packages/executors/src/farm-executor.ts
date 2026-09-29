/**
 * `farm` executor: delegates a stage to ag-farm (OmniWorker cluster). The executor:
 *  1. Uploads stage input artifacts to the production's object store under a deterministic
 *     per-attempt prefix (`productions/<prodId>/jobs/<stageKey>/<attemptId>/in/<input.path>`).
 *     The full relative path is preserved so farm_payload can reference inputs as
 *     `stage:<input.path>` (e.g. `stage:renders/1/composition.json`). The farm sign_url
 *     endpoint resolves `stage:<path>` → `${inputPrefix}<path>`.
 *  2. Submits the job to ag-farm using `stage_config.farm_payload` directly — the payload must
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
 *  6. Cancels the farm job when the stage deadline is exceeded or the stage is aborted.
 *  7. Acks the job (marks it consumed by the owner).
 */
import { readFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { directoryDigest, listDirectoryFiles } from "@harness/core";
import { FarmOwnerClient } from "@ag-farm/owner-client";
import {
  StudioTtsPayloadSchema,
  StudioRenderPayloadSchema,
  TtsManifestSchema,
  RenderManifestSchema,
  type JobType,
  type JobResult,
} from "@ag-farm/protocol";
import {
  HarnessError,
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
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class FarmExecutor implements Executor {
  readonly version = "0.3.0";

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

    // -----------------------------------------------------------------------
    // 1. Upload input artifacts to the per-attempt input prefix
    // -----------------------------------------------------------------------
    const inputPrefix = stageInputPrefix(
      productionId,
      request.stage_key,
      request.attempt_id,
    );
    const uploads = [
      ...request.inputs.filter((i) => i.kind !== "directory").map((i) => ({ localPath: join(ctx.workspaceDir, i.path), relPath: i.path })),
      ...(build?.extraUploads ?? []),
    ];
    for (const up of uploads) {
      // Preserve the full relative path so farm_payload can reference the file
      // by its exact path (e.g. `stage:renders/1/composition.json`).
      // The sign endpoint resolves `stage:<path>` → `${inputPrefix}<path>`.
      const objectKey = inputPrefix + up.relPath;
      try {
        await this.opts.storage.upload(up.localPath, objectKey);
        ctx.logger.info(
          `uploaded input ${up.relPath} → stage:${up.relPath}`,
          { object_key: objectKey },
        );
      } catch (e) {
        return failed(
          "transient",
          `failed to upload input ${up.relPath}: ${String(e)}`,
          { path: up.relPath },
        );
      }
    }

    // -----------------------------------------------------------------------
    // 2. Validate farm_payload against the protocol schema
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

    // -----------------------------------------------------------------------
    // 3. Submit job (idempotent via correlation_id = attempt_id)
    // -----------------------------------------------------------------------
    let jobId: string;
    try {
      const resp = await this.opts.client.submitJob({
        type: jobType,
        affinity_key: productionId,
        correlation_id: request.attempt_id,
        payload: validatedPayload,
        max_attempts: 1, // the harness handles retries at the stage level
        requirements:
          typeof cfg.requirements === "object" && cfg.requirements !== null
            ? (cfg.requirements as Record<string, unknown>)
            : {},
      });
      jobId = resp.job.id;
      ctx.logger.info(
        `farm job submitted id=${jobId} created=${resp.created}`,
        { job_id: jobId, job_type: jobType },
      );
    } catch (e) {
      return failed("transient", `failed to submit farm job: ${String(e)}`, {
        error: String(e),
      });
    }

    // -----------------------------------------------------------------------
    // 4. Notify recorder so studio_farm_jobs row exists before sign can be called
    // -----------------------------------------------------------------------
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
        });
      } catch (e) {
        // Recorder failure is fatal: the worker would get 403 on every sign call.
        await this.opts.client.cancelJob(jobId).catch(() => {});
        return failed(
          "contract",
          `onSubmitted recorder failed: ${String(e)}`,
          { error: String(e) },
        );
      }
    }

    // -----------------------------------------------------------------------
    // 5. Poll until terminal or deadline
    // -----------------------------------------------------------------------
    const deadlineMs =
      Date.parse(request.limits.deadline_at) - Date.parse(ctx.clock.now());
    const pollMs = this.opts.pollIntervalMs ?? 5000;
    const deadline = Date.now() + Math.max(deadlineMs, 0);

    let jobResult: JobResult | null = null;
    pollLoop: while (Date.now() < deadline) {
      if (ctx.signal?.aborted) {
        await this.opts.client.cancelJob(jobId).catch(() => {});
        return failed(
          "transient",
          "stage aborted while waiting for farm job",
          { job_id: jobId },
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

    const outputPrefix = jobOutputPrefix(productionId, request.stage_key, request.attempt_id);
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
        if (jobType === "studio.tts") {
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

    for (const [from, to] of Object.entries(build?.rename ?? {})) {
      const src = join(outDir, from);
      if (existsSync(src)) {
        mkdirSync(dirname(join(outDir, to)), { recursive: true });
        copyFileSync(src, join(outDir, to));
      }
    }

    // -----------------------------------------------------------------------
    // 8. Build stage result from workspace output files
    // -----------------------------------------------------------------------
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
