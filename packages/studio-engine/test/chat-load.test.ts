/**
 * Load (plan phase 2, E2): 20 chat replies and 12 Claude stages against a cap of 20 never run more than 20 calls at
 * once, and use all 20; with a full cap, people's messages waiting for a slot run before the stages queued after them.
 * A wrapper around the fake Claude logs every call's start and end with how many were running.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeUsage, createDraftProduction, createStudioWorkerPool, listTurns, planRunView, sendChatMessage, startPlanRun,
} from "../src/index.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

const WRAPPER = fileURLToPath(new URL("./fixtures/concurrency-claude.mjs", import.meta.url));
const PLAN_V1 = "ag-studio-series-plan@1.0.0";
const FOLDERS = { folders: [{ id: "folder-a", name: "Kyoto", usableVideos: 8 }] };

interface Call { what: "start" | "end"; kind: "chat" | "stage"; running: number; at: number }
const calls = (dir: string): Call[] => readFileSync(join(dir, "calls.log"), "utf8").trim().split(/\r?\n/).map((l) => {
  const [what, kind, running, at] = l.split(" ");
  return { what: what as Call["what"], kind: kind as Call["kind"], running: Number(running), at: Number(at) };
});

async function until(what: string, f: () => boolean, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function setup(cap: number, holdMs: number) {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), "claude-load-"));
  const pool = createStudioWorkerPool({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(6, 30), farm: fakeFarm(w.bucket) as never,
    claude: { skillsDir: join(ROOT, "skills"), argv: ["node", WRAPPER, dir, String(holdMs), FAKE_CLAUDE], model: "fake", maxTurns: 3 },
    owner: "load", thumbnails: fakeThumbnails(), claudeMaxConcurrent: cap, chatPollMs: 50,
  });
  const plans = (n: number) => Array.from({ length: n }, () => {
    const id = seedProduction(w.db, { id: randomUUID(), episode_target_seconds: 60, max_episodes: 1 });
    startPlanRun(w.core, w.db, id, { workflow: PLAN_V1 });
    return id;
  });
  const chats = (n: number) => Array.from({ length: n }, () => {
    const id = createDraftProduction(w.db, "team-1", "auth0|owner", new Date().toISOString());
    sendChatMessage(w.core, w.db, { productionId: id, text: "Làm series từ @[Kyoto](folder:folder-a)", userId: "auth0|owner", context: FOLDERS });
    return id;
  });
  const plansDone = (ids: string[]) => ids.every((id) => planRunView(w.core, w.db, id).waiting_gate === "approve-plan");
  const chatsDone = (ids: string[]) => ids.every((id) => listTurns(w.db, id).some((t) => t.role === "assistant" && t.status === "done"));
  return { ...w, dir, pool, plans, chats, plansDone, chatsDone };
}

describe("Claude load", () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => { await stop?.(); stop = undefined; });

  it("20 replies and 12 stages: never more than 20 Claude calls at once, and all 20 in use", async () => {
    const s = setup(20, 3000);
    const ac = new AbortController();
    const running = s.pool.runForever(ac.signal);
    stop = async () => { ac.abort(); await running; s.core.close(); };
    seedProduction(s.db); // the team the drafts belong to
    const plans = s.plans(12);
    const chats = s.chats(20);
    await until("every reply and every plan", () => s.chatsDone(chats) && s.plansDone(plans));
    const log = calls(s.dir);
    expect(log.filter((c) => c.what === "start")).toHaveLength(32);
    const peak = Math.max(...log.map((c) => c.running));
    expect(peak).toBeLessThanOrEqual(20);
    expect(peak).toBe(20);
    expect(claudeUsage(s.db)).toEqual({ running: 0, waiting: 0 });
  }, 180_000);

  it("with the cap full, messages waiting for a slot run before the stages queued after them", async () => {
    const s = setup(2, 1500);
    const ac = new AbortController();
    const running = s.pool.runForever(ac.signal);
    stop = async () => { ac.abort(); await running; s.core.close(); };
    seedProduction(s.db);
    const plans = s.plans(4);
    await until("two stages holding both slots", () => {
      try { return calls(s.dir).filter((c) => c.what === "start").length >= 2; } catch { return false; }
    });
    const chats = s.chats(2);
    await until("every reply and every plan", () => s.chatsDone(chats) && s.plansDone(plans));
    const starts = calls(s.dir).filter((c) => c.what === "start").map((c) => c.kind);
    expect(starts.slice(0, 2)).toEqual(["stage", "stage"]);
    expect(starts.slice(2, 4)).toEqual(["chat", "chat"]);
    expect(Math.max(...calls(s.dir).map((c) => c.running))).toBeLessThanOrEqual(2);
  }, 180_000);
});
