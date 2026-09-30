import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { layoutTimeline, timelineIssues } from "@harness/core";
import { TimelineV2Schema, TreatmentSchema } from "@harness/contracts";
import {
  cancelRun, createStudioWorker, latestRevision, readStageDocument, resumeRunFrom, runView, startRun, STUDIO_FLOWS, studioFlowFrom, submitStudioGate,
} from "../src/index.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, ROOT, seedProduction, world } from "./helpers.js";

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as never;

async function drive(worker: { runOnce(): Promise<string> }, until: () => boolean, max = 60, show?: () => unknown): Promise<void> {
  for (let i = 0; i < max && !until(); i++) await worker.runOnce();
  if (!until()) throw new Error(`workflow did not reach the expected state${show ? `: ${JSON.stringify(show())}` : ""}`);
}

describe("studioFlowFrom", () => {
  it("reads the flow name or its workflow ref, defaults to narrated, refuses anything else", () => {
    expect(studioFlowFrom(undefined)).toBe("narrated");
    expect(studioFlowFrom(" ")).toBe("narrated");
    expect(studioFlowFrom("montage")).toBe("montage");
    expect(studioFlowFrom(STUDIO_FLOWS.montage.workflow)).toBe("montage");
    expect(studioFlowFrom(STUDIO_FLOWS.narrated.workflow)).toBe("narrated");
    expect(() => studioFlowFrom("ag-studio-montage@9.9.9")).toThrow(/not a Studio flow/);
  });
});

describe("ag-studio-montage@1.0.0 end to end (fake Claude, fake ag-go, fake farm)", () => {
  it("cuts the chosen footage together: no narration, no TTS, beats last their treatment seconds, footage keeps its sound", async () => {
    const w = world({ flow: "montage" });
    const prod = seedProduction(w.db);
    const farm = fakeFarm(w.bucket);
    const worker = createStudioWorker({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(), farm: farm as never, owner: "t", logger: silent, farmPollMs: 1,
      claude: { skillsDir: join(ROOT, "skills"), argv: [process.execPath, FAKE_CLAUDE], baseEnv: { ...process.env, FAKE_STUDIO_MODE: "ok" } },
    });
    const view = () => runView(w.core, w.db, prod);
    const show = () => [view().state, view().stages.map((s) => [s.key, s.state, s.attempts, s.error?.slice(0, 160)])];

    startRun(w.core, w.db, prod);
    expect(view().stages.map((s) => s.key)).toEqual([
      "intake", "catalog", "treatment", "approve-treatment", "select-shots", "shot-board", "build-timeline", "edit", "render-final", "export",
    ]);
    await drive(worker, () => view().waiting_gate === "approve-treatment", 60, show);
    const treatment = TreatmentSchema.parse(readStageDocument(w.core, w.db, prod, "treatment", "treatment.json"));
    await submitStudioGate(w.core, w.db, prod, "approve-treatment", treatment);
    await drive(worker, () => view().waiting_gate === "shot-board", 60, show);
    await submitStudioGate(w.core, w.db, prod, "shot-board", readStageDocument(w.core, w.db, prod, "select-shots", "selection.json"));

    // straight from the shot board to the editor: nothing went to the farm for a voice
    await drive(worker, () => view().waiting_gate === "edit", 60, show);
    expect([...farm.jobs.values()].map((j) => j.type)).toEqual([]);
    const draft = latestRevision(w.db, prod)!.data;
    expect(draft.narration).toEqual([]);
    expect(draft.source_audio.muted).toBe(false);
    expect(timelineIssues(draft).filter((i) => i.severity === "error")).toEqual([]);
    const beats = layoutTimeline(draft).beats;
    for (const tb of treatment.beats) {
      const laid = beats.find((b) => b.beat_id === tb.beat_id)!;
      expect(laid.duration, tb.beat_id).toBeCloseTo(tb.seconds, 1);
    }

    await submitStudioGate(w.core, w.db, prod, "edit");
    await drive(worker, () => view().state === "SUCCEEDED", 60, show);
    expect([...farm.jobs.values()].map((j) => j.type)).toEqual(["studio.render_final"]);
    const exp = readStageDocument(w.core, w.db, prod, "export", "export.json") as { files: { kind: string }[] };
    expect(exp.files.map((f) => f.kind).sort()).toEqual(["mp4", "srt", "timeline", "vtt"]);
    expect(TimelineV2Schema.parse(readStageDocument(w.core, w.db, prod, "edit", "timeline.json")).narration).toEqual([]);
  });

  it("a resumed montage run stays a montage run even when new runs are narrated", async () => {
    const w = world({ flow: "montage" });
    const prod = seedProduction(w.db);
    const farm = fakeFarm(w.bucket, { badFinalRenders: 1 });
    const worker = createStudioWorker({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(), farm: farm as never, owner: "t", logger: silent, farmPollMs: 1,
      claude: { skillsDir: join(ROOT, "skills"), argv: [process.execPath, FAKE_CLAUDE], baseEnv: { ...process.env, FAKE_STUDIO_MODE: "ok" } },
    });
    const view = () => runView(w.core, w.db, prod);
    const show = () => [view().state, view().stages.map((s) => [s.key, s.state, s.attempts, s.error?.slice(0, 160)])];
    startRun(w.core, w.db, prod);
    await drive(worker, () => view().waiting_gate === "approve-treatment", 60, show);
    await submitStudioGate(w.core, w.db, prod, "approve-treatment", readStageDocument(w.core, w.db, prod, "treatment", "treatment.json"));
    await drive(worker, () => view().waiting_gate === "shot-board", 60, show);
    await submitStudioGate(w.core, w.db, prod, "shot-board", readStageDocument(w.core, w.db, prod, "select-shots", "selection.json"));
    await drive(worker, () => view().waiting_gate === "edit", 60, show);
    await submitStudioGate(w.core, w.db, prod, "edit");
    await drive(worker, () => view().stages.find((s) => s.key === "render-final")!.state === "WAITING_HUMAN", 60, show);
    cancelRun(w.core, w.db, prod);
    await drive(worker, () => view().state === "CANCELLED", 60, show);

    (w.core as { flow: string }).flow = "narrated"; // the setting changed in between
    const { reused } = resumeRunFrom(w.core, w.db, prod, "render-final");
    expect(view().stages.map((s) => s.key)).not.toContain("tts");
    expect(reused).toEqual(expect.arrayContaining(["intake", "treatment", "select-shots", "build-timeline", "edit"]));
    await drive(worker, () => view().state === "SUCCEEDED", 60, show);
    expect([...farm.jobs.values()].map((j) => j.type)).toEqual(["studio.render_final", "studio.render_final"]);
  });
});
