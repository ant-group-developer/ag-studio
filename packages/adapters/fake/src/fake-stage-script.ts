import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StageRequestSchema, type StageResult } from "@harness/contracts";

const ws = process.cwd();
const request = StageRequestSchema.parse(JSON.parse(readFileSync(join(ws, "stage-request.json"), "utf8")));
const cfg = request.stage_config as { fail_transient_times?: number; write_bad_checksum?: boolean; sleep_ms?: number; content?: string };

if (cfg.sleep_ms) { const end = Date.now() + cfg.sleep_ms; while (Date.now() < end) { /* busy wait keeps the script simple */ } }

// transient failures counted per stage across attempts: counter lives in the parent (stage) directory
const counterPath = join(dirname(ws), "fake-fail-count.json");
const failures = existsSync(counterPath) ? (JSON.parse(readFileSync(counterPath, "utf8")) as { n: number }).n : 0;
if ((cfg.fail_transient_times ?? 0) > failures) {
  writeFileSync(counterPath, JSON.stringify({ n: failures + 1 }));
  console.error(`fake-stage: simulated transient failure ${failures + 1}/${cfg.fail_transient_times}`);
  process.exit(1);
}

const inputSummary = request.inputs.map((i) => `${i.type}:${readFileSync(join(ws, i.path), "utf8").length}`).join(",");
// An explicit content override is written verbatim; otherwise fall back to a synthetic default that
// carries debug context (stage key + input summary) for runs that don't care about exact content.
const content = cfg.content ?? `fake output [stage=${request.stage_key} inputs=${inputSummary}]`;
mkdirSync(join(ws, "output"), { recursive: true });
writeFileSync(join(ws, "output", "result.txt"), content);
const checksum = cfg.write_bad_checksum ? "sha256:" + "0".repeat(64) : `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
const outputType = (request.stage_config.output_type as string | undefined) ?? (request.stage_key === "finalize" ? "final_text" : "script_text");

const result: StageResult = {
  schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outcome: "succeeded",
  outputs: [{ path: "output/result.txt", type: outputType, checksum, size_bytes: Buffer.byteLength(content, "utf8") }],
  checks: [], usage: { wall_seconds: (cfg.sleep_ms ?? 0) / 1000, cost_usd: 0.01 }, external_operations: [], errors: [],
};
writeFileSync(join(ws, "stage-result.json"), JSON.stringify(result, null, 2));
