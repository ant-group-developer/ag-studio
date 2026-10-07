/**
 * A Claude stage that failed its check runs again with what the person said in the chat about it (Q5 of the
 * phase-2 plan): the feedback goes into the stage's prompt; without feedback the prompt is the usual one.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatScopeFor, createStudioWorker, insertUserTurn, listLlmCalls, listTurns, readLlmCallPayload, retryStageWithFeedback, startPlanRun, StudioRunError,
} from "../src/index.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

function setup() {
  const w = world();
  const worker = createStudioWorker({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(4, 30), farm: fakeFarm(w.bucket) as never,
    claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3, baseEnv: { ...process.env, FAKE_STUDIO_MODE: "plan-bad-always" } },
    owner: "auth0|owner", thumbnails: fakeThumbnails(),
  });
  return { ...w, worker };
}
type Setup = ReturnType<typeof setup>;
async function drain(s: Setup): Promise<void> {
  for (let i = 0; i < 400; i++) if ((await s.worker.runOnce()) === "idle") return;
  throw new Error("worker still busy");
}
async function prompts(s: Setup, id: string): Promise<string[]> {
  const calls = listLlmCalls(s.db, { productionId: id, page: 1, pageSize: 50 }).items.filter((c) => c.stage_key === "plan-episodes" && c.source === "claude").reverse();
  return Promise.all(calls.map(async (c) => (await readLlmCallPayload(s.bucket, c.payload_key!)).prompt));
}

describe("retryStageWithFeedback", () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  it("runs the failed stage again with the chat's feedback in its prompt", async () => {
    s = setup();
    const id = seedProduction(s.db, { episode_target_seconds: 60, max_episodes: 1 });
    startPlanRun(s.core, s.db, id, { workflow: "ag-studio-series-plan@1.0.0" });
    await drain(s);
    const key = chatScopeFor(s.core, s.db, id);
    expect(key).toMatchObject({ scope: "failed", stageKey: "plan-episodes" });
    expect((await prompts(s, id)).some((p) => p.includes("# Góp ý của người dùng"))).toBe(false);

    insertUserTurn(s.db, key, { text: "Mỗi video chỉ dùng một lần,\nbỏ video tối", createdBy: "u", ask: false }, s.core.clock.now());
    expect(() => retryStageWithFeedback(s.core, s.db, id, { stageKey: "rnd" })).toThrow(StudioRunError);
    retryStageWithFeedback(s.core, s.db, id, { stageKey: "plan-episodes" });
    expect(listTurns(s.db, id).at(-1)).toMatchObject({ role: "system", text: "Đang chạy lại bước này với góp ý của bạn." });
    await drain(s);
    const last = (await prompts(s, id)).at(-1)!;
    expect(last).toContain("# Góp ý của người dùng\nLần trước câu trả lời của bước này bị từ chối; người dùng góp ý như sau, làm theo:\n- Mỗi video chỉ dùng một lần,\n  bỏ video tối\n\n# Đầu ra");
  }, 60_000);
});
