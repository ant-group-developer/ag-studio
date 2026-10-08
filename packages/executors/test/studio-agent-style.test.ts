/** The style step of plan 3.2.0: files mode through the real runtime and the fake Claude CLI. */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newId, StudioStyleSchema, type StageRequest, type StyleWatch } from "@harness/contracts";
import { CliAgentRuntime } from "@harness/adapter-agent-cli";
import { STUDIO_TYPES } from "@harness/core";
import { StudioAgentExecutor, type StudioLlmCall } from "../src/studio-agent-executor.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const FAKE = join(ROOT, "fixtures", "fake-studio-claude.mjs");
const silent = { info() {}, warn() {}, error() {} };
const wall = { now: () => new Date().toISOString() };

const measured = { videos: 1, shots: 5, cuts_per_minute: 24, shot_seconds: { p25: 2, median: 2, p75: 2 }, first_shot_s: 2 };
const watched: StyleWatch = {
  schema_version: "studio.style-watch/v1", production_id: "prod-1", skipped_reason: null, measured,
  videos: [
    { label: "R1", video_id: "U_17EqTHUIo", title: "Kyoto", duration_s: 10, error: null, measured, cuts: [2, 4, 6, 8],
      frames: [0.5, 2.2, 4.2, 6.2].map((t) => ({ t, file: `R1/f-${t.toFixed(3)}.jpg`, kind: "scene" as const, key: `k/${t}` })), sheets: [{ file: "R1/sheet-01.jpg", frames: [0.5, 2.2, 4.2, 6.2] }] },
    { label: "R2", video_id: "ERRgone0000", title: "x", duration_s: null, error: "Video unavailable", measured: null, cuts: [], frames: [], sheets: [] },
  ],
};
const refs = { schema_version: "studio.style-refs/v1", production_id: "prod-1", target_seconds: 600, skipped_reason: null,
  picks: [{ video_id: "U_17EqTHUIo", url: "https://www.youtube.com/watch?v=U_17EqTHUIo", channel_id: "UCmei", channel_title: "Mei Time", title: "Kyoto in the rain", duration_s: 1299, views: 1, views_per_day: 1, published_at: "2026-06-01T00:00:00Z", reason: "" }] };

function stage(watch: StyleWatch, mode = "", recordCall?: (c: StudioLlmCall) => Promise<void>) {
  const ws = mkdtempSync(join(tmpdir(), "style-"));
  mkdirSync(join(ws, "in", "style-watch"), { recursive: true });
  writeFileSync(join(ws, "in", "references.json"), JSON.stringify(refs));
  writeFileSync(join(ws, "in", "style-watch", "watch.json"), JSON.stringify(watch));
  const req = {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf",
    stage_key: "analyze-style", workflow: { id: "ag-studio-series-plan", version: "3.2.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "studio-production", revision: 1 },
    inputs: [
      { path: "in/references.json", type: STUDIO_TYPES.styleRefs, checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "file" },
      { path: "in/style-watch", type: STUDIO_TYPES.styleWatch, checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "directory" },
    ],
    workspace_uri: ws, stage_config: { __skill: "studio-style", __brief: "Học phong cách dựng" }, options: {}, source_items: [], resources: [],
    expected_outputs: [{ type: STUDIO_TYPES.style, mime_type: "application/json", kind: "file", name: "style.json" }],
    limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 2 }, capabilities: [], fencing_token: 1,
  } as unknown as StageRequest;
  const sessions: string[] = [];
  const ex = new StudioAgentExecutor({
    runtimeFor: (_schema, _skill, onCall, files) => new CliAgentRuntime({
      runtime: "claude", skillsDir: join(ROOT, "skills"), argv: [process.execPath, FAKE],
      files: { model: "m", maxTurns: 10, tools: ["Read", "Write", "Glob", "Grep"], ...(files?.resume ? { resume: files.resume } : {}) },
      baseEnv: { ...process.env, FAKE_STUDIO_MODE: mode }, ...(onCall ? { onCall } : {}),
    }),
    onSession: (_r, id) => { sessions.push(id); },
    ...(recordCall ? { recordCall } : {}),
  });
  return { req, ex, ws, sessions };
}
const run = (s: ReturnType<typeof stage>) => s.ex.execute(s.req, { workspaceDir: s.ws, logger: silent, clock: wall });
const out = (s: ReturnType<typeof stage>) => StudioStyleSchema.parse(JSON.parse(readFileSync(join(s.ws, "output", "style.json"), "utf8")));

describe("studio-style", () => {
  it("reads the frames and numbers watched and writes the style, backed by them", async () => {
    const s = stage(watched);
    const res = await run(s);
    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    const style = out(s);
    expect(style.measured).toEqual(measured);
    expect(style.references.map((r) => r.video_id)).toEqual(["U_17EqTHUIo"]);
    expect(style.references[0]!.title).toBe("Kyoto in the rain");
    expect(style.params?.cut_rhythm).toBe("fast");
    expect(s.sessions).toHaveLength(1);
  });

  it("a misquoted measurement goes back once, in the same session", async () => {
    const s = stage(watched, "style-bad-once");
    const res = await run(s);
    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    expect(out(s).measured?.shot_seconds.median).toBe(2);
    expect(s.sessions).toHaveLength(2);
    expect(readFileSync(join(s.ws, "logs", "fake-claude-prompts.log"), "utf8")).toContain("measured_differs");
  });

  it("nothing watched: a skipped style saying why, without calling Claude", async () => {
    const calls: StudioLlmCall[] = [];
    const s = stage({ ...watched, measured: null, skipped_reason: "Máy chạy Studio không có yt-dlp để tải video mẫu", videos: [] }, "", async (c) => { calls.push(c); });
    expect((await run(s)).outcome).toBe("succeeded");
    expect(out(s)).toMatchObject({ skipped: true, skipped_reason: "Máy chạy Studio không có yt-dlp để tải video mẫu", params: null });
    expect(calls).toHaveLength(0);
  });
});
