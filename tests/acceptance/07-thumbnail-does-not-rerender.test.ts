import { describe, expect, it } from "vitest";
import { hasFfmpeg } from "../media.js";
import { cli, drain, freshFootageProject, planFootage, runThroughEditPlan, status, submitGate } from "../integration/footage-helpers.js";

function ingestAndCreateContent(dir: string, source: string): { source_id: string; content_id: string } {
  const ingest = JSON.parse(cli(dir, ["source", "ingest", source, "--rights", "cleared", "--json"]).out) as { source_id: string };
  const created = JSON.parse(cli(dir, ["content", "create", "--title", "Sample", "--source", ingest.source_id, "--json"]).out) as { content_id: string };
  return { source_id: ingest.source_id, content_id: created.content_id };
}

// voice=original: no tts and no avatar stage, so the graph is index-source -> select-topic -> write-script
// -> edit-plan -> {cut, thumbnail-render} -> {assemble, thumbnail-qc}. Everything below edit-plan is
// expensive real ffmpeg work; the point of this acceptance is that only the four gates run the second time.
const OPTIONS = ["voice=original"];
const QC_PASS = JSON.stringify({ readable: true, on_brand: true, notes: "" });
const QC_REDO = JSON.stringify({ readable: true, on_brand: false, notes: "title crops on mobile" });
const REUSED_STAGES = ["index-source", "cut", "assemble", "thumbnail-render"];
const GATES = ["edit-plan", "select-topic", "thumbnail-qc", "write-script"];

describe.skipIf(!hasFfmpeg())("18.3 #7 changing the thumbnail QC does not re-render the video", () => {
  it("a second run of the same variant with identical upstream gates reuses the rendered video and only re-runs the gates", async () => {
    const { dir, source } = freshFootageProject();
    const { source_id: sourceId, content_id: contentId } = ingestAndCreateContent(dir, source);

    const runA = planFootage(dir, contentId, OPTIONS);
    drain(dir); // index-source runs; select-topic parks WAITING_HUMAN
    runThroughEditPlan(dir, runA, sourceId);
    drain(dir); // cut, thumbnail-render, assemble run; thumbnail-qc parks
    submitGate(dir, runA, "thumbnail-qc", { "qc-checklist.json": QC_PASS });
    drain(dir);

    const a = status(dir, runA);
    expect(a.run.state).toBe("SUCCEEDED");
    const episodeA = a.artifacts.find((x) => x.type === "episode_video" && x.status === "ACCEPTED")!;
    expect(episodeA).toBeDefined();

    // The human wants a different thumbnail QC verdict. They re-plan the same variant and re-submit the
    // three upstream gates with exactly the content they approved before.
    const runA2 = planFootage(dir, contentId, OPTIONS);
    drain(dir); // index-source comes from the cache at plan time; select-topic parks
    runThroughEditPlan(dir, runA2, sourceId); // byte-identical gate output
    drain(dir); // nothing to render: cut/thumbnail-render/assemble are settled from the cache at release

    const mid = status(dir, runA2);
    expect(mid.stages.find((s) => s.stage_key === "thumbnail-qc")?.state).toBe("WAITING_HUMAN");
    submitGate(dir, runA2, "thumbnail-qc", { "qc-checklist.json": QC_REDO }); // the one thing that changed
    drain(dir);

    const a2 = status(dir, runA2);
    expect(a2.run.state).toBe("SUCCEEDED");
    for (const key of REUSED_STAGES) {
      const st = a2.stages.find((s) => s.stage_key === key)!;
      expect(st.state, key).toBe("SUCCEEDED");
      expect(st.attempts, key).toEqual([]); // never dispatched: no ffmpeg ran for it
      expect(st.reused_artifact_ids?.length ?? 0, key).toBeGreaterThan(0);
    }
    expect(a2.stages.filter((s) => s.attempts.length > 0).map((s) => s.stage_key).sort()).toEqual(GATES);

    // A2's episode video *is* A's: the assemble stage points straight at the artifact A produced
    expect(a2.stages.find((s) => s.stage_key === "assemble")!.reused_artifact_ids).toEqual([episodeA.artifact_id]);
    const events = cli(dir, ["events", "tail", "--run", runA2, "--json", "--limit", "300"]).out;
    expect(JSON.parse(events).filter((e: { event_type: string; payload: { at?: string } }) => e.event_type === "stage.reused" && e.payload.at === "release")).toHaveLength(3);

    // Run A is untouched except for the QC checklist, the only gate whose bytes actually changed.
    const aFinal = status(dir, runA);
    expect(aFinal.artifacts.find((x) => x.artifact_id === episodeA.artifact_id)?.status).toBe("ACCEPTED");
    const qcStageRunId = aFinal.stages.find((s) => s.stage_key === "thumbnail-qc")!.stage_run_id;
    expect(aFinal.artifacts.filter((x) => x.status === "STALE").map((x) => x.stage_run_id)).toEqual([qcStageRunId]);
  }, 300_000);
});
