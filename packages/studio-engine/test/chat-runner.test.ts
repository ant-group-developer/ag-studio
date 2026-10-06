/**
 * The worker's chat loop: replies of different scopes run together (the barrier proves the two Claude calls
 * overlap), one scope one at a time, a reply left running by a dead worker runs again, and stopping puts a reply in
 * flight back in line with its slot given back.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatScopeFor, claudeUsage, createChatRunner, createStudioWorker, getTurn, insertUserTurn, listLlmCalls, listTurns, readLlmCallPayload,
  startPlanRun, studioLogger,
} from "../src/index.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

const BARRIER = fileURLToPath(new URL("./fixtures/barrier-claude.mjs", import.meta.url));
const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

function setup(chatArgv: string[], cap = 20) {
  const w = world();
  const worker = createStudioWorker({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(4, 30), farm: fakeFarm(w.bucket) as never,
    claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 }, owner: "auth0|owner", thumbnails: fakeThumbnails(),
  });
  const runner = createChatRunner({
    core: w.core, db: w.db, bucket: w.bucket, logger: studioLogger({ test: "chat-runner" }), cap: () => cap, pollMs: 50,
    claude: { skillsDir: join(ROOT, "skills"), argv: chatArgv, model: "fake", maxTurns: 3 },
  });
  return { ...w, worker, runner };
}
type Setup = ReturnType<typeof setup>;
async function drain(s: Setup): Promise<void> {
  for (let i = 0; i < 400; i++) if ((await s.worker.runOnce()) === "idle") return;
  throw new Error("worker still busy");
}
async function atGate(s: Setup, id: string) {
  const prod = seedProduction(s.db, { id, episode_target_seconds: 60, max_episodes: 1 });
  s.db.run("UPDATE productions SET keywords = ? WHERE id = ?", [JSON.stringify(["phở sáng"]), prod]);
  startPlanRun(s.core, s.db, prod);
  await drain(s);
  return chatScopeFor(s.core, s.db, prod);
}
const send = (s: Setup, key: ReturnType<typeof chatScopeFor>, text: string) =>
  insertUserTurn(s.db, key, { text, createdBy: "u" }, s.core.clock.now()).assistant!;

describe("chat runner", () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  it("runs replies of two productions at the same time, and frees every slot after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-barrier-"));
    s = setup(["node", BARRIER, dir, "2", "20000", FAKE_CLAUDE]);
    const a = send(s, await atGate(s, IDS[0]!), "Viết lại");
    const b = send(s, await atGate(s, IDS[1]!), "Viết lại");
    await s.runner.tick();
    expect(s.runner.running).toBe(2);
    await s.runner.idle();
    expect(readFileSync(join(dir, "seen.log"), "utf8").trim().split(/\r?\n/).map(Number)).toEqual([2, 2]);
    expect([getTurn(s.db, a.id)?.status, getTurn(s.db, b.id)?.status]).toEqual(["done", "done"]);
    expect(claudeUsage(s.db)).toEqual({ running: 0, waiting: 0 });
  }, 60_000);

  it("runs one reply at a time in a scope: a message sent meanwhile is answered next, seeing both", async () => {
    s = setup(["node", FAKE_CLAUDE]);
    const key = await atGate(s, IDS[0]!);
    send(s, key, "Viết lại");
    await s.runner.tick();
    send(s, key, "Thêm một ý");
    await s.runner.tick(); // the first is still running: nothing new starts for this scope
    expect(s.runner.running).toBe(1);
    await s.runner.idle();
    await s.runner.tick();
    await s.runner.idle();
    expect(listTurns(s.db, key.productionId).map((t) => [t.role, t.status])).toEqual([
      ["user", "done"], ["assistant", "done"], ["user", "done"], ["assistant", "done"],
    ]);
    const second = listTurns(s.db, key.productionId)[3]!;
    const call = listLlmCalls(s.db, { productionId: key.productionId, page: 1, pageSize: 50 }).items.find((c) => c.attempt_id === second.id)!;
    const prompt = (await readLlmCallPayload(s.bucket, call.payload_key!)).prompt;
    expect(prompt).toMatch(/- Người dùng: Viết lại\n- Claude: [^\n]+\n- Người dùng: Thêm một ý/);
  }, 60_000);

  it("waits in line for a slot when the cap is full", async () => {
    s = setup(["node", FAKE_CLAUDE], 1);
    const key = await atGate(s, IDS[0]!);
    // a stage holds the only slot
    s.db.run("INSERT INTO lease (stage_run_id, attempt_id, owner, expires_at, fencing_token, resources) VALUES ('stage_run_01J0000000000000000000000X', 'attempt_01J0000000000000000000000X', 'w', '2999-01-01T00:00:00.000Z', 1, '[\"claude\"]')");
    const t = send(s, key, "Viết lại");
    await s.runner.tick();
    expect(s.runner.running).toBe(0);
    expect(claudeUsage(s.db)).toEqual({ running: 1, waiting: 1 });
    s.db.run("DELETE FROM lease WHERE owner = 'w'");
    await s.runner.tick();
    await s.runner.idle();
    expect(getTurn(s.db, t.id)?.status).toBe("done");
  }, 60_000);

  it("runs again a reply a stopped worker left running, and stopping puts one in flight back in line", async () => {
    s = setup(["node", FAKE_CLAUDE]);
    const key = await atGate(s, IDS[0]!);
    const orphan = send(s, key, "Viết lại");
    s.db.run("UPDATE stage_chat_turns SET status = 'running' WHERE id = ?", [orphan.id]);
    await s.runner.tick();
    await s.runner.idle();
    expect(getTurn(s.db, orphan.id)?.status).toBe("done");

    const slow = setup(["node", BARRIER, mkdtempSync(join(tmpdir(), "chat-slow-")), "2", "3000", FAKE_CLAUDE]);
    try {
      const k2 = await atGate(slow, IDS[1]!);
      const t = send(slow, k2, "Viết lại");
      const ac = new AbortController();
      const loop = slow.runner.runForever(ac.signal);
      while (slow.runner.running === 0) await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      await loop;
      expect(getTurn(slow.db, t.id)?.status).toBe("pending");
      expect(claudeUsage(slow.db)).toEqual({ running: 0, waiting: 0 });
      expect(existsSync(slow.dir) && readdirSync(slow.dir).length).toBeTruthy();
    } finally { slow.core.close(); }
  }, 60_000);
});
