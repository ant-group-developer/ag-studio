import { describe, expect, it } from "vitest";
import { hasFfmpeg } from "../media.js";
import { SAMPLE_EDL, cli, drain, freshFootageProject, planFootage, status, submitGate } from "../integration/footage-helpers.js";

function ingestAndCreateContent(dir: string, source: string): { source_id: string; content_id: string } {
  const ingest = JSON.parse(cli(dir, ["source", "ingest", source, "--rights", "cleared", "--json"]).out) as { source_id: string };
  const created = JSON.parse(cli(dir, ["content", "create", "--title", "Sample", "--source", ingest.source_id, "--json"]).out) as { content_id: string };
  return { source_id: ingest.source_id, content_id: created.content_id };
}

interface EventRow { event_type: string; payload: { stale?: string[] } }

// voice=tts, avatar=none: index-source is the only stage with no upstream gate, so it is the one stage a
// change to select-topic must leave untouched. select-topic's transitive dependants over depends_on and
// depends_on_optional are write-script, edit-plan, tts, cut, assemble, thumbnail-render, thumbnail-qc.
const OPTIONS = ["voice=tts", "avatar=none"];

describe.skipIf(!hasFfmpeg())("18.3 #6 changing an early gate stales exactly its transitive downstream, nothing upstream and nothing twice", () => {
  it("A2's select-topic re-submit stales select-topic's dependants on A but leaves index-source ACCEPTED and reused; a later A2 gate that finds everything already stale invalidates nothing new", async () => {
    const { dir, source } = freshFootageProject();
    const { source_id: sourceId, content_id: contentId } = ingestAndCreateContent(dir, source);

    const runA = planFootage(dir, contentId, OPTIONS);
    drain(dir); // index-source runs; select-topic parks WAITING_HUMAN
    submitGate(dir, runA, "select-topic", { "topic.md": "# Sample topic\n" });
    drain(dir);
    submitGate(dir, runA, "write-script", { "narration.txt": "Line one.\nLine two.\nLine three.\n", "script.md": "# Script\n" });
    drain(dir);
    submitGate(dir, runA, "edit-plan", { "edl.json": SAMPLE_EDL(sourceId) });
    drain(dir); // tts, cut, assemble, thumbnail-render run; thumbnail-qc parks
    submitGate(dir, runA, "thumbnail-qc", { "qc-checklist.json": JSON.stringify({ readable: true, on_brand: true, notes: "" }) });
    drain(dir);
    const runAFinal = status(dir, runA);
    expect(runAFinal.run.state).toBe("SUCCEEDED");

    const indexSourceStage = runAFinal.stages.find((s) => s.stage_key === "index-source")!;
    const indexSourceArtifactIds = runAFinal.artifacts.filter((a) => a.stage_run_id === indexSourceStage.stage_run_id && a.status === "ACCEPTED").map((a) => a.artifact_id);
    expect(indexSourceArtifactIds.length).toBeGreaterThan(0); // shots.json + proxy.mp4

    // select-topic itself plus every transitive dependant (required or optional edge) in this graph
    const downstreamOfSelectTopic = new Set(["select-topic", "write-script", "edit-plan", "tts", "cut", "assemble", "thumbnail-render", "thumbnail-qc"]);
    const stageKeyByStageRunId = new Map(runAFinal.stages.map((s) => [s.stage_run_id, s.stage_key]));
    const expectedStaleIds = runAFinal.artifacts
      .filter((a) => a.status === "ACCEPTED" && downstreamOfSelectTopic.has(stageKeyByStageRunId.get(a.stage_run_id) ?? ""))
      .map((a) => a.artifact_id)
      .sort();
    expect(expectedStaleIds.length).toBeGreaterThan(0);

    const runA2 = planFootage(dir, contentId, OPTIONS); // same variant: content_id + profile + identical options
    drain(dir); // index-source comes from the cache; select-topic parks WAITING_HUMAN
    const a2AfterPlan = status(dir, runA2);
    const a2IndexSource = a2AfterPlan.stages.find((s) => s.stage_key === "index-source")!;
    expect(a2IndexSource.attempts).toEqual([]);
    expect([...(a2IndexSource.reused_artifact_ids ?? [])].sort()).toEqual(indexSourceArtifactIds.slice().sort());
    expect(a2AfterPlan.stages.find((s) => s.stage_key === "select-topic")?.state).toBe("WAITING_HUMAN");

    // submit A2's select-topic with byte-identical content to A's: `stage submit` commits synchronously, so
    // the invalidation this triggers is visible on A immediately, with no drain in between.
    submitGate(dir, runA2, "select-topic", { "topic.md": "# Sample topic\n" });

    const runAAfterFirstSubmit = status(dir, runA);
    const staleNow = runAAfterFirstSubmit.artifacts.filter((a) => a.status === "STALE").map((a) => a.artifact_id).sort();
    expect(staleNow).toEqual(expectedStaleIds);
    // index-source's own artifacts are untouched: they are neither in the affected set nor downstream of it
    expect(runAAfterFirstSubmit.artifacts.filter((a) => a.stage_run_id === indexSourceStage.stage_run_id).every((a) => a.status === "ACCEPTED")).toBe(true);

    const eventsAfterFirstSubmit = JSON.parse(cli(dir, ["events", "tail", "--run", runA2, "--json", "--limit", "200"]).out) as EventRow[];
    const invalidatedAfterFirst = eventsAfterFirstSubmit.filter((e) => e.event_type === "stage.invalidated_downstream");
    expect(invalidatedAfterFirst).toHaveLength(1);
    expect([...(invalidatedAfterFirst[0]!.payload.stale ?? [])].sort()).toEqual(expectedStaleIds);

    // continue A2: write-script's dependants (edit-plan, tts, cut, assemble, thumbnail-render, thumbnail-qc)
    // are a subset of what select-topic already staled on A, and write-script's own A artifact is already
    // STALE too — so this commit finds nothing left to invalidate. The controller only appends
    // stage.invalidated_downstream when it actually stales something (packages/core/src/orchestration/
    // controller.ts), so the event count on A2 must stay at 1, not grow to 2 with an empty `stale` array.
    drain(dir); // write-script parks WAITING_HUMAN for A2
    submitGate(dir, runA2, "write-script", { "narration.txt": "Completely different narration.\n", "script.md": "# Different script\n" });

    const eventsAfterSecondSubmit = JSON.parse(cli(dir, ["events", "tail", "--run", runA2, "--json", "--limit", "200"]).out) as EventRow[];
    const invalidatedAfterSecond = eventsAfterSecondSubmit.filter((e) => e.event_type === "stage.invalidated_downstream");
    expect(invalidatedAfterSecond).toHaveLength(1); // still just the one from the select-topic submit

    // and A's artifacts did not change shape: still exactly the same stale set as before
    const runAAfterSecondSubmit = status(dir, runA);
    expect(runAAfterSecondSubmit.artifacts.filter((a) => a.status === "STALE").map((a) => a.artifact_id).sort()).toEqual(expectedStaleIds);
  }, 300_000);
});
