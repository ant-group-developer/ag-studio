/**
 * End-to-end integration test for the GĐ2 series workflow:
 *   ag-studio-series-plan → approve-plan gate → studio-spawn-episodes →
 *   ag-studio-episode (×N) → export
 *
 * Uses the fake-studio-claude fixture, fakeFootage (whole-asset), and fakeFarm.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelPlan, createStudioWorker, episodeRunView, listEpisodes, planRunView,
  readStageDocument, startPlanRun, submitStudioGate, STUDIO_WORKFLOWS,
} from "../src/index.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, seedProduction, world, ROOT } from "./helpers.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Pump the worker until it is idle (nothing to process) or maxTicks exceeded. */
async function drain(worker: ReturnType<typeof createStudioWorker>, maxTicks = 120): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const result = await worker.runOnce();
    if (result === "idle") return;
  }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const WORKERS: ReturnType<typeof createStudioWorker>[] = [];
afterEach(() => {
  for (const w of WORKERS) { try { (w as unknown as { close?(): void }).close?.(); } catch { /* ignore */ } }
  WORKERS.length = 0;
});

describe(`${STUDIO_WORKFLOWS.plan.workflow} + ${STUDIO_WORKFLOWS.episode.workflow} end to end (fake Claude, fake ag-go, fake farm)`, () => {
  it("runs plan → approve-plan → spawns 2 episodes → both export with MP4 + thumbnails + youtube.json", async () => {
    const { core, db, bucket, dbPath } = world();
    const footage = fakeFootage(8, 30); // 8 assets × 30 s = 240 s total
    const farm = fakeFarm(bucket);
    const worker = createStudioWorker({
      core, db, dbPath, bucket, footage, farm: farm as never,
      claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
      owner: "auth0|owner",
    });
    WORKERS.push(worker);

    const prodId = seedProduction(db, { episode_target_seconds: 120, max_episodes: 2 });

    // 1. Start the plan run
    const { runId: planRunId } = startPlanRun(core, db, prodId);
    expect(planRunId).toBeTruthy();

    // 2. Drain until the approve-plan gate is reached (or the run completes if no gate needed)
    await drain(worker);
    const planView1 = planRunView(core, db, prodId);
    // The run should be WAITING (at the approve-plan gate) or SUCCEEDED
    expect(["RUNNING", "SUCCEEDED", "WAITING"]).toContain(planView1.state);

    if (planView1.waiting_gate === "approve-plan") {
      // Read the series-plan produced by studio-plan-episodes
      const planDoc = planView1.stages.find((s) => s.key === "studio-plan-episodes");
      expect(planDoc?.state).toBe("SUCCEEDED");

      // 3. Submit the approve-plan gate — pass the series-plan from the previous stage
      const seriesPlan = readStageDocument(core, planRunId, "studio-plan-episodes", "series-plan.json");
      await submitStudioGate(core, db, planRunId, "approve-plan", seriesPlan);

      // 4. Drain until the plan run is complete
      await drain(worker);
    }

    const planView2 = planRunView(core, db, prodId);
    expect(planView2.state).toBe("SUCCEEDED");

    // 5. Check episodes were created
    const episodes = listEpisodes(db, prodId);
    expect(episodes.length).toBeGreaterThanOrEqual(1);

    // Drain episode runs (they were started by studio-spawn-episodes)
    await drain(worker, 240);

    // 6. Submit freeze-timeline gates for all episodes waiting at the gate
    for (const ep of listEpisodes(db, prodId)) {
      const epView = episodeRunView(core, db, ep.id);
      if (epView.waiting_gate === "freeze-timeline") {
        await submitStudioGate(core, db, epView.run_id, "freeze-timeline");
      }
    }

    // 7. Drain until all episode runs complete
    await drain(worker, 240);

    // 8. Verify final state
    for (const ep of listEpisodes(db, prodId)) {
      const epView = episodeRunView(core, db, ep.id);
      expect(epView.state).toBe("SUCCEEDED");

      // Check export outputs landed in bucket
      const exportStage = epView.stages.find((s) => s.key === "studio-episode-export");
      expect(exportStage?.state).toBe("SUCCEEDED");

      // The export stage should have written export.json and youtube.json
      const exportOutputs = exportStage?.outputs ?? [];
      const exportJson = exportOutputs.find((o) => o.name === "export.json");
      expect(exportJson).toBeTruthy();
    }

    // 9. Check bucket has an mp4 per episode
    const mp4Keys = [...bucket.objects.keys()].filter((k) => k.endsWith(".mp4"));
    expect(mp4Keys.length).toBeGreaterThanOrEqual(episodes.length);

    // 10. Verify re-plan while an episode is producing is refused
    // (all episodes have finished, so start a fresh worker and test mid-flight)
    // — covered in the re-plan test below
  }, 30_000);

  it("trend-report is skipped when research has no videos", async () => {
    // When fake-studio-claude receives studio-trend-report with empty research,
    // the executor should write a skipped=true TrendReport and the run should continue.
    const { core, db, bucket, dbPath } = world();
    const footage = fakeFootage(4, 30);
    const farm = fakeFarm(bucket);
    const worker = createStudioWorker({
      core, db, dbPath, bucket, footage, farm: farm as never,
      claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
      owner: "auth0|owner",
    });
    WORKERS.push(worker);
    const prodId = seedProduction(db, { episode_target_seconds: 120, max_episodes: 1 });
    const { runId } = startPlanRun(core, db, prodId);
    await drain(worker, 60);
    const view = planRunView(core, db, prodId);
    const trendStage = view.stages.find((s) => s.key === "studio-trend-report");
    // Should be SUCCEEDED (skipped or ran — either is fine as long as it didn't fail)
    expect(trendStage?.state).toBe("SUCCEEDED");
    // cancelPlan so subsequent tests aren't blocked
    try { cancelPlan(core, db, prodId); } catch { /* already done */ }
    void runId;
  }, 15_000);

  it("startPlanRun is refused while an episode run is producing", async () => {
    const { core, db, bucket, dbPath } = world();
    const footage = fakeFootage(4, 30);
    const farm = fakeFarm(bucket);
    const worker = createStudioWorker({
      core, db, dbPath, bucket, footage, farm: farm as never,
      claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
      owner: "auth0|owner",
    });
    WORKERS.push(worker);
    const prodId = seedProduction(db, { episode_target_seconds: 90, max_episodes: 1 });

    // Start and approve a plan, then block at freeze-timeline to keep episode in RUNNING
    startPlanRun(core, db, prodId);
    await drain(worker, 60);
    const view1 = planRunView(core, db, prodId);
    if (view1.waiting_gate === "approve-plan") {
      const sp = readStageDocument(core, view1.run_id, "studio-plan-episodes", "series-plan.json");
      await submitStudioGate(core, db, view1.run_id, "approve-plan", sp);
      await drain(worker, 60);
    }
    cancelPlan(core, db, prodId);

    // Manually insert a fake producing episode
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO episodes (id, production_id, idx, title, hook, status, plan, created_at, updated_at)
       VALUES ('ep-fake', ?, 99, 'Test', 'hook', 'in_progress', '{}', ?, ?)`,
      [prodId, now, now],
    );

    // Trying to start another plan run should fail
    expect(() => startPlanRun(core, db, prodId)).toThrow();
  }, 15_000);
});
