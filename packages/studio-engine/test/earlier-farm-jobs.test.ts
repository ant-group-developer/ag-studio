import { describe, expect, it } from "vitest";
import { makeStudioFarmRecorder } from "@harness/executors";
import { earlierFarmJobs } from "../src/index.js";
import { seedProduction, world } from "./helpers.js";

describe("earlierFarmJobs", () => {
  it("the farm jobs other attempts of the same run and stage submitted, not this attempt's nor another stage's", async () => {
    const { db, dbPath } = world();
    const prod = seedProduction(db);
    const rec = makeStudioFarmRecorder(dbPath);
    const job = (farmJobId: string, runId: string, stageKey: string, attemptId: string) =>
      rec({ farmJobId, runId, stageKey, attemptId, productionId: prod, jobType: "studio.transcribe", isFinalRender: false, requirements: {} });
    await job("f-old", "run-1", "transcribe", "att-1");
    await job("f-older", "run-1", "transcribe", "att-0");
    await job("f-mine", "run-1", "transcribe", "att-2");
    await job("f-tts", "run-1", "tts", "att-3");
    await job("f-other-run", "run-2", "transcribe", "att-4");
    expect(earlierFarmJobs(db, { runId: "run-1", stageKey: "transcribe", attemptId: "att-2" }).sort()).toEqual(["f-old", "f-older"]);
    expect(earlierFarmJobs(db, { runId: "run-3", stageKey: "transcribe", attemptId: "att-9" })).toEqual([]);
  });
});
