/**
 * Claude concurrency: `STUDIO_CLAUDE_MAX_CONCURRENT` and the worker pool. Two productions planned together must have
 * their Claude calls (plan-episodes) running at the same time when the cap allows it, and one after the other when
 * the cap is 1. A barrier wrapper around the fake Claude records how many calls had arrived when each one started.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStudioWorkerPool, DEFAULT_CLAUDE_MAX_CONCURRENT, parseClaudeMaxConcurrent, planRunView, setClaudeMaxConcurrent, startPlanRun, studioResources,
} from "../src/index.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

const BARRIER = fileURLToPath(new URL("./fixtures/barrier-claude.mjs", import.meta.url));
const PLAN_V1 = "ag-studio-series-plan@1.0.0";

describe("parseClaudeMaxConcurrent / studioResources", () => {
  it("defaults to 20 when unset or blank", () => {
    expect(DEFAULT_CLAUDE_MAX_CONCURRENT).toBe(20);
    expect(parseClaudeMaxConcurrent(undefined)).toBe(20);
    expect(parseClaudeMaxConcurrent("  ")).toBe(20);
    expect(studioResources()).toEqual({ claude: 20, farm: 8, cpu: 2 });
  });

  it("accepts a whole number from 1 to 100", () => {
    expect(parseClaudeMaxConcurrent("1")).toBe(1);
    expect(parseClaudeMaxConcurrent(" 7 ")).toBe(7);
    expect(parseClaudeMaxConcurrent("100")).toBe(100);
    expect(studioResources(7)).toEqual({ claude: 7, farm: 8, cpu: 2 });
  });

  it("refuses anything else instead of falling back silently", () => {
    for (const bad of ["0", "-1", "101", "2.5", "abc", "20x"]) {
      expect(() => parseClaudeMaxConcurrent(bad)).toThrow(/STUDIO_CLAUDE_MAX_CONCURRENT/);
    }
  });
});

describe("createStudioWorkerPool", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  async function planTwo(claudeMaxConcurrent: number, barrierTimeoutMs: number): Promise<number[]> {
    const w = world();
    cleanup = () => w.core.close();
    const barrierDir = mkdtempSync(join(tmpdir(), "claude-barrier-"));
    const pool = createStudioWorkerPool({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(8, 30), farm: fakeFarm(w.bucket) as never,
      claude: { skillsDir: join(ROOT, "skills"), argv: ["node", BARRIER, barrierDir, "2", String(barrierTimeoutMs), FAKE_CLAUDE], model: "fake", maxTurns: 3 },
      owner: "auth0|owner", thumbnails: fakeThumbnails(), claudeMaxConcurrent,
    });
    expect(pool.workers).toHaveLength(claudeMaxConcurrent + 8 + 2);

    const prods = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
      .map((id) => seedProduction(w.db, { id, episode_target_seconds: 120, max_episodes: 2 }));
    for (const p of prods) startPlanRun(w.core, w.db, p, { workflow: PLAN_V1 });

    const ac = new AbortController();
    const running = pool.runForever(ac.signal);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !prods.every((p) => planRunView(w.core, w.db, p).waiting_gate === "approve-plan")) {
      await new Promise((r) => setTimeout(r, 100));
    }
    ac.abort();
    await running;
    for (const p of prods) expect(planRunView(w.core, w.db, p).waiting_gate).toBe("approve-plan");
    return readFileSync(join(barrierDir, "seen.log"), "utf8").trim().split(/\r?\n/).map(Number);
  }

  it("runs the two productions' Claude calls together when the cap allows it", async () => {
    const seen = await planTwo(2, 20_000);
    expect(seen).toEqual([2, 2]);
  }, 60_000);

  it("runs them one after the other when the cap is 1", async () => {
    const seen = await planTwo(1, 1_500);
    expect(seen[0]).toBe(1);
  }, 60_000);

  it("follows the cap saved on the web over the env value, and shrinks without cutting a running stage", async () => {
    const w = world();
    cleanup = () => w.core.close();
    setClaudeMaxConcurrent(w.db, 2, "auth0|admin", new Date().toISOString());
    const barrierDir = mkdtempSync(join(tmpdir(), "claude-barrier-"));
    const pool = createStudioWorkerPool({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(8, 30), farm: fakeFarm(w.bucket) as never,
      claude: { skillsDir: join(ROOT, "skills"), argv: ["node", BARRIER, barrierDir, "2", "20000", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
      owner: "auth0|owner", thumbnails: fakeThumbnails(), claudeMaxConcurrent: 1,
    });
    expect(pool.workers).toHaveLength(2 + 8 + 2);

    const prods = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
      .map((id) => seedProduction(w.db, { id, episode_target_seconds: 120, max_episodes: 2 }));
    for (const p of prods) startPlanRun(w.core, w.db, p, { workflow: PLAN_V1 });
    const ac = new AbortController();
    const running = pool.runForever(ac.signal);

    // both Claude calls are in flight (the barrier holds them until two arrived): lower the cap now
    const arrived = () => (existsSync(barrierDir) ? readdirSync(barrierDir).filter((f) => f.startsWith("arrived-")).length : 0);
    const until = Date.now() + 20_000;
    while (Date.now() < until && arrived() < 2) await new Promise((r) => setTimeout(r, 50));
    setClaudeMaxConcurrent(w.db, 1, "auth0|admin", new Date().toISOString());
    pool.resize();
    expect(pool.workers).toHaveLength(1 + 8 + 2);

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !prods.every((p) => planRunView(w.core, w.db, p).waiting_gate === "approve-plan")) {
      await new Promise((r) => setTimeout(r, 100));
    }
    ac.abort();
    await running;
    // the loops let go after the cap dropped still finished their stage
    for (const p of prods) expect(planRunView(w.core, w.db, p).waiting_gate).toBe("approve-plan");
    expect(readFileSync(join(barrierDir, "seen.log"), "utf8").trim().split(/\r?\n/).map(Number)).toEqual([2, 2]);

    setClaudeMaxConcurrent(w.db, 4, "auth0|admin", new Date().toISOString());
    pool.resize();
    expect(pool.workers).toHaveLength(4 + 8 + 2);
  }, 60_000);
});
