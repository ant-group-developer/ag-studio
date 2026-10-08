/**
 * Series plan 3.2.0 in-process (fake Claude, fake ag-go, fake yt-dlp): the research with its web fallback, the style
 * learned from reference videos (or skipped, saying why), approved beside the trend report, carried by the brief.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SeriesPlanSchema, StudioResearchSchema, StudioRndSchema, StudioBrandingSchema, StudioStyleSchema, StudioWebFindsSchema, TrendReportSchema,
  type StudioResearch,
} from "@harness/contracts";
import {
  activeProductionStyle, createStudioWorker, getProduction, planRunView, productionStyle, readStageDocument, startPlanRun, submitStudioGate, ytDlp,
  type CutMediaDeps, type ResearchSource,
} from "../src/index.js";
import { hasFfmpeg } from "../../../tests/media.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

const PLAN_V32 = "ag-studio-series-plan@3.2.0";
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const FAKE_YTDLP = [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs")];

type Worker = ReturnType<typeof createStudioWorker>;
async function drain(worker: Worker, maxTicks = 400): Promise<void> {
  for (let i = 0; i < maxTicks; i++) if ((await worker.runOnce()) === "idle") return;
  throw new Error(`worker still busy after ${maxTicks} ticks`);
}

/** The YouTube API answering every channel and keyword: the reference channel has three long uploads. */
const apiResearch: ResearchSource = {
  async research(q): Promise<StudioResearch> {
    const video = (id: string) => ({ video_id: id, channel_id: "UCmei", channel_title: "Mei Time", title: `Video ${id}`, published_at: "2026-09-01T00:00:00Z",
      duration_s: 600, views: 9000, likes: null, comments: null, tags: ["travel"], views_per_day: 300, outlier: false });
    return {
      schema_version: "studio.research/v1", production_id: q.production_id, fetched_at: "2026-10-08T00:00:00Z", quota_units: 204, skipped_reason: null,
      channels: q.channels.map((c) => ({ input: c.url, role: c.role, channel_id: "UCmei", title: "Mei Time", subscribers: 1, error: null, stats: null,
        videos: [video("U_17EqTHUIo"), video("Q5itZPTiZ9g"), video("ZdLlMyEO-Sw")] })),
      keywords: q.keywords.map((keyword) => ({ keyword, error: null, videos: [video("U_17EqTHUIo")] })),
      insights: { top_title_terms: [], top_tags: [], duration_buckets: [], frequent_channels: [] },
    };
  },
};

function setup(o: { research?: ResearchSource; media?: boolean } = {}) {
  const w = world();
  const media = o.media ? ({ ffmpeg: FFMPEG, ffprobe: FFPROBE, voiceDir: join(w.dir, "voice") } as CutMediaDeps) : undefined;
  const worker = createStudioWorker({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(8, 30), farm: fakeFarm(w.bucket) as never,
    claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
    owner: "auth0|owner", thumbnails: fakeThumbnails(),
    ytdlp: ytDlp({ argv: FAKE_YTDLP, ...(o.media ? { ffmpeg: FFMPEG } : {}) }),
    ...(o.research ? { research: o.research } : {}),
    ...(media ? { media } : {}),
  });
  const prod = seedProduction(w.db, { episode_target_seconds: 600, max_episodes: 2 });
  w.db.run("UPDATE productions SET keywords = ?, youtube_channels = ? WHERE id = ?", [JSON.stringify(["kyoto vlog"]), JSON.stringify(["@meitime"]), prod]);
  return { ...w, worker, prod };
}

/** Approves each gate as proposed, in the order the run asks, until the plan is waiting for its approval. */
async function toApprovePlan(s: ReturnType<typeof setup>, runId: string): Promise<string[]> {
  const order: string[] = [];
  const doc: Record<string, [string, string, (v: unknown) => unknown]> = {
    "approve-trend-report": ["trend-report", "trend-report.json", (v) => TrendReportSchema.parse(v)],
    "approve-style": ["analyze-style", "style.json", (v) => StudioStyleSchema.parse(v)],
    "approve-rnd": ["rnd", "rnd.json", (v) => StudioRndSchema.parse(v)],
    "approve-branding": ["branding", "branding.json", (v) => StudioBrandingSchema.parse(v)],
  };
  for (let i = 0; i < 10; i++) {
    await drain(s.worker);
    const gate = planRunView(s.core, s.db, s.prod).waiting_gate;
    if (!gate || gate === "approve-plan") break;
    order.push(gate);
    const [stage, file, parse] = doc[gate]!;
    await submitStudioGate(s.core, s.db, runId, gate, parse(readStageDocument(s.core, runId, stage, file)));
  }
  expect(planRunView(s.core, s.db, s.prod).waiting_gate).toBe("approve-plan");
  SeriesPlanSchema.parse(readStageDocument(s.core, runId, "plan-episodes", "series-plan.json"));
  return order;
}

describe(PLAN_V32, () => {
  let s: ReturnType<typeof setup>;
  afterEach(() => s?.core.close());

  it("no YouTube key: Claude finds the links on the web, yt-dlp reads their numbers; no ffmpeg: the style is skipped, saying why", async () => {
    s = setup();
    const { runId } = startPlanRun(s.core, s.db, s.prod, { workflow: PLAN_V32 });
    const gates = await toApprovePlan(s, runId);
    expect(gates).toEqual(["approve-trend-report", "approve-style", "approve-rnd", "approve-branding"]);

    const finds = StudioWebFindsSchema.parse(readStageDocument(s.core, runId, "research-web", "web-finds.json"));
    expect(finds.skipped).toBe(false);
    const research = StudioResearchSchema.parse(readStageDocument(s.core, runId, "research", "research.json"));
    expect(research.source).toBe("web");
    expect(research.channels[0]!.videos.map((v) => v.video_id)).toEqual(expect.arrayContaining(["fake0000001"]));
    expect(research.channels[0]!.videos.every((v) => v.views === 12345 && !v.estimated)).toBe(true);
    expect(TrendReportSchema.parse(readStageDocument(s.core, runId, "trend-report", "trend-report.json")).skipped).toBe(false);

    const style = productionStyle(getProduction(s.db, s.prod)!);
    expect(style).toMatchObject({ skipped: true });
    expect(style!.skipped_reason).toMatch(/ffmpeg/);
    expect(activeProductionStyle(getProduction(s.db, s.prod)!)).toBeNull();
  }, 120_000);

  it.skipIf(!hasFfmpeg())("the API answers everything (no web call); the reference videos are watched and the style reaches the plan", async () => {
    s = setup({ research: apiResearch, media: true });
    const { runId } = startPlanRun(s.core, s.db, s.prod, { workflow: PLAN_V32 });
    await toApprovePlan(s, runId);

    expect(StudioWebFindsSchema.parse(readStageDocument(s.core, runId, "research-web", "web-finds.json")).skipped).toBe(true);
    const research = StudioResearchSchema.parse(readStageDocument(s.core, runId, "research", "research.json"));
    expect(research.quota_units).toBe(204);
    expect(research.source).toBeUndefined();

    const style = activeProductionStyle(getProduction(s.db, s.prod)!);
    expect(style?.references.map((r) => r.video_id).sort()).toEqual(["Q5itZPTiZ9g", "U_17EqTHUIo", "ZdLlMyEO-Sw"]);
    expect(style?.measured?.shot_seconds.median).toBe(2);
    expect(StudioStyleSchema.parse(readStageDocument(s.core, runId, "brief", "style.json")).name).toBe(style!.name);
    // the plan was written with the style in front of Claude
    const planStage = s.core.store.listStageRuns(runId).find((x) => x.stage_key === "plan-episodes")!;
    const attempt = s.core.store.listAttempts(planStage.stage_run_id).at(-1)!;
    const prompts = readFileSync(join(fileURLToPath(attempt.workspace_uri), "logs", "fake-claude-prompts.log"), "utf8");
    expect(prompts).toContain("## studio_style (style.json)");
  }, 180_000);
});
