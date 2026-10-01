import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import type { StudioLlmCall } from "@harness/executors";
import {
  canonicalJson, exportLlmDataset, latestAcceptedCall, listHumanEdits, listLlmCalls, MemoryBucket, promptMessages,
  readLlmCallPayload, recordHumanEdit, recordLlmCall, type StudioDb,
} from "../src/index.js";
import { seedProduction, world } from "./helpers.js";

const plan = { schema_version: "studio.series-plan/v1", episodes: [{ idx: 1, title: "Tập 1", items: [{ asset_id: "a01" }] }] };

function call(over: Partial<StudioLlmCall> = {}): StudioLlmCall {
  return {
    run_id: "run-plan", stage_key: "plan-episodes", attempt_id: "attempt-1", skill: "studio-plan-episodes", round: 0,
    outcome: "accepted", problems: [], warnings: [],
    trace: {
      model: "claude-opus-5-5", prompt: "# Skill\nLập kế hoạch tập.\n\n# Brief\nChạy studio-plan-episodes\n", json_schema: "{}",
      response: JSON.stringify({ structured_output: plan, total_cost_usd: 0.42 }), structured_output: plan,
      exit_code: 0, timed_out: false, rate_limited: false, wall_seconds: 12.5, cost_usd: 0.42, input_tokens: 1200, output_tokens: 300,
    },
    ...over,
  };
}

function seed(): { db: StudioDb; bucket: MemoryBucket; prod: string } {
  const { db, bucket } = world();
  const prod = seedProduction(db);
  const now = new Date().toISOString();
  db.run("UPDATE productions SET run_id = 'run-plan' WHERE id = ?", [prod]);
  db.run("INSERT INTO episodes (id, production_id, idx, title, hook, run_id, plan, created_at, updated_at) VALUES ('ep-1', ?, 1, 'Tập 1', 'Mở đầu', 'run-ep1', ?, ?, ?)",
    [prod, JSON.stringify(plan.episodes[0]), now, now]);
  return { db, bucket, prod };
}

describe("recordLlmCall", () => {
  it("indexes the call under the production and keeps the full content gzip-compressed in the bucket", async () => {
    const { db, bucket, prod } = seed();
    const id = await recordLlmCall(db, bucket, call());
    const { items, total } = listLlmCalls(db, { productionId: prod, page: 1, pageSize: 20 });
    expect(total).toBe(1);
    const row = items[0]!;
    expect(row).toMatchObject({ id, production_id: prod, episode_id: null, skill: "studio-plan-episodes", model: "claude-opus-5-5", outcome: "accepted",
      input_tokens: 1200, output_tokens: 300, cost_usd: 0.42 });
    expect(row.payload_key).toMatch(new RegExp(`^llm-logs/claude/\\d{4}/\\d{2}/\\d{2}/${id}\\.json\\.gz$`));
    const stored = JSON.parse(gunzipSync(bucket.objects.get(row.payload_key!)!).toString("utf8"));
    expect(stored).toMatchObject({ schema: "studio.llm-call/v1", id, prompt: call().trace.prompt, structured_output: plan });
    expect((await readLlmCallPayload(bucket, row.payload_key!)).id).toBe(id);
    expect(latestAcceptedCall(db, "run-plan", "plan-episodes")).toBe(id);
  });

  it("an episode run's call belongs to that episode and its production", async () => {
    const { db, bucket, prod } = seed();
    await recordLlmCall(db, bucket, call({ run_id: "run-ep1", stage_key: "youtube-kit", skill: "studio-youtube-kit" }));
    const { items } = listLlmCalls(db, { productionId: prod, episodeId: "ep-1", page: 1, pageSize: 20 });
    expect(items.map((r) => [r.production_id, r.episode_id])).toEqual([[prod, "ep-1"]]);
  });

  it("keeps the row without content when the bucket refuses the upload, and says so", async () => {
    const { db, prod } = seed();
    const broken = new MemoryBucket();
    broken.put = async () => { throw new Error("R2 is down"); };
    await expect(recordLlmCall(db, broken, call())).rejects.toThrow("R2 is down");
    expect(listLlmCalls(db, { productionId: prod, page: 1, pageSize: 20 }).items[0]!.payload_key).toBeNull();
  });
});

describe("recordHumanEdit", () => {
  it("compares documents regardless of key order", () => {
    const { db, prod } = seed();
    recordHumanEdit(db, { userId: "u1", productionId: prod, kind: "series_plan", before: { a: 1, b: [1, 2] }, after: { b: [1, 2], a: 1 } });
    recordHumanEdit(db, { userId: "u1", productionId: prod, kind: "series_plan", before: { a: 1 }, after: { a: 2 } });
    recordHumanEdit(db, { userId: "u1", productionId: prod, episodeId: "ep-1", kind: "episode_cancel" });
    const kinds = listHumanEdits(db, { productionId: prod, page: 1, pageSize: 20 }).items.map((e) => [e.kind, e.changed]);
    expect(kinds.sort()).toEqual([["episode_cancel", 1], ["series_plan", 0], ["series_plan", 1]]);
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });
});

describe("exportLlmDataset", () => {
  it("writes accepted calls as chat messages, human edits as chosen/rejected pairs, and timeline edits", async () => {
    const { db, bucket, prod } = seed();
    const accepted = await recordLlmCall(db, bucket, call());
    await recordLlmCall(db, bucket, call({ outcome: "rejected", problems: [{ code: "unknown_asset", message: "a99" }] }));
    recordHumanEdit(db, { userId: "u1", productionId: prod, kind: "series_plan", before: plan, after: { ...plan, note: "sửa" }, llmCallId: accepted });
    const now = new Date().toISOString();
    const timeline = (n: number) => JSON.stringify({ episode_id: "ep-1", n });
    db.run("INSERT INTO episode_revisions (id, episode_id, revision, base_revision, data, author_id, label, created_at) VALUES ('r1', 'ep-1', 1, 0, ?, 'system', 'build-timeline', ?)", [timeline(1), now]);
    db.run("INSERT INTO episode_revisions (id, episode_id, revision, base_revision, data, author_id, label, created_at) VALUES ('r2', 'ep-1', 2, 1, ?, 'auth0|owner', 'autosave', ?)", [timeline(2), now]);

    const lines: string[] = [];
    const counts = await exportLlmDataset(db, bucket, {}, (l) => lines.push(l));
    expect(counts).toEqual({ calls: 1, edits: 1, timelines: 1, missingPayloads: 0 });
    const rows = lines.map((l) => JSON.parse(l));
    const sft = rows.find((r) => r.kind === "llm_call");
    expect(sft.messages).toEqual([
      { role: "system", content: "Lập kế hoạch tập." },
      { role: "user", content: "Chạy studio-plan-episodes" },
      { role: "assistant", content: JSON.stringify(plan) },
    ]);
    const edit = rows.find((r) => r.kind === "series_plan");
    expect(edit).toMatchObject({ source: "human", changed: true, llm_call_id: accepted, rejected: plan, chosen: { ...plan, note: "sửa" } });
    expect(edit.prompt[0].role).toBe("system");
    expect(rows.find((r) => r.kind === "timeline")).toMatchObject({ episode_id: "ep-1", changed: true, rejected: { episode_id: "ep-1", n: 1 }, chosen: { episode_id: "ep-1", n: 2 } });

    const all: string[] = [];
    expect((await exportLlmDataset(db, bucket, { includeRejected: true, kinds: ["calls"] }, (l) => all.push(l))).calls).toBe(2);
  });

  it("splits a prompt without the skill header into one user message", () => {
    expect(promptMessages("chỉ có brief")).toEqual([{ role: "user", content: "chỉ có brief" }]);
  });
});
