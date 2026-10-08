/**
 * Chat first (ag-studio-series-plan@3.0.0, and 3.1.0 which only adds the edit style per episode): a gate after every Claude stage. The run stops at the trend report for a
 * person to approve; R&D, branding, the plan and the episodes read the trend report as approved. Runs on 2.0.0 keep
 * going as before.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrendReportSchema } from "@harness/contracts";
import {
  createStudioWorker, getProduction, planRunView, readStageDocument, startPlanRun, STUDIO_GATES, STUDIO_WORKFLOWS, submitStudioGate,
} from "../src/index.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

function setup() {
  const w = world();
  const worker = createStudioWorker({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(8, 30), farm: fakeFarm(w.bucket) as never,
    claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
    owner: "auth0|owner", thumbnails: fakeThumbnails(),
  });
  return { ...w, worker };
}
type Setup = ReturnType<typeof setup>;

async function drain(s: Setup): Promise<void> {
  for (let i = 0; i < 400; i++) if ((await s.worker.runOnce()) === "idle") return;
  throw new Error("worker still busy");
}

function seedMinimal(s: Setup, id?: string): string {
  const prod = seedProduction(s.db, id ? { id } : {});
  s.db.run("UPDATE productions SET keywords = ?, own_channels = ?, youtube_channels = ?, max_episodes = 2 WHERE id = ?",
    [JSON.stringify(["phở sáng"]), JSON.stringify(["@phosang"]), JSON.stringify(["@kenhA"]), prod]);
  return prod;
}

describe("ag-studio-series-plan@3.0.0 / 3.1.0", () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  it("its trend-report gate submits trend-report.json (new runs use 3.2.0, which adds the style)", () => {
    expect(STUDIO_WORKFLOWS.plan.workflow).toBe("ag-studio-series-plan@3.2.0");
    expect(STUDIO_GATES["approve-trend-report"]).toBe("trend-report.json");
  });

  it("stops at the trend report, and the approved one is what R&D and the episodes read", async () => {
    s = setup();
    const prod = seedMinimal(s);
    const { runId } = startPlanRun(s.core, s.db, prod, { workflow: "ag-studio-series-plan@3.1.0" });
    await drain(s);
    expect(planRunView(s.core, s.db, prod).waiting_gate).toBe("approve-trend-report");
    expect(planRunView(s.core, s.db, prod).stages.find((x) => x.key === "rnd")?.state).toBe("PENDING");

    const report = TrendReportSchema.parse(readStageDocument(s.core, runId, "trend-report", "trend-report.json"));
    const approved = { ...report, summary: "Video dài, nhịp chậm, không ẩm thực." };
    await submitStudioGate(s.core, s.db, runId, "approve-trend-report", approved);
    await drain(s);
    expect(planRunView(s.core, s.db, prod).waiting_gate).toBe("approve-rnd");
    const rndRequest = s.core.store.listStageRuns(runId).find((x) => x.stage_key === "rnd")!;
    expect(rndRequest.state).toBe("SUCCEEDED");

    await submitStudioGate(s.core, s.db, runId, "approve-rnd", readStageDocument(s.core, runId, "rnd", "rnd.json"));
    await drain(s);
    expect(planRunView(s.core, s.db, prod).waiting_gate).toBe("approve-branding");
    await submitStudioGate(s.core, s.db, runId, "approve-branding", readStageDocument(s.core, runId, "branding", "branding.json"));
    await drain(s);
    expect(planRunView(s.core, s.db, prod).waiting_gate).toBe("approve-plan");
    await submitStudioGate(s.core, s.db, runId, "approve-plan", readStageDocument(s.core, runId, "plan-episodes", "series-plan.json"));
    await drain(s);
    // spawn-episodes keeps the trend report the person approved on the production (episodes read it from there)
    expect(JSON.parse(getProduction(s.db, prod)!.trend_report!).summary).toBe("Video dài, nhịp chậm, không ẩm thực.");
  }, 60_000);

  it("a run started on 2.0.0 still goes straight from the trend report to R&D", async () => {
    s = setup();
    const prod = seedMinimal(s);
    startPlanRun(s.core, s.db, prod, { workflow: "ag-studio-series-plan@2.0.0" });
    await drain(s);
    expect(planRunView(s.core, s.db, prod).waiting_gate).toBe("approve-rnd");
  }, 60_000);
});
