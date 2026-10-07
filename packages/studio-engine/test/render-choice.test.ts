import { describe, expect, it } from "vitest";
import { makeStudioFarmRecorder } from "@harness/executors";
import { defaultRenderMachine, renderChoiceFor, setRenderChoice } from "../src/index.js";
import { seedProduction, world } from "./helpers.js";

const T1 = "2026-10-06T10:00:00.000Z";
const T2 = "2026-10-06T11:00:00.000Z";

function seedEpisode(db: ReturnType<typeof world>["db"], prodId: string, id: string, idx: number, runId: string | null): void {
  db.run("INSERT INTO episodes (id, production_id, idx, title, hook, plan, run_id, created_at, updated_at) VALUES (?, ?, ?, 'T', 'h', '{}', ?, ?, ?)",
    [id, prodId, idx, runId, T1, T1]);
}

describe("render machine choice", () => {
  it("one choice per run and stage; a second choice replaces the first", () => {
    const { db } = world();
    const prod = seedProduction(db);
    seedEpisode(db, prod, "ep-1", 1, "run-1");
    expect(renderChoiceFor(db, "run-1", "render-final")).toBeNull();
    setRenderChoice(db, { runId: "run-1", stageKey: "render-final", machine: "nvenc", by: "auth0|a", now: T1 });
    expect(renderChoiceFor(db, "run-1", "render-final")).toBe("nvenc");
    setRenderChoice(db, { runId: "run-1", stageKey: "render-final", machine: "gpu", by: "auth0|b", now: T2 });
    expect(renderChoiceFor(db, "run-1", "render-final")).toBe("gpu");
    expect(renderChoiceFor(db, "run-1", "render-preview")).toBeNull();
    expect(db.all("SELECT * FROM studio_render_choices")).toEqual([
      { run_id: "run-1", stage_key: "render-final", production_id: prod, episode_id: "ep-1", machine: "gpu", node_id: null, node_name: null, chosen_by: "auth0|b", chosen_at: T2 },
    ]);
  });

  it("a choice belongs to an episode's run", () => {
    const { db } = world();
    seedProduction(db);
    expect(() => setRenderChoice(db, { runId: "run-nobody", stageKey: "render-final", machine: "any", by: "u", now: T1 })).toThrow(/episode/);
  });

  it("refuses a machine type it does not know", () => {
    const { db } = world();
    expect(() => setRenderChoice(db, { runId: "r", stageKey: "render-final", machine: "render-01" as never, by: "u", now: T1 })).toThrow();
    expect(db.all("SELECT * FROM studio_render_choices")).toEqual([]);
  });

  it("the default is the production's latest choice, else any", () => {
    const { db } = world();
    const a = seedProduction(db);
    const b = seedProduction(db, { id: "22222222-2222-4222-8222-222222222222" });
    seedEpisode(db, a, "ep-a1", 1, "run-a1");
    seedEpisode(db, a, "ep-a2", 2, "run-a2");
    seedEpisode(db, b, "ep-b1", 1, "run-b1");
    expect(defaultRenderMachine(db, a)).toBe("any");
    setRenderChoice(db, { runId: "run-a1", stageKey: "render-final", machine: "gpu", by: "u", now: T1 });
    setRenderChoice(db, { runId: "run-a2", stageKey: "render-final", machine: "nvenc", by: "u", now: T2 });
    setRenderChoice(db, { runId: "run-b1", stageKey: "render-final", machine: "any", by: "u", now: "2026-10-06T12:00:00.000Z" });
    expect(defaultRenderMachine(db, a)).toBe("nvenc");
    expect(defaultRenderMachine(db, b)).toBe("any");
  });

  it("the default follows an episode's earlier runs too (the episode now points at a newer run)", () => {
    const { db } = world();
    const a = seedProduction(db);
    seedEpisode(db, a, "ep-a1", 1, "run-new");
    setRenderChoice(db, { runId: "run-old", stageKey: "render-final", machine: "gpu", by: "u", now: T1, episodeId: "ep-a1" });
    expect(defaultRenderMachine(db, a)).toBe("gpu");
  });
});

describe("farm job recorder", () => {
  it("records the requirements sent and the episode of the run", async () => {
    const { db, dbPath } = world();
    const prod = seedProduction(db);
    seedEpisode(db, prod, "ep-1", 1, "run-ep");
    const rec = makeStudioFarmRecorder(dbPath);
    await rec({ farmJobId: "f-1", runId: "run-ep", stageKey: "render-final", attemptId: "att-1", productionId: prod, jobType: "studio.render_final", isFinalRender: true, requirements: { nvenc: true } });
    await rec({ farmJobId: "f-2", runId: "run-plan", stageKey: "x", attemptId: "att-2", productionId: prod, jobType: "studio.tts", isFinalRender: false, requirements: {} });
    const rows = db.all<{ farm_job_id: string; episode_id: string | null; requirements: string | null }>(
      "SELECT farm_job_id, episode_id, requirements FROM studio_farm_jobs ORDER BY farm_job_id");
    expect(rows).toEqual([
      { farm_job_id: "f-1", episode_id: "ep-1", requirements: '{"nvenc":true}' },
      { farm_job_id: "f-2", episode_id: null, requirements: "{}" },
    ]);
  });
});

describe("machineOfRequirements", () => {
  it("reads back the type a job was sent as", async () => {
    const { machineOfRequirements } = await import("../src/index.js");
    expect(machineOfRequirements("{}")).toBe("any");
    expect(machineOfRequirements('{"nvenc":true}')).toBe("nvenc");
    expect(machineOfRequirements('{"gpu":true}')).toBe("gpu");
    expect(machineOfRequirements(null)).toBeNull();
    expect(machineOfRequirements('{"gpu":true,"min_vram_mb":8000}')).toBeNull();
    expect(machineOfRequirements("not json")).toBeNull();
  });
});
