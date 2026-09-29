/**
 * `farm` executor: delegates a stage to ag-farm (OmniWorker cluster). The executor:
 *  1. Signs + uploads the stage's input artifacts to the shared object store.
 *  2. Submits the job to ag-farm with `correlation_id = attempt_id` (idempotent re-submit) and
 *     `affinity_key = production_id` (all jobs for one production land on the same worker node).
 *  3. Polls ag-farm until the job reaches a terminal state; heartbeat on the stage keeps the lease.
 *  4. Downloads the job outputs back to the local artifact store so checkers and downstream stages
 *     can read them exactly like any other stage output.
 *  5. Acks the job (marks it consumed by the owner).
 *
 * The executor does NOT know how to build the job payload — that is the responsibility of the stage
 * config (`stage_config.farm_payload`). The caller assembles and signs input URLs before handing
 * control to this module; `StudioStorage.signUrl` is the interface for that.
 */
import { readFileSync, writeFileSync, mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { FarmOwnerClient } from "@ag-farm/owner-client";
import type { JobType } from "@ag-farm/protocol";
import { HarnessError, type Executor, type ExecutorContext, type StageRequest, type StageResult } from "@harness/contracts";

/** Minimal S3-compatible storage facade used by the farm executor.
 *  Production implementations call ag-studio's sign-URL endpoint (which issues an ag-farm ticket);
 *  test stubs return `data:` or `file:` URLs backed by the local filesystem. */
export interface StudioStorage {
  /** Upload a local file to the shared store; returns the input name the farm worker should use. */
  upload(localPath: string, objectKey: string): Promise<string>;
  /** Download a remote object (by URL returned in job result) to a local file. */
  download(url: string, localPath: string): Promise<void>;
}

export interface FarmExecutorOptions {
  client: FarmOwnerClient;
  storage: StudioStorage;
  /** Base object-store prefix, e.g. `productions/`. Inputs land at `${prefix}<production_id>/jobs/<stage_key>/in/`. */
  storagePrefix?: string;
  /** Poll interval in ms (default 5000). */
  pollIntervalMs?: number;
}

/** Reads a job-result URL list from a completed JobView result field. */
interface FarmJobResult {
  outputs?: Array<{ name: string; url: string }>;
  [key: string]: unknown;
}

export class FarmExecutor implements Executor {
  readonly version = "0.1.0";

  constructor(private readonly opts: FarmExecutorOptions) {}

  async execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> {
    const started = Date.now();
    const failed = (kind: "transient" | "contract", message: string, details: Record<string, unknown> = {}): StageResult => ({
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "failed", outputs: [], checks: [],
      usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: 0 }, external_operations: [], errors: [{ kind, message, details }],
    });

    // Extract production_id from stage_config; required for storage prefix and affinity.
    const cfg = request.stage_config as Record<string, unknown>;
    const productionId = typeof cfg.production_id === "string" ? cfg.production_id : null;
    if (!productionId) return failed("contract", "stage_config.production_id is required for farm executor", { stage_config: cfg });

    const farmPayload = cfg.farm_payload ?? {};
    const prefix = (this.opts.storagePrefix ?? "productions/") + `${productionId}/jobs/${request.stage_key}/in/`;

    // 1. Upload inputs to shared object store.
    const uploadedInputs: Array<{ name: string; input_name: string }> = [];
    for (const input of request.inputs) {
      const objectKey = prefix + input.path.replace(/^.*[/\\]/, ""); // basename
      try {
        const inputName = await this.opts.storage.upload(join(ctx.workspaceDir, input.path), objectKey);
        uploadedInputs.push({ name: input.type, input_name: inputName });
      } catch (e) {
        return failed("transient", `failed to upload input ${input.path}: ${String(e)}`, { path: input.path });
      }
    }

    // 2. Submit job (idempotent via correlation_id = attempt_id).
    let jobId: string;
    try {
      const resp = await this.opts.client.submitJob({
        type: (typeof cfg.job_type === "string" ? cfg.job_type : "studio.tts") as JobType,
        affinity_key: productionId,
        correlation_id: request.attempt_id,
        payload: { ...farmPayload, inputs: uploadedInputs },
        requirements: typeof cfg.requirements === "object" && cfg.requirements !== null ? (cfg.requirements as Record<string, unknown>) : {},
      });
      jobId = resp.job.id;
      ctx.logger.info(`farm job submitted id=${jobId} created=${resp.created}`, { job_id: jobId });
    } catch (e) {
      return failed("transient", `failed to submit farm job: ${String(e)}`, { error: String(e) });
    }

    // 3. Poll until terminal or deadline.
    const deadlineMs = Date.parse(request.limits.deadline_at) - Date.parse(ctx.clock.now());
    const pollMs = this.opts.pollIntervalMs ?? 5000;
    const deadline = Date.now() + deadlineMs;

    let jobResult: FarmJobResult | null = null;
    pollLoop: while (Date.now() < deadline) {
      if (ctx.signal?.aborted) return failed("transient", "stage aborted while waiting for farm job", { job_id: jobId });
      await delay(pollMs);
      let job;
      try { job = await this.opts.client.getJob(jobId); }
      catch (e) { ctx.logger.warn(`farm poll error: ${String(e)}`, { job_id: jobId }); continue; }
      ctx.logger.info(`farm job status=${job.status}`, { job_id: jobId, status: job.status, progress: job.progress_percent });
      if (job.status === "completed") {
        jobResult = (job.result as FarmJobResult | null) ?? {};
        break pollLoop;
      }
      if (job.status === "failed" || job.status === "cancelled") {
        await this.opts.client.ackJob(jobId).catch(() => {});
        return failed("transient", `farm job ${job.status}: ${job.error?.message ?? "unknown"}`, { job_id: jobId, farm_status: job.status, farm_error: job.error });
      }
    }
    if (!jobResult) {
      return failed("transient", "farm job did not complete before stage deadline", { job_id: jobId });
    }

    // 4. Download outputs to workspace output directory.
    const outDir = join(ctx.workspaceDir, "output");
    mkdirSync(outDir, { recursive: true });
    const farmOutputs = Array.isArray(jobResult.outputs) ? jobResult.outputs : [];
    for (const fo of farmOutputs) {
      if (typeof fo.url === "string" && typeof fo.name === "string") {
        const dest = join(outDir, fo.name);
        try { await this.opts.storage.download(fo.url, dest); }
        catch (e) { ctx.logger.warn(`failed to download farm output ${fo.name}: ${String(e)}`, { name: fo.name }); }
      }
    }

    // 5. Ack job.
    try { await this.opts.client.ackJob(jobId); }
    catch (e) { ctx.logger.warn(`failed to ack farm job ${jobId}: ${String(e)}`, { job_id: jobId }); }

    // Build stage outputs from downloaded files.
    const outputs: StageResult["outputs"] = [];
    for (const eo of request.expected_outputs) {
      if (!eo.name) continue;
      const rel = `output/${eo.name}`;
      const abs = join(ctx.workspaceDir, rel);
      try {
        const bytes = readFileSync(abs);
        const { createHash } = await import("node:crypto");
        const checksum = "sha256:" + createHash("sha256").update(bytes).digest("hex");
        outputs.push({ path: rel, type: eo.type, checksum, size_bytes: bytes.length, kind: "file" as const });
      } catch {
        if (!eo.optional) {
          return failed("contract", `farm job output missing: ${eo.name}`, { name: eo.name });
        }
      }
    }

    return {
      schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "succeeded",
      outputs, checks: [], usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: 0 },
      external_operations: [], errors: [],
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
