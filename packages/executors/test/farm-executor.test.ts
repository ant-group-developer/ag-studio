import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newId, type StageRequest } from "@harness/contracts";
import { FarmExecutor, type StudioStorage } from "../src/farm-executor.js";

const silent = { info() {}, warn() {}, error() {} };
const wall = { now: () => new Date().toISOString() };

/** Owner client + bucket in memory: a submitted job completes on the first poll with the given outputs,
 * written under the job's own output prefix (as Studio's /farm/sign maps a worker's `put`). */
function fakes(outputs: Record<string, string>, manifest: string) {
  const bucket = new Map<string, string>();
  const read: string[] = [];
  const submitted: { type: string; payload: unknown; correlation_id: string }[] = [];
  const acked: string[] = [];
  const client = {
    async submitJob(b: { type: string; payload: unknown; correlation_id: string }) {
      submitted.push(b);
      for (const [k, v] of Object.entries(outputs)) bucket.set(`productions/prod-9/jobs/tts/${b.correlation_id}/out/${k}`, v);
      return { job: { id: "job-1" }, created: true };
    },
    async getJob() { return { status: "completed", result: { manifest } }; },
    async ackJob(id: string) { acked.push(id); },
    async cancelJob() {},
  };
  const storage: StudioStorage = {
    async upload(local, key) { bucket.set(key, readFileSync(local, "utf8")); return `stage:${key}`; },
    async download() { throw new Error("unused"); },
    async downloadOutput(prefix, rel, local) {
      read.push(`${prefix}${rel}`);
      const v = bucket.get(`${prefix}${rel}`);
      if (v === undefined) throw new Error(`missing ${rel}`);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, v);
    },
  };
  return { client, storage, bucket, submitted, acked, read };
}

function request(stage_config: Record<string, unknown>, expected: StageRequest["expected_outputs"]): StageRequest {
  const ws = mkdtempSync(join(tmpdir(), "farm-ex-"));
  mkdirSync(join(ws, "narration"), { recursive: true });
  writeFileSync(join(ws, "narration", "narration.json"), "{}");
  return {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf",
    stage_key: "tts", workflow: { id: "w", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "x", revision: 1 },
    inputs: [{ path: "narration/narration.json", type: "studio_narration", checksum: `sha256:${"0".repeat(64)}`, size_bytes: 2, kind: "file" }],
    workspace_uri: ws, stage_config, options: {}, source_items: [], resources: [], expected_outputs: expected,
    limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 1, max_attempts: 1 }, capabilities: [], fencing_token: 1,
  } as unknown as StageRequest;
}

describe("FarmExecutor with a payload builder (GĐ4)", () => {
  it("builds the payload from inputs, uploads extras, takes the job type from executor.job and collects a directory output", async () => {
    const tts = JSON.stringify({ schema: "ag.studio.tts/v1", production_id: "prod-9", language: "vi", lines: [{ line_id: "L001", output: "tts/L001.wav", duration_s: 1.5, words: [] }], engine: { name: "fake", version: null } });
    const f = fakes({ "tts.json": tts, "tts/L001.wav": "RIFF-fake" }, "tts.json");
    const req = request({ __farm_job: "studio.tts", payload_builder: "tts" }, [
      { type: "tts_manifest", mime_type: "application/json", kind: "file", name: "tts.json" },
      { type: "voice_set", mime_type: "application/x-directory", kind: "directory", name: "tts" },
    ]);
    const extra = join(req.workspace_uri, "extra.txt");
    writeFileSync(extra, "hello");
    const ex = new FarmExecutor({
      client: f.client as never, storage: f.storage, pollIntervalMs: 1,
      payloadBuilders: {
        tts: async () => ({
          productionId: "prod-9",
          payload: { production_id: "prod-9", language: "vi", voice: { reference: null, reference_text: null, speed: 1 }, lines: [{ line_id: "L001", text: "Xin chào", pause_seconds: null }], align_words: false },
          extraUploads: [{ localPath: extra, relPath: "extras/extra.txt" }],
          rename: {},
        }),
      },
    });
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    expect(f.submitted[0]!.type).toBe("studio.tts");
    expect(f.submitted[0]!.correlation_id).toBe(req.attempt_id);
    expect([...f.bucket.keys()]).toEqual(expect.arrayContaining([
      `productions/prod-9/jobs/tts/${req.attempt_id}/in/narration/narration.json`,
      `productions/prod-9/jobs/tts/${req.attempt_id}/in/extras/extra.txt`,
    ]));
    expect(res.outputs.map((o) => [o.path, o.kind])).toEqual([["output/tts.json", "file"], ["output/tts", "directory"]]);
    expect(f.acked).toEqual(["job-1"]);
  });

  it("renames a downloaded render to the stage's declared output name", async () => {
    const manifest = JSON.stringify({ schema: "ag.studio.render/v1", production_id: "prod-9", revision: 3, output: "renders/r3/final.mp4", width: 320, height: 180, duration_s: 4, size_bytes: 9, watermarked: false, sources: [], warnings: [] });
    const f = fakes({ "render.json": manifest, "renders/r3/final.mp4": "mp4-bytes" }, "render.json");
    const req = request({ __farm_job: "studio.render_final", payload_builder: "render" }, [
      { type: "final_video", mime_type: "video/mp4", kind: "file", name: "final.mp4" },
      { type: "render_manifest", mime_type: "application/json", kind: "file", name: "render.json" },
    ]);
    const ex = new FarmExecutor({
      client: f.client as never, storage: f.storage, pollIntervalMs: 1,
      payloadBuilders: {
        render: async () => ({
          productionId: "prod-9",
          payload: { production_id: "prod-9", revision: 3, composition: "stage:composition.json", canvas: { width: 320, height: 180 }, handle_seconds: 0.5, output: "renders/r3/final.mp4" },
          rename: { "renders/r3/final.mp4": "final.mp4" },
        }),
      },
    });
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    expect(f.submitted[0]!.type).toBe("studio.render_final");
    expect(readFileSync(join(req.workspace_uri, "output", "final.mp4"), "utf8")).toBe("mp4-bytes");
  });

  it("an unknown builder or a builder error is a contract failure, before anything is submitted", async () => {
    const f = fakes({}, "x");
    const ex = new FarmExecutor({ client: f.client as never, storage: f.storage, payloadBuilders: { boom: async () => { throw new Error("no narration"); } } });
    for (const name of ["nope", "boom"]) {
      const req = request({ __farm_job: "studio.tts", payload_builder: name }, []);
      const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });
      expect(res.errors[0]!.kind).toBe("contract");
    }
    expect(f.submitted).toHaveLength(0);
  });
});
