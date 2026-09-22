import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { newId, type ClaimResult, type Run, type StageRun, type RetryPolicy } from "@harness/contracts";
import { FixedClock, MIGRATIONS_DIR, SqliteStateStore } from "../src/index.js";

export function openTempStore(startIso = "2026-09-11T00:00:00.000Z") {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  const clock = new FixedClock(startIso);
  const store = new SqliteStateStore(join(dir, "state.db"), clock);
  store.migrate(MIGRATIONS_DIR);
  return { store, dir, clock };
}

export function beginAttempt(store: SqliteStateStore, c: ClaimResult) {
  const ev = { run_id: c.stageRun.run_id, stage_run_id: c.stageRun.stage_run_id, attempt_id: c.attempt.attempt_id, project_id: "project-main", portfolio_id: null, channel_id: null, content_id: null, variant_id: null, workflow_release: null, severity: "info" as const, event_type: "attempt.started", payload: {} };
  store.transaction(() => {
    store.transition("attempt", c.attempt.attempt_id, "CLAIMED", "RUNNING", ev);
    store.transition("stage_run", c.stageRun.stage_run_id, "CLAIMED", "RUNNING", ev);
  });
  return { stageRun: store.getStageRun(c.stageRun.stage_run_id)!, attempt: store.getAttempt(c.attempt.attempt_id)! };
}

const SHA = "sha256:" + "a".repeat(64);
export function seedStage(store: SqliteStateStore, opts: { key?: string; caps?: string[]; retry?: Partial<RetryPolicy>; runId?: string; depends_on?: string[]; state?: StageRun["state"]; requires_resources?: string[] } = {}) {
  const now = store.clock.now();
  const runId = opts.runId ?? newId("run");
  if (!opts.runId) {
    const run: Run = {
      schema_version: "harness.run/v1", run_id: runId, project_id: "project-main", portfolio_id: "portfolio-main",
      workflow_release: { id: "sample-three-stage", version: "1.0.0", digest: SHA }, profile_snapshot: { id: "cartoon", revision: 1 },
      options: {}, state: "READY", effective_config_snapshot: {}, effective_config_digest: SHA, total_cost_usd: 0, created_at: now, updated_at: now,
    };
    store.insertRun(run);
  }
  const stage: StageRun = {
    schema_version: "harness.stage-run/v1", stage_run_id: newId("stage_run"), run_id: runId, stage_key: opts.key ?? "produce",
    executor: { type: "script", script: "fake-stage" }, depends_on: opts.depends_on ?? [], depends_on_optional: [], requires_resources: opts.requires_resources ?? [], required_capabilities: opts.caps ?? [],
    required_checks: ["schema-valid"], retry: { max_attempts: 3, backoff_seconds: [0, 0, 0], retry_on: ["transient", "abandoned"], ...opts.retry },
    stage_config: {}, state: opts.state ?? "READY", attempt_count: 0, result_failures: 0, ready_at: now, created_at: now, updated_at: now,
  };
  store.insertStageRun(stage);
  return { runId, stage };
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Writes a small solid-color, uncompressed-filter-friendly, valid 8-bit RGB PNG -- no image library, just
 * IHDR + one IDAT (zlib-deflated raw scanlines) + IEND. Used by brand tests standing in for a channel's logo. */
export function makeTinyPng(path: string, size = 8): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const rowSize = size * 3 + 1;
  const raw = Buffer.alloc(rowSize * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowSize] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const off = y * rowSize + 1 + x * 3;
      raw[off] = 242;
      raw[off + 1] = 201;
      raw[off + 2] = 76;
    }
  }

  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}
