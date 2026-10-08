/** StudioAgentExecutor running a files-mode skill (the shot-cut scene selection): session kept, repair resumes it. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type AgentCallTrace, type AgentRuntime, type StageRequest } from "@harness/contracts";
import { StudioAgentExecutor } from "../src/studio-agent-executor.js";

const silent = { info() {}, warn() {}, error() {} };
const wall = { now: () => new Date().toISOString() };
const SRC = "src_0000000000000000000000000A";

const shots = {
  schema_version: "harness.shots/v2",
  sources: [{ source_id: SRC, index: 0, file_name: "a.mp4", duration_seconds: 10, has_audio: false, shots: [{ shot_id: "s000-000", in: 0, out: 4 }, { shot_id: "s000-001", in: 4, out: 10 }] }],
};
const row = (shot_id: string, inS: number, out: number) => ({ source_id: SRC, shot_id, in: inS, out, score: 4, tags: [], usable: true, note: "đẹp", speech: "none" });
const good = { schema_version: "harness.survey-index/v2", shots: [row("s000-000", 0, 4), row("s000-001", 4, 10)] };
const bad = { schema_version: "harness.survey-index/v2", shots: [row("s000-000", 0, 4)] };

function request(): StageRequest {
  const ws = mkdtempSync(join(tmpdir(), "sae-files-"));
  mkdirSync(join(ws, "in", "watch", "sheets"), { recursive: true });
  writeFileSync(join(ws, "in", "shots.json"), JSON.stringify(shots));
  writeFileSync(join(ws, "in", "watch", "watch.json"), "{}");
  return {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"), project_id: "p", portfolio_id: "pf",
    stage_key: "source-survey", workflow: { id: "ag-studio-episode-cut", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }, profile_snapshot: { id: "studio-production", revision: 1 },
    inputs: [
      { path: "in/shots.json", type: "shots", checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "file" },
      { path: "in/watch", type: "watch", checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "directory" },
    ],
    workspace_uri: ws, stage_config: { __skill: "studio-source-survey", __brief: "Chọn cảnh cho tập" }, options: {}, source_items: [], resources: [],
    expected_outputs: [{ type: "survey_index", mime_type: "application/json", kind: "file", name: "survey.json" }],
    limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 1, max_attempts: 1 }, capabilities: [], fencing_token: 1,
  } as unknown as StageRequest;
}

describe("StudioAgentExecutor, files mode", () => {
  it("first call in a new session; a refused file is repaired by resuming it; the last session is kept", async () => {
    const answers = [bad, good];
    const calls: { resume: string | undefined; brief: string }[] = [];
    const sessions: string[] = [];
    const req = request();
    const ex = new StudioAgentExecutor({
      runtimeFor: (_schema, skill, onCall, files) => {
        expect(skill).toBe("studio-source-survey");
        const runtime: AgentRuntime = {
          name: "stub", version: "0",
          async runTask(task) {
            const n = calls.length;
            calls.push({ resume: files?.resume, brief: task.brief });
            mkdirSync(join(task.workspaceDir, "output"), { recursive: true });
            writeFileSync(join(task.workspaceDir, "output", "survey.json"), JSON.stringify(answers[n]));
            onCall?.({ session_id: `sess-${n + 1}`, model: "m", prompt: task.brief, json_schema: null, response: "", structured_output: undefined, exit_code: 0, timed_out: false, rate_limited: false, wall_seconds: 0, cost_usd: 0.1, input_tokens: null, output_tokens: null } as AgentCallTrace);
            return { schema_version: "harness.stage-result/v1", attempt_id: req.attempt_id, outcome: "succeeded", outputs: [{ path: "output/survey.json", type: "survey_index", checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "file" }], checks: [], usage: { wall_seconds: 0, cost_usd: 0.1 }, external_operations: [], errors: [] };
          },
        };
        return runtime;
      },
      onSession: (r, sessionId) => { expect(r.run_id).toBe(req.run_id); sessions.push(sessionId); },
    });
    const res = await ex.execute(req, { workspaceDir: req.workspace_uri, logger: silent, clock: wall });

    expect(res.outcome, JSON.stringify(res.errors)).toBe("succeeded");
    expect(calls.map((c) => c.resume)).toEqual([undefined, "sess-1"]);
    expect(calls[0]!.brief).toContain("Chọn cảnh cho tập");
    expect(calls[0]!.brief).toContain("## Thư mục trong thư mục làm việc");
    expect(calls[0]!.brief).toContain("- watch: in/watch/");
    expect(calls[0]!.brief).toContain("Ghi đúng một tệp `output/survey.json`");
    expect(calls[1]!.brief).not.toContain("# Dữ liệu vào");
    expect(calls[1]!.brief).toContain("[missing_shot]");
    expect(sessions).toEqual(["sess-1", "sess-2"]);
  });
});
