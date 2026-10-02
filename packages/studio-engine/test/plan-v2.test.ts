/**
 * Research first (ag-studio-series-plan@2.0.0), in-process with fake Claude, fake ag-go and fake farm:
 * seed -> research + catalog -> trend report -> R&D -> [approve-rnd] -> apply -> branding -> [approve-branding] ->
 * apply -> brief -> plan -> [approve-plan] -> episodes. The approved documents become the production's, the brief
 * reads them, and re-planning from `brief` uses what a person edited after approving.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  StudioBrandingSchema, StudioBriefSchema, StudioRndSchema, StudioSeedSchema, SeriesPlanSchema,
} from "@harness/contracts";
import {
  createStudioWorker, createTeamSkill, getProduction, listEpisodes, listLlmCalls, planRunView, productionBranding, productionRnd,
  readLlmCallPayload, readStageDocument, resumePlanRunFrom, startPlanRun, StudioRunError, submitStudioGate,
} from "../src/index.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

const PLAN_V2 = "ag-studio-series-plan@2.0.0";

function setup(mode = "") {
  const w = world();
  const worker = createStudioWorker({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(8, 30), farm: fakeFarm(w.bucket) as never,
    claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3, baseEnv: { ...process.env, FAKE_STUDIO_MODE: mode } },
    owner: "auth0|owner", thumbnails: fakeThumbnails(),
  });
  return { ...w, worker };
}
type Setup = ReturnType<typeof setup>;

async function drain(s: Setup, maxTicks = 400): Promise<void> {
  for (let i = 0; i < maxTicks; i++) if ((await s.worker.runOnce()) === "idle") return;
  throw new Error("worker still busy");
}

/** A production with only what the research-first flow needs: folders, an own channel and keywords; no hints. */
function seedMinimal(s: Setup, hints: { target?: number | null; max?: number | null } = {}): string {
  const id = seedProduction(s.db);
  s.db.run(`UPDATE productions SET brief = NULL, goal = NULL, audience = NULL, tone = NULL, episode_target_seconds = ?, max_episodes = ?,
            keywords = ?, own_channels = ?, youtube_channels = ? WHERE id = ?`,
    [hints.target ?? null, hints.max ?? null, JSON.stringify(["phở sáng"]), JSON.stringify(["@phosang"]), JSON.stringify(["@kenhA"]), id]);
  return id;
}

describe(PLAN_V2, () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  it("asks only for folders and something to research", () => {
    s = setup();
    const id = seedProduction(s.db);
    s.db.run("UPDATE productions SET keywords = NULL, youtube_channels = NULL, own_channels = NULL WHERE id = ?", [id]);
    const refused = (() => { try { startPlanRun(s.core, s.db, id, { workflow: PLAN_V2 }); } catch (e) { return e; } return null; })();
    expect(refused).toBeInstanceOf(StudioRunError);
    expect((refused as StudioRunError).details.code).toBe("nothing_to_research");
  });

  it("research -> R&D -> branding -> plan: approved documents become the production's and drive the brief", async () => {
    s = setup();
    const prodId = seedMinimal(s, { max: 2 });
    createTeamSkill(s.db, "team-1", { name: "Giọng R&D", content: "Luôn so với kênh mình", appliesTo: ["rnd"] }, "u");
    const { runId } = startPlanRun(s.core, s.db, prodId, { workflow: PLAN_V2 });
    await drain(s);

    let view = planRunView(s.core, s.db, prodId);
    expect(view.waiting_gate).toBe("approve-rnd");
    const seed = StudioSeedSchema.parse(readStageDocument(s.core, runId, "intake", "seed.json"));
    expect(seed.channels).toEqual([{ url: "@phosang", role: "own" }, { url: "@kenhA", role: "reference" }]);
    expect(seed.hints).toMatchObject({ description: "", episode_target_seconds: null, max_episodes: 2 });
    const proposed = StudioRndSchema.parse(readStageDocument(s.core, runId, "rnd", "rnd.json"));
    expect(proposed.own_channels).not.toBeNull();
    expect(proposed.direction.max_episodes).toBe(2);
    const rndCall = listLlmCalls(s.db, { productionId: prodId, page: 1, pageSize: 20 }).items.find((c) => c.stage_key === "rnd")!;
    const rndPrompt = (await readLlmCallPayload(s.bucket, rndCall.payload_key!)).prompt;
    expect(rndPrompt).toContain("## studio_catalog_summary (catalog.json)");
    expect(rndPrompt).toContain("<team_guide name=\"Giọng R&amp;D\">");

    const approvedRnd = { ...proposed, direction: { ...proposed.direction, description: "Mỗi tập một quán phở lúc 6 giờ sáng.", episode_target_seconds: 90 } };
    await submitStudioGate(s.core, s.db, runId, "approve-rnd", approvedRnd);
    await drain(s);
    expect(productionRnd(getProduction(s.db, prodId)!)!.direction.description).toBe("Mỗi tập một quán phở lúc 6 giờ sáng.");
    expect(getProduction(s.db, prodId)!.rnd_updated_by).toBe(`gate:${runId}`);

    view = planRunView(s.core, s.db, prodId);
    expect(view.waiting_gate).toBe("approve-branding");
    const branding = StudioBrandingSchema.parse(readStageDocument(s.core, runId, "branding", "branding.json"));
    await submitStudioGate(s.core, s.db, runId, "approve-branding", { ...branding, series_name: "Phở 6 Giờ" });
    await drain(s);
    expect(productionBranding(getProduction(s.db, prodId)!)!.series_name).toBe("Phở 6 Giờ");

    view = planRunView(s.core, s.db, prodId);
    expect(view.waiting_gate).toBe("approve-plan");
    const brief = StudioBriefSchema.parse(readStageDocument(s.core, runId, "brief", "brief.json"));
    expect(brief).toMatchObject({ description: "Mỗi tập một quán phở lúc 6 giờ sáng.", episode_target_seconds: 90, max_episodes: 2, youtube_channels: ["@kenhA"] });
    expect(StudioBrandingSchema.parse(readStageDocument(s.core, runId, "brief", "branding.json")).series_name).toBe("Phở 6 Giờ");

    const plan = SeriesPlanSchema.parse(readStageDocument(s.core, runId, "plan-episodes", "series-plan.json"));
    await submitStudioGate(s.core, s.db, runId, "approve-plan", plan);
    await drain(s);
    expect(planRunView(s.core, s.db, prodId).state).toBe("SUCCEEDED");
    expect(listEpisodes(s.db, prodId).length).toBe(plan.episodes.length);

    // ag-studio-episode@1.1.0: the YouTube kit follows the approved branding and reads the trend report
    const ep = listEpisodes(s.db, prodId)[0]!;
    const kitCall = listLlmCalls(s.db, { productionId: prodId, episodeId: ep.id, page: 1, pageSize: 20 }).items.find((c) => c.stage_key === "youtube-kit")!;
    const kitPrompt = (await readLlmCallPayload(s.bucket, kitCall.payload_key!)).prompt;
    expect(kitPrompt).toContain("## studio_branding (branding.json)");
    expect(kitPrompt).toContain("## trend_report (trend-report.json)");
    expect((readStageDocument(s.core, ep.run_id!, "youtube-kit", "youtube-kit.json") as { playlist: string }).playlist).toBe("Phở 6 Giờ");
  }, 120_000);

  it("re-planning from `brief` uses the R&D a person edited after approving, without asking for it again", async () => {
    s = setup();
    const prodId = seedMinimal(s, { max: 1 });
    const { runId } = startPlanRun(s.core, s.db, prodId, { workflow: PLAN_V2 });
    await drain(s);
    await submitStudioGate(s.core, s.db, runId, "approve-rnd", readStageDocument(s.core, runId, "rnd", "rnd.json"));
    await drain(s);
    await submitStudioGate(s.core, s.db, runId, "approve-branding", readStageDocument(s.core, runId, "branding", "branding.json"));
    await drain(s);
    await submitStudioGate(s.core, s.db, runId, "approve-plan", readStageDocument(s.core, runId, "plan-episodes", "series-plan.json"));
    await drain(s);

    const rnd = productionRnd(getProduction(s.db, prodId)!)!;
    s.db.run("UPDATE productions SET rnd = ? WHERE id = ?", [JSON.stringify({ ...rnd, direction: { ...rnd.direction, description: "Sửa sau khi duyệt" } }), prodId]);
    const again = resumePlanRunFrom(s.core, s.db, prodId, "brief");
    expect(again.reused).toEqual(expect.arrayContaining(["apply-rnd", "apply-branding", "approve-rnd"]));
    await drain(s);
    expect(planRunView(s.core, s.db, prodId).waiting_gate).toBe("approve-plan");
    expect(StudioBriefSchema.parse(readStageDocument(s.core, again.runId, "brief", "brief.json")).description).toBe("Sửa sau khi duyệt");
    expect(productionRnd(getProduction(s.db, prodId)!)!.direction.description).toBe("Sửa sau khi duyệt");
    expect(planRunView(s.core, s.db, prodId).stages.find((x) => x.key === "approve-rnd")!.reused).toBe(true);
  }, 120_000);

  it("Claude keeps the episode length the person typed (one repair round)", async () => {
    s = setup("rnd-ignore-hint-once");
    const prodId = seedMinimal(s, { target: 240, max: 2 });
    const { runId } = startPlanRun(s.core, s.db, prodId, { workflow: PLAN_V2 });
    await drain(s);
    expect(StudioRndSchema.parse(readStageDocument(s.core, runId, "rnd", "rnd.json")).direction.episode_target_seconds).toBe(240);
    const rounds = listLlmCalls(s.db, { productionId: prodId, page: 1, pageSize: 20 }).items.filter((c) => c.stage_key === "rnd");
    expect(rounds.map((c) => c.outcome).sort()).toEqual(["accepted", "rejected"]);
  }, 120_000);
});
