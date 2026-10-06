/**
 * Phase 3 acceptance (plan 2026-10-06-ag-studio-phase-3-render, E1): the same episode renders with two machine types.
 * In one process with the fake Claude and a fake farm: the worker pool runs in the background while the test acts
 * like a person through the engine's functions — the ones the API routes call (their DTOs and roles are covered by
 * apps/api/src/studio/render-machine.spec.ts):
 *   plan approved → episode timeline approved → YouTube kit approved with "a machine with NVENC" → the Queue shows the
 *   render on that type while it runs → done → Render lại with "any machine" → only the render runs again (no Claude
 *   call, no approval) → done; the farm saw {nvenc: true}, then {}.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveChatScope, createStudioWorkerPool, episodeRenderInfo, episodeRunView, episodeState, listEpisodes, planRunView, rerenderEpisode, startPlanRun, studioQueue,
  type StudioWorkerPool,
} from "@ag-studio/engine";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "../../packages/studio-engine/test/helpers.js";

const USER = "auth0|owner";
/** The farm executor logs every upload; the test reads state, not logs. */
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };

async function until<T>(what: string, f: () => T | undefined | null | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The fake farm, but a job submitted while `hold` is on stays leased at 40% until it is turned off. */
function holdingFarm(bucket: ReturnType<typeof world>["bucket"]) {
  const farm = fakeFarm(bucket);
  const held = new Set<string>();
  let hold = false;
  return {
    jobs: farm.jobs,
    held,
    set hold(v: boolean) { hold = v; if (!v) held.clear(); },
    async submitJob(req: Parameters<typeof farm.submitJob>[0]) {
      const r = await farm.submitJob(req);
      if (hold) held.add(r.job.id);
      return r;
    },
    async getJob(id: string) {
      return held.has(id) ? { ...farm.jobs.get(id)!, status: "leased", progress_percent: 40 } : farm.getJob(id);
    },
    async listJobs() {
      const jobs = [...held].map((id) => ({ id, status: "leased", progress_percent: 40, progress_stage: null, attempt_count: 1, created_at: new Date().toISOString() }));
      return { jobs: jobs as never, next_cursor: null };
    },
    ackJob: farm.ackJob,
    cancelJob: farm.cancelJob,
  };
}

describe("one episode, two machine types", () => {
  const w = world();
  const farm = holdingFarm(w.bucket);
  let pool: StudioWorkerPool;
  const ac = new AbortController();
  let running: Promise<void>;
  let prod = "";
  let episodeId = "";
  const claudeCalls = () => w.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls")!.n;
  const finalJobs = () => [...farm.jobs.values()].filter((j) => j.type === "studio.render_final");

  beforeAll(() => {
    pool = createStudioWorkerPool({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(4, 30), farm: farm as never,
      claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
      owner: "render-machine", thumbnails: fakeThumbnails(), logger: quiet, claudeMaxConcurrent: 4, chatPollMs: 50, farmPollMs: 20,
    });
    running = pool.runForever(ac.signal);
  });
  afterAll(async () => {
    ac.abort();
    await running;
    w.core.close();
  });

  it("a series reaches its episode's YouTube kit", async () => {
    prod = seedProduction(w.db, { episode_target_seconds: 60, max_episodes: 1 });
    w.db.run("UPDATE productions SET keywords = ? WHERE id = ?", [JSON.stringify(["phở sáng"]), prod]);
    startPlanRun(w.core, w.db, prod);
    for (const gate of ["approve-trend-report", "approve-rnd", "approve-branding", "approve-plan"]) {
      await until(`the plan at ${gate}`, () => planRunView(w.core, w.db, prod).waiting_gate === gate);
      await approveChatScope(w.core, w.db, { productionId: prod, stageKey: gate, turnId: null, userId: USER });
    }
    const ep = await until("an episode at approve-timeline", () => {
      const e = listEpisodes(w.db, prod)[0];
      return e?.run_id && episodeRunView(w.core, w.db, e.id).waiting_gate === "approve-timeline" ? e : undefined;
    });
    episodeId = ep.id;
    await approveChatScope(w.core, w.db, { productionId: prod, episodeId, stageKey: "approve-timeline", userId: USER });
    await until("the kit waiting", () => episodeRunView(w.core, w.db, episodeId).waiting_gate === "approve-youtube-kit");
  });

  it("approved with a machine with NVENC: the farm gets {nvenc: true}, and the Queue shows it on that type while it renders", async () => {
    farm.hold = true;
    await approveChatScope(w.core, w.db, { productionId: prod, episodeId, stageKey: "approve-youtube-kit", userId: USER, renderMachine: "nvenc" });
    await until("the render on the farm", () => farm.held.size === 1);
    const q = await studioQueue(w.core, w.db, farm, { userId: USER, isAdmin: false, now: new Date().toISOString(), claudeMax: 4 });
    expect(q.renders).toEqual([expect.objectContaining({ kind: "final", episodeId, machine: "nvenc", status: "leased", progress: 40 })]);
    expect(episodeRenderInfo(w.core, w.db, episodeId)).toMatchObject({ machine: "nvenc", restartFrom: null, job: { machine: "nvenc" } });
    farm.hold = false;
    await until("the episode ready", () => episodeState(w.core, w.db, { run_id: listEpisodes(w.db, prod)[0]!.run_id }).status === "ready");
    expect(finalJobs().map((j) => j.requirements)).toEqual([{ nvenc: true }]);
  });

  it("Render lại on any machine: only the render runs again, no Claude call, and the farm gets {}", async () => {
    const calls = claudeCalls();
    expect(episodeRenderInfo(w.core, w.db, episodeId).restartFrom).toBe("render-final");
    const again = rerenderEpisode(w.core, w.db, episodeId, { machine: "any", by: USER });
    expect(again.from).toBe("render-final");
    await until("the second render done", () => {
      const ep = listEpisodes(w.db, prod)[0]!;
      return ep.run_id === again.runId && episodeState(w.core, w.db, ep).status === "ready";
    });
    expect(claudeCalls()).toBe(calls);
    expect(finalJobs().map((j) => j.requirements)).toEqual([{ nvenc: true }, {}]);
    expect(w.db.all("SELECT requirements FROM studio_farm_jobs WHERE episode_id = ? AND stage_key = 'render-final' ORDER BY created_at, rowid", [episodeId]))
      .toEqual([{ requirements: '{"nvenc":true}' }, { requirements: "{}" }]);
    expect(episodeRenderInfo(w.core, w.db, episodeId)).toMatchObject({ machine: "any", job: { machine: "any" } });
  });
});

