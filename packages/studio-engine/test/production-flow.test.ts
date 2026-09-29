import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setLineAudio, setLineText, replaceClipSegment, moveBeat, timelineIssues } from "@harness/core";
import { SelectionSchema, TimelineV2Schema, TreatmentSchema, type TimelineV2 } from "@harness/contracts";
import {
  createStudioWorker, latestRevision, pollEditorJob, readStageDocument, RevisionConflictError, runView, saveTimeline, startLineTts,
  cancelRun, resumeRunFrom, retryStage, startPreview, startRun, StudioRunError, submitStudioGate,
} from "../src/index.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, ROOT, seedProduction, world } from "./helpers.js";

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as never;

async function drive(worker: { runOnce(): Promise<string> }, until: () => boolean, max = 60, show?: () => unknown): Promise<void> {
  for (let i = 0; i < max && !until(); i++) await worker.runOnce();
  if (!until()) throw new Error(`workflow did not reach the expected state${show ? `: ${JSON.stringify(show())}` : ""}`);
}

describe("ag-studio-production@1.0.0 end to end (fake Claude, fake ag-go, fake farm)", () => {
  it("runs brief -> gates -> editor revisions -> final render -> MP4 + SRT export", async () => {
    const w = world();
    const prod = seedProduction(w.db);
    const footage = fakeFootage();
    const farm = fakeFarm(w.bucket);
    const worker = createStudioWorker({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage, farm: farm as never, owner: "test-worker", logger: silent, farmPollMs: 1,
      claude: { skillsDir: join(ROOT, "skills"), argv: [process.execPath, FAKE_CLAUDE], baseEnv: { ...process.env, FAKE_STUDIO_MODE: "select-bad-once" } },
    });
    const view = () => runView(w.core, w.db, prod);
    const stage = (k: string) => view().stages.find((s) => s.key === k)!;

    const { runId } = startRun(w.core, w.db, prod);
    expect(() => startRun(w.core, w.db, prod)).toThrow(StudioRunError); // one active run per production

    // intake -> catalog -> treatment, then the first gate waits for a person
    await drive(worker, () => view().waiting_gate === "approve-treatment");
    expect(footage.calls).toEqual([{ actAs: "auth0|owner", folderIds: ["folder-a"] }]);
    const treatment = TreatmentSchema.parse(readStageDocument(w.core, w.db, prod, "treatment", "treatment.json"));
    // a refused edit comes back with the checker's problems and leaves the gate waiting
    const badTreatment = { ...treatment, beats: treatment.beats.map((b) => ({ ...b, seconds: b.seconds * 3 })) };
    await expect(submitStudioGate(w.core, w.db, prod, "approve-treatment", badTreatment)).rejects.toMatchObject({ code: "rejected" });
    expect(stage("approve-treatment").state).toBe("WAITING_HUMAN");
    treatment.beats[0]!.purpose = "Mở đầu (người dùng sửa)";
    await submitStudioGate(w.core, w.db, prod, "approve-treatment", treatment);

    // select-shots: the fake Claude answers wrong once and is repaired within the same attempt
    await drive(worker, () => view().waiting_gate === "shot-board");
    expect(stage("select-shots").attempts).toBe(1);
    const selection = SelectionSchema.parse(readStageDocument(w.core, w.db, prod, "select-shots", "selection.json"));
    expect(selection.beats[0]!.picks.every((p) => p.segment_id.startsWith("00000000-"))).toBe(true);
    // shot board: swap one pick for its first alternate
    const b0 = selection.beats[0]!;
    const swapped = { ...selection, beats: [{ ...b0, picks: [b0.alternates[0]!, ...b0.picks.slice(1)], alternates: [b0.picks[0]!, ...b0.alternates.slice(1)] }, ...selection.beats.slice(1)] };
    await submitStudioGate(w.core, w.db, prod, "shot-board", swapped);

    // narration -> tts (farm) -> build-timeline, then the editor gate
    await drive(worker, () => view().waiting_gate === "edit");
    expect([...farm.jobs.values()].map((j) => j.type)).toEqual(["studio.tts"]);
    const rev1 = latestRevision(w.db, prod)!;
    expect(rev1.revision).toBe(1);
    expect(timelineIssues(rev1.data).filter((i) => i.severity === "error")).toEqual([]);
    expect(rev1.data.clips[0]!.segment_id).toBe(b0.alternates[0]!.segment_id); // the shot-board swap made it in
    for (const l of rev1.data.narration) expect(w.bucket.objects.has(`productions/${prod}/${l.audio!.key}`)).toBe(true);

    // editor: autosave on top of revision 1, then a stale save conflicts
    let t: TimelineV2 = moveBeat(rev1.data, 0, 1);
    const alt = rev1.data.alternates[rev1.data.clips[1]!.beat_id]![0]!;
    t = replaceClipSegment(t, rev1.data.clips[1]!.clip_id, alt.segment_id);
    const saved = saveTimeline(w.db, prod, { baseRevision: 1, data: t, authorId: "auth0|editor" });
    expect(saved.revision).toBe(2);
    expect(() => saveTimeline(w.db, prod, { baseRevision: 1, data: t, authorId: "auth0|other" })).toThrow(RevisionConflictError);

    // editing one sentence re-synthesizes only that sentence
    const line = t.narration[0]!;
    t = setLineText(t, line.line_id, "Câu mới do biên tập viên sửa");
    expect(timelineIssues(t).map((i) => i.code)).toContain("narration_not_voiced");
    const job = await startLineTts({ db: w.db, bucket: w.bucket, farm: farm as never }, { productionId: prod, lineId: line.line_id, text: "Câu mới do biên tập viên sửa", userId: "auth0|editor" });
    const done = await pollEditorJob({ db: w.db, bucket: w.bucket, farm: farm as never }, prod, job.id);
    expect(done.status).toBe("completed");
    const ttsJob = [...farm.jobs.values()].at(-1)!;
    expect((ttsJob.payload.lines as unknown[]).length).toBe(1);
    // two sentences re-voiced at once: each job reads its own tts.json, neither is told to "run it again"
    const other = t.narration[1]!;
    const deps = { db: w.db, bucket: w.bucket, farm: farm as never };
    const a = await startLineTts(deps, { productionId: prod, lineId: line.line_id, text: "Câu thứ nhất sửa lại", userId: "auth0|editor" });
    const b = await startLineTts(deps, { productionId: prod, lineId: other.line_id, text: "Câu thứ hai sửa lại cùng lúc", userId: "auth0|editor" });
    const [aDone, bDone] = [await pollEditorJob(deps, prod, a.id), await pollEditorJob(deps, prod, b.id)];
    expect([aDone.status, bDone.status]).toEqual(["completed", "completed"]);
    expect([aDone.result!.line_id, bDone.result!.line_id]).toEqual([line.line_id, other.line_id]);
    t = setLineAudio(t, line.line_id, "Câu mới do biên tập viên sửa", { key: String(done.result!.key), duration: Number(done.result!.duration) });
    expect(saveTimeline(w.db, prod, { baseRevision: 2, data: t, authorId: "auth0|editor" }).revision).toBe(3);

    // render preview of the saved revision
    const pv = await startPreview({ db: w.db, bucket: w.bucket, farm: farm as never }, { productionId: prod, revision: 3, userId: "auth0|editor" });
    const pvDone = await pollEditorJob({ db: w.db, bucket: w.bucket, farm: farm as never }, prod, pv.id);
    expect(pvDone.status).toBe("completed");
    expect(pvDone.url).toContain(`previews/${pv.id}.mp4`);

    // finish editing: the latest revision is what the gate gets
    await submitStudioGate(w.core, w.db, prod, "edit");
    const submitted = TimelineV2Schema.parse(readStageDocument(w.core, w.db, prod, "edit", "timeline.json"));
    expect(submitted.narration[0]!.text).toBe("Câu mới do biên tập viên sửa");

    // render-final (+qc) -> export
    await drive(worker, () => view().state === "SUCCEEDED");
    const exp = readStageDocument(w.core, w.db, prod, "export", "export.json") as { files: { kind: string; key: string }[] };
    expect(exp.files.map((f) => f.kind).sort()).toEqual(["mp4", "srt", "timeline", "vtt"]);
    for (const f of exp.files) expect(w.bucket.objects.has(f.key), f.key).toBe(true);
    const srt = w.bucket.objects.get(exp.files.find((f) => f.kind === "srt")!.key)!.toString("utf8");
    expect(srt).toMatch(/^1\n00:00:0\d,\d{3} --> 00:00:\d\d,\d{3}\n/);
    expect(srt).toContain("Câu mới do biên tập viên sửa");
    const final = [...farm.jobs.values()].find((j) => j.type === "studio.render_final")!;
    expect(final.payload.revision).toBe(3);
    expect(view().stages.every((s) => s.state === "SUCCEEDED")).toBe(true);
    expect(runId).toBe(view().run_id);
  });

  it("a run that ended at render-final resumes from there, keeping Claude's documents and the gates", async () => {
    const w = world();
    const prod = seedProduction(w.db);
    const farm = fakeFarm(w.bucket, { badFinalRenders: 1 });
    const worker = createStudioWorker({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(), farm: farm as never, owner: "t", logger: silent, farmPollMs: 1,
      claude: { skillsDir: join(ROOT, "skills"), argv: [process.execPath, FAKE_CLAUDE], baseEnv: { ...process.env, FAKE_STUDIO_MODE: "ok" } },
    });
    const view = () => runView(w.core, w.db, prod);
    const show = () => [view().state, view().stages.map((s) => [s.key, s.state, s.attempts, s.error?.slice(0, 160)])];
    const { runId: first } = startRun(w.core, w.db, prod);
    await drive(worker, () => view().waiting_gate === "approve-treatment");
    await submitStudioGate(w.core, w.db, prod, "approve-treatment", readStageDocument(w.core, w.db, prod, "treatment", "treatment.json"));
    await drive(worker, () => view().waiting_gate === "shot-board");
    await submitStudioGate(w.core, w.db, prod, "shot-board", readStageDocument(w.core, w.db, prod, "select-shots", "selection.json"));
    await drive(worker, () => view().waiting_gate === "edit");
    await submitStudioGate(w.core, w.db, prod, "edit");
    // a broken manifest parks render-final for a person; they give up on this run
    await drive(worker, () => view().stages.find((s) => s.key === "render-final")!.state === "WAITING_HUMAN", 60, show);
    expect(() => resumeRunFrom(w.core, w.db, prod, "render-final")).toThrow(StudioRunError); // the run is still live
    cancelRun(w.core, w.db, prod);
    await drive(worker, () => view().state === "CANCELLED", 60, show);
    // the old way out only works on a live run
    expect(() => retryStage(w.core, w.db, prod, "render-final")).toThrow(StudioRunError);
    const treatmentBefore = readStageDocument(w.core, w.db, prod, "treatment", "treatment.json");

    const { runId, reused } = resumeRunFrom(w.core, w.db, prod, "render-final");
    expect(runId).not.toBe(first);
    expect(reused).toEqual(expect.arrayContaining(["intake", "treatment", "approve-treatment", "select-shots", "shot-board", "narration", "tts", "build-timeline", "edit"]));
    expect(reused).not.toContain("render-final");
    expect(() => resumeRunFrom(w.core, w.db, prod, "render-final")).toThrow(StudioRunError); // the new run is live
    await drive(worker, () => view().state === "SUCCEEDED", 60, show);

    // nothing before render-final ran again: no Claude attempt, no gate waited, one TTS job in all
    for (const s of view().stages.filter((x) => x.key !== "render-final" && x.key !== "export")) expect(s.attempts, s.key).toBe(0);
    expect(readStageDocument(w.core, w.db, prod, "treatment", "treatment.json")).toEqual(treatmentBefore);
    expect([...farm.jobs.values()].map((j) => j.type)).toEqual(["studio.tts", "studio.render_final", "studio.render_final"]);
    const exp = readStageDocument(w.core, w.db, prod, "export", "export.json") as { files: { kind: string }[] };
    expect(exp.files.map((f) => f.kind)).toContain("mp4");
  });

  it("a selection that is still invalid after the repair round parks select-shots for a person", async () => {
    const w = world();
    const prod = seedProduction(w.db);
    const worker = createStudioWorker({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(), farm: fakeFarm(w.bucket) as never, owner: "t", logger: silent,
      claude: { skillsDir: join(ROOT, "skills"), argv: [process.execPath, FAKE_CLAUDE], baseEnv: { ...process.env, FAKE_STUDIO_MODE: "select-bad-always" } },
    });
    startRun(w.core, w.db, prod);
    const view = () => runView(w.core, w.db, prod);
    await drive(worker, () => view().waiting_gate === "approve-treatment");
    await submitStudioGate(w.core, w.db, prod, "approve-treatment", readStageDocument(w.core, w.db, prod, "treatment", "treatment.json"));
    await drive(worker, () => view().stages.find((s) => s.key === "select-shots")!.state === "WAITING_HUMAN");
    const s = view().stages.find((x) => x.key === "select-shots")!;
    expect(s.error).toMatch(/still invalid after one repair round/);
    expect(view().state).toBe("WAITING");
    const ws = w.core.store.listAttempts(w.core.store.listStageRuns(view().run_id).find((x) => x.stage_key === "select-shots")!.stage_run_id)[0]!.workspace_uri!;
    expect(existsSync(join(new URL(ws).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "logs", "fake-claude-prompts.log"))).toBe(true);
    expect(readFileSync(join(new URL(ws).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "logs", "fake-claude-prompts.log"), "utf8")).toContain("[unknown_segment]");
  });
});
