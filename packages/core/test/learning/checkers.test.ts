import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type Checker, type CheckerInput, type ChannelBrief, type StageRequest, type StageResult, type TopicProposal } from "@harness/contracts";
import { learningCheckers } from "../../src/index.js";
import { openTempStore } from "../helpers.js";
import { T0, makeCommittedPackage } from "./fixtures.js";

const sha = "sha256:" + "a".repeat(64);

function baseRequest(overrides: Partial<StageRequest> = {}): StageRequest {
  return {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
    project_id: "p", portfolio_id: "pf", stage_key: "propose-topics",
    workflow: { id: "channel-planning", version: "1.0.0", digest: sha }, profile_snapshot: { id: "channel-planning", revision: 1 },
    inputs: [], workspace_uri: "", stage_config: {}, options: {}, source_items: [], resources: [], expected_outputs: [],
    policy: {}, limits: { deadline_at: "2026-09-14T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
    ...overrides,
  };
}

function baseResult(outputs: StageResult["outputs"]): StageResult {
  return {
    schema_version: "harness.stage-result/v1", attempt_id: newId("attempt"), outcome: "succeeded", outputs,
    checks: [], usage: { wall_seconds: 1, cost_usd: 0 }, external_operations: [], errors: [],
  };
}

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "learning-checkers-ws-"));
}

function sampleTopics(topics: string[]): TopicProposal {
  return {
    schema_version: "harness.topic-proposal/v1",
    topics: topics.map((topic) => ({ topic, angle: "curiosity", why: "there is real search demand for this." })),
  };
}

function sampleBrief(o: { open_requests?: ChannelBrief["open_requests"] } = {}): ChannelBrief {
  return {
    schema_version: "harness.channel-brief/v1", generated_at: T0,
    channel: {
      channel_id: "channel-a", display_name: "Channel A",
      seo: { niche: "", audience: "", angle: "", language: "en", market: "", keywords: [], title_rules: "", description_template: "" },
      publication: { timezone: "America/New_York", publish_times: ["13:00"] },
    },
    learned: null, hypotheses: [], recent_metrics: [], open_requests: o.open_requests ?? [], item: null,
  };
}

function checkerById(checkers: Checker[], id: string): Checker {
  const c = checkers.find((c) => c.id === id);
  if (!c) throw new Error(`no checker ${id}`);
  return c;
}

describe("learningCheckers", () => {
  describe("topics-valid", () => {
    it("passes distinct topics with no channel_brief input (schema-only)", async () => {
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"), { recursive: true });
      writeFileSync(join(ws, "output", "topics.json"), JSON.stringify(sampleTopics(["A brand new topic idea", "Another fresh one entirely"])));
      const request = baseRequest();
      const result = baseResult([{ path: "output/topics.json", type: "topic_proposal", checksum: sha, size_bytes: 1, kind: "file" }]);

      const checker = checkerById(learningCheckers({ store: openTempStore().store }), "topics-valid");
      expect(await checker.check({ request, result, workspaceDir: ws } satisfies CheckerInput)).toEqual({ verdict: "pass", evidence: {} });
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails a schema-invalid topic proposal", async () => {
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"), { recursive: true });
      writeFileSync(join(ws, "output", "topics.json"), JSON.stringify({ schema_version: "harness.topic-proposal/v1", topics: [] }));
      const request = baseRequest();
      const result = baseResult([{ path: "output/topics.json", type: "topic_proposal", checksum: sha, size_bytes: 1, kind: "file" }]);

      const checker = checkerById(learningCheckers({ store: openTempStore().store }), "topics-valid");
      const verdict = await checker.check({ request, result, workspaceDir: ws } satisfies CheckerInput);
      expect(verdict.verdict).toBe("fail");
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails a topic that duplicates an open request's topic in channel-brief.json", async () => {
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"), { recursive: true });
      writeFileSync(join(ws, "output", "topics.json"), JSON.stringify(sampleTopics(["  Ancient  Roman  Roads  "])));
      const brief = sampleBrief({ open_requests: [{ request_id: newId("content_request"), topic: "ancient roman roads", status: "open" }] });
      writeFileSync(join(ws, "channel-brief.json"), JSON.stringify(brief));
      const request = baseRequest({
        inputs: [{ artifact_id: newId("artifact"), checksum: sha, path: "channel-brief.json", type: "channel_brief", kind: "file" }],
      });
      const result = baseResult([{ path: "output/topics.json", type: "topic_proposal", checksum: sha, size_bytes: 1, kind: "file" }]);

      const checker = checkerById(learningCheckers({ store: openTempStore().store }), "topics-valid");
      const verdict = await checker.check({ request, result, workspaceDir: ws } satisfies CheckerInput);
      expect(verdict.verdict).toBe("fail");
      expect(verdict.evidence.duplicates).toEqual(["  Ancient  Roman  Roads  "]);
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails a topic that duplicates one of the channel's 20 newest committed package titles", async () => {
      const ws = tmpWorkspace();
      const { store } = openTempStore();
      store.insertChannelPackage(makeCommittedPackage({ episode_no: 1 })); // metadata.title: "Episode 1"

      mkdirSync(join(ws, "output"), { recursive: true });
      writeFileSync(join(ws, "output", "topics.json"), JSON.stringify(sampleTopics(["episode 1"])));
      writeFileSync(join(ws, "channel-brief.json"), JSON.stringify(sampleBrief()));
      const request = baseRequest({
        inputs: [{ artifact_id: newId("artifact"), checksum: sha, path: "channel-brief.json", type: "channel_brief", kind: "file" }],
      });
      const result = baseResult([{ path: "output/topics.json", type: "topic_proposal", checksum: sha, size_bytes: 1, kind: "file" }]);

      const checker = checkerById(learningCheckers({ store }), "topics-valid");
      const verdict = await checker.check({ request, result, workspaceDir: ws } satisfies CheckerInput);
      expect(verdict.verdict).toBe("fail");
      expect(verdict.evidence.duplicates).toEqual(["episode 1"]);
      rmSync(ws, { recursive: true, force: true });
    });

    it("skips when there is no topic_proposal output", async () => {
      const ws = tmpWorkspace();
      const request = baseRequest();
      const result = baseResult([]);
      const checker = checkerById(learningCheckers({ store: openTempStore().store }), "topics-valid");
      expect(await checker.check({ request, result, workspaceDir: ws } satisfies CheckerInput)).toEqual({ verdict: "skip", evidence: { reason: "no matching output" } });
    });
  });
});
