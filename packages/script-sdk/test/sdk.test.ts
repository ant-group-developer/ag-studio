import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../src/index.js";

const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "sdk-"));
  mkdirSync(join(ws, "input", "artifact_1"), { recursive: true }); mkdirSync(join(ws, "output"));
  writeFileSync(join(ws, "input", "artifact_1", "narration.txt"), "hello");
  writeFileSync(join(ws, "stage-request.json"), JSON.stringify({
    schema_version: "harness.stage-request/v1", run_id: "run_1", stage_run_id: "stage_1", attempt_id: "attempt_1", project_id: "p", portfolio_id: "pf", stage_key: "tts",
    workflow: { id: "w", version: "1.0.0", digest: sha("w") }, profile_snapshot: { id: "footage", revision: 1 },
    inputs: [{ artifact_id: "artifact_1", checksum: sha("hello"), path: "input/artifact_1/narration.txt", type: "narration", kind: "file" }],
    workspace_uri: ws, stage_config: {}, options: { voice: "tts" }, source_items: [{ source_id: "src_1", uri: "file:///x.mp4", checksum: sha("x"), mime_type: "video/mp4", duration_seconds: 5 }],
    resources: ["gpu"], expected_outputs: [{ type: "voice_track", mime_type: "audio/wav", kind: "file", name: "narration.wav" }], policy: {},
    limits: { deadline_at: "2026-09-13T00:00:00.000Z", max_cost_usd: 1, max_attempts: 1 }, capabilities: [], fencing_token: 1,
  }));
  return ws;
}
const captured: string[] = [];
const io = { stdout: (line: string) => { captured.push(line); }, exit: (_code: number) => {} };

describe("script-sdk", () => {
  it("reads the request from HARNESS_WORKSPACE, resolves inputs by type or path, exposes sources and resources", async () => {
    const ws = workspace();
    const ctx = await start({ env: { HARNESS_WORKSPACE: ws }, io });
    expect(ctx.request.stage_key).toBe("tts");
    expect(ctx.input("narration")).toBe(join(ws, "input", "artifact_1", "narration.txt"));
    expect(ctx.input("narration.txt")).toBe(join(ws, "input", "artifact_1", "narration.txt"));
    expect(() => ctx.input("missing")).toThrow(/no input/);
    expect(ctx.source(0).source_id).toBe("src_1");
    expect(ctx.hasResource("gpu")).toBe(true);
    expect(ctx.options.voice).toBe("tts");
  });
  it("declares file and directory outputs with checksums matching the harness algorithm, then writes stage-result.json", async () => {
    const ws = workspace();
    const ctx = await start({ env: { HARNESS_WORKSPACE: ws }, io });
    writeFileSync(join(ws, "output", "narration.wav"), "RIFF");
    mkdirSync(join(ws, "output", "cuts")); writeFileSync(join(ws, "output", "cuts", "001.mp4"), "a"); writeFileSync(join(ws, "output", "cuts", "002.mp4"), "bb");
    await ctx.out.file("output/narration.wav", { type: "voice_track" });
    await ctx.out.dir("output/cuts", { type: "clip_set" });
    ctx.heartbeat({ percent: 50 });
    ctx.log.info("rendered", { n: 2 });
    await ctx.done({ cost_usd: 0.25 });
    const result = JSON.parse(readFileSync(join(ws, "stage-result.json"), "utf8"));
    expect(result).toMatchObject({ schema_version: "harness.stage-result/v1", attempt_id: "attempt_1", outcome: "succeeded", usage: { cost_usd: 0.25 } });
    expect(result.outputs[0]).toEqual({ path: "output/narration.wav", type: "voice_track", checksum: sha("RIFF"), size_bytes: 4, kind: "file" });
    const listing = [{ checksum: sha("a"), path: "001.mp4", size_bytes: 1 }, { checksum: sha("bb"), path: "002.mp4", size_bytes: 2 }];
    expect(result.outputs[1]).toEqual({ path: "output/cuts", type: "clip_set", checksum: sha(JSON.stringify(listing)), size_bytes: 3, kind: "directory" });
    expect(JSON.parse(readFileSync(join(ws, "progress.json"), "utf8"))).toMatchObject({ percent: 50 });
    expect(JSON.parse(captured.at(-1)!)).toMatchObject({ level: "info", msg: "rendered", n: 2 });
  });
  it("fail() and unknown() write failed/unknown results and out.clear() empties output/", async () => {
    const ws = workspace();
    const ctx = await start({ env: { HARNESS_WORKSPACE: ws }, io });
    writeFileSync(join(ws, "output", "junk"), "x");
    ctx.out.clear();
    expect(readFileSync(join(ws, "stage-request.json"), "utf8")).toContain("tts");
    await ctx.fail("transient", "gpu busy", { code: 503 });
    expect(JSON.parse(readFileSync(join(ws, "stage-result.json"), "utf8"))).toMatchObject({ outcome: "failed", errors: [{ kind: "transient", message: "gpu busy", details: { code: 503 } }] });
    await ctx.unknown("lost after dispatch", ["op_1"]);
    expect(JSON.parse(readFileSync(join(ws, "stage-result.json"), "utf8"))).toMatchObject({ outcome: "unknown", external_operations: ["op_1"] });
  });
});
