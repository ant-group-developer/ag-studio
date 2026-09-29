import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { directoryDigest, listDirectoryFiles } from "@harness/core";
import { HarnessError, type Executor, type ExecutorContext, type StageRequest, type StageResult } from "@harness/contracts";

/**
 * A stage implemented as a function of this process (Studio's `intake`, `catalog`, `build-timeline`,
 * `export`): it writes its declared outputs under `output/` and throws on failure. Throw `HarnessError`
 * with a contract-class code (`CONFIG_INVALID`, `NOT_FOUND`, `SCHEMA_INVALID`) when retrying cannot help.
 */
export type InProcessStage = (request: StageRequest, ctx: ExecutorContext) => Promise<void>;

const CONTRACT_CODES = new Set(["CONFIG_INVALID", "NOT_FOUND", "SCHEMA_INVALID", "SECRET_UNRESOLVED"]);

/** Registered as the `script` executor: runs `stage_config.__script` from `stages`, else delegates to `fallback`. */
export class InProcessExecutor implements Executor {
  readonly version = "in-process-executor@1.0.0";
  constructor(private readonly stages: Record<string, InProcessStage>, private readonly fallback?: Executor) {}

  async execute(request: StageRequest, ctx: ExecutorContext): Promise<StageResult> {
    const name = String(request.stage_config.__script ?? "");
    const stage = this.stages[name];
    if (!stage) {
      if (this.fallback) return this.fallback.execute(request, ctx);
      throw new HarnessError("NOT_FOUND", `no in-process stage registered for "${name}"`, { script: name });
    }
    const started = Date.now();
    const base = { schema_version: "harness.stage-result/v1" as const, attempt_id: request.attempt_id, checks: [], external_operations: [] };
    try {
      await stage(request, ctx);
    } catch (e) {
      const code = e instanceof HarnessError ? e.code : undefined;
      const kind = code && CONTRACT_CODES.has(code) ? "contract" : "transient";
      ctx.logger.error(`stage ${name} failed`, { error: e instanceof Error ? e.message : String(e), code: code ?? null });
      return { ...base, outcome: "failed", outputs: [], usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: 0 },
        errors: [{ kind, message: e instanceof Error ? e.message : String(e), details: e instanceof HarnessError ? { code: e.code, ...e.details } : {} }] };
    }
    const outputs: StageResult["outputs"] = [];
    for (const eo of request.expected_outputs) {
      if (!eo.name) continue;
      const rel = `output/${eo.name}`;
      const abs = join(ctx.workspaceDir, rel);
      if (!existsSync(abs)) {
        if (eo.optional) continue;
        return { ...base, outcome: "failed", outputs: [], usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: 0 },
          errors: [{ kind: "contract", message: `stage ${name} wrote no ${rel}`, details: { name: eo.name } }] };
      }
      if (statSync(abs).isDirectory()) {
        outputs.push({ path: rel, type: eo.type, ...directoryDigest(await listDirectoryFiles(abs)), kind: "directory" });
      } else {
        const bytes = readFileSync(abs);
        outputs.push({ path: rel, type: eo.type, checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size_bytes: bytes.length, kind: "file" });
      }
    }
    return { ...base, outcome: "succeeded", outputs, usage: { wall_seconds: (Date.now() - started) / 1000, cost_usd: 0 }, errors: [] };
  }
}
