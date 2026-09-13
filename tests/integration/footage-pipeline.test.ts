import { describe, expect, it } from "vitest";
import { hasFfmpeg } from "../media.js";
import { SqliteStateStore } from "@harness/core";
import { join } from "node:path";
import { cli, cliAsync, drain, freshFootageProject, planFootage, runThroughEditPlan, setGpuCapacity, stageId, status, submitGate } from "./footage-helpers.js";

function ingestAndCreateContent(dir: string, source: string): { source_id: string; content_id: string } {
  const ingest = JSON.parse(cli(dir, ["source", "ingest", source, "--rights", "cleared", "--json"]).out) as { source_id: string };
  const created = JSON.parse(cli(dir, ["content", "create", "--title", "Sample", "--source", ingest.source_id, "--json"]).out) as { content_id: string };
  return { source_id: ingest.source_id, content_id: created.content_id };
}

describe.skipIf(!hasFfmpeg())("footage-production on the fixture ops project", () => {
  it("runs two variants to an ACCEPTED full-episode.mp4, gates through stage submit, gpu:1 serialises tts", async () => {
    const { dir, source } = freshFootageProject();
    expect(cli(dir, ["doctor"]).code).toBe(0);
    const { source_id: sourceId, content_id: contentId } = ingestAndCreateContent(dir, source);

    const runA = planFootage(dir, contentId, ["voice=tts", "avatar=heygen"]);
    const runB = planFootage(dir, contentId, ["voice=original"]);

    drain(dir); // index-source for both -> select-topic gates park
    for (const run of [runA, runB]) runThroughEditPlan(dir, run, sourceId);

    drain(dir); // tts, avatar, cut, assemble, thumbnail-render run; thumbnail-qc parks at WAITING_HUMAN
    for (const run of [runA, runB]) {
      expect(status(dir, run).stages.find((s) => s.stage_key === "assemble")?.state).toBe("SUCCEEDED");
      submitGate(dir, run, "thumbnail-qc", { "qc-checklist.json": JSON.stringify({ readable: true, on_brand: true, notes: "" }) });
      drain(dir);
      const s = status(dir, run);
      expect(s.run.state).toBe("SUCCEEDED");
      const episode = s.artifacts.find((a) => a.type === "episode_video" && a.status === "ACCEPTED")!;
      expect(episode.lineage.source_items).toEqual([sourceId]);
      for (const st of s.stages) expect(st.attempts.filter((a) => a.state === "SUCCEEDED"), st.stage_key).toHaveLength(1);
    }

    expect(status(dir, runB).stages.map((s) => s.stage_key)).not.toContain("tts");
    expect(status(dir, runA).stages.map((s) => s.stage_key)).toEqual(expect.arrayContaining(["tts", "avatar"]));
    expect(status(dir, runA).artifacts.some((a) => a.type === "avatar_clips" && a.status === "ACCEPTED")).toBe(true);

    const runAIndexSourceStageRunId = stageId(dir, runA, "index-source");
    const runAEpisode = status(dir, runA).artifacts.find((a) => a.type === "episode_video" && a.status === "ACCEPTED")!;

    // re-plan A: index-source comes from the cache, every gate runs again
    const runA2 = planFootage(dir, contentId, ["voice=tts", "avatar=heygen"]);
    drain(dir);
    const a2 = status(dir, runA2);
    expect(a2.stages.find((s) => s.stage_key === "index-source")).toMatchObject({ state: "SUCCEEDED", attempts: [] });
    expect(a2.stages.find((s) => s.stage_key === "select-topic")?.state).toBe("WAITING_HUMAN");
    expect(cli(dir, ["events", "tail", "--run", runA2, "--json", "--limit", "200"]).out).toContain("stage.reused");

    // A2 re-run: submit every gate again with the same contents as A. A fresh gate submission mints a brand
    // new artifact row, but the bytes are identical — so nothing of A is invalidated (content-aware
    // invalidation) and every script stage below the gates computes the very cache key it already carries on
    // A and is settled from the cache at release instead of recomputed. Only the four gates actually run.
    runThroughEditPlan(dir, runA2, sourceId);
    drain(dir);
    expect(status(dir, runA2).stages.find((s) => s.stage_key === "assemble")?.state).toBe("SUCCEEDED");
    submitGate(dir, runA2, "thumbnail-qc", { "qc-checklist.json": JSON.stringify({ readable: true, on_brand: true, notes: "" }) });
    drain(dir);

    const a2Final = status(dir, runA2);
    expect(a2Final.run.state).toBe("SUCCEEDED");
    for (const key of ["index-source", "cut", "assemble", "thumbnail-render", "tts", "avatar"]) {
      const st = a2Final.stages.find((s) => s.stage_key === key)!;
      expect(st.attempts, key).toEqual([]);
      expect(st.reused_artifact_ids?.length ?? 0, key).toBeGreaterThan(0);
    }
    expect(a2Final.stages.filter((s) => s.attempts.length > 0).map((s) => s.stage_key).sort()).toEqual(["edit-plan", "select-topic", "thumbnail-qc", "write-script"]);
    // A2's episode video is A's artifact, not a re-render of it
    expect(a2Final.stages.find((s) => s.stage_key === "assemble")!.reused_artifact_ids).toEqual([runAEpisode.artifact_id]);

    const runAAfterA2 = status(dir, runA);
    const runAIndexSourceArtifacts = runAAfterA2.artifacts.filter((a) => a.stage_run_id === runAIndexSourceStageRunId);
    expect(runAIndexSourceArtifacts.length).toBeGreaterThan(0);
    expect(runAAfterA2.artifacts.every((a) => a.status === "ACCEPTED")).toBe(true); // identical bytes everywhere: nothing of A was superseded
  }, 300_000);

  it("gpu: 1 — two tts stages never overlap", async () => {
    const { dir, source } = freshFootageProject();
    const { content_id: contentId } = ingestAndCreateContent(dir, source);

    // Two runs of the same content: different variants (subtitles differs, which no `when` clause reads,
    // so the stage graph is identical) so the two runs never invalidate each other's artifacts — the
    // invalidation rule marks an earlier run's artifacts of the same stage STALE once a later run of the
    // *same* variant commits a new one, which would otherwise wipe run A's write-script output the moment
    // run B's write-script commits.
    const runA = planFootage(dir, contentId, ["voice=tts"]);
    const runB = planFootage(dir, contentId, ["voice=tts", "subtitles=true"]);

    // index-source for both, then park both select-topic gates: nothing needs the gpu yet, so a plain
    // drain-to-idle is safe here.
    drain(dir);
    for (const run of [runA, runB]) expect(status(dir, run).stages.find((s) => s.stage_key === "select-topic")?.state).toBe("WAITING_HUMAN");

    // Submitting select-topic only releases write-script to READY (unclaimed); draining now just parks
    // both write-script gates, still before anything needs the gpu.
    for (const run of [runA, runB]) submitGate(dir, run, "select-topic", { "topic.md": "# Sample topic\n" });
    drain(dir);
    for (const run of [runA, runB]) expect(status(dir, run).stages.find((s) => s.stage_key === "write-script")?.state).toBe("WAITING_HUMAN");

    // Submitting write-script releases both tts (needs the gpu) and edit-plan (doesn't) to READY at once.
    // Starve the gpu resource down to 0 first so a plain drain can safely park both edit-plan gates without
    // a worker jumping ahead and executing either tts stage early (claim() skips a resource-starved
    // candidate and falls through to the next ready one, regardless of queue position).
    setGpuCapacity(dir, 0);
    for (const run of [runA, runB]) submitGate(dir, run, "write-script", { "narration.txt": "Line one.\nLine two.\nLine three.\n", "script.md": "# Script\n" });
    drain(dir);
    for (const run of [runA, runB]) expect(status(dir, run).stages.find((s) => s.stage_key === "edit-plan")?.state).toBe("WAITING_HUMAN");
    for (const run of [runA, runB]) expect(status(dir, run).stages.find((s) => s.stage_key === "tts")?.state).toBe("READY");
    setGpuCapacity(dir, 1);

    const env = { FAKE_TTS_SLEEP_MS: "1500" };
    const first = cliAsync(dir, ["worker", "--once", "--owner", "w1"], env);
    await new Promise((r) => setTimeout(r, 200));
    const second = cliAsync(dir, ["worker", "--once", "--owner", "w2"], env);
    const results = await Promise.all([first, second]);
    expect(results.every((r) => r.code === 0)).toBe(true);
    expect(results.filter((r) => r.out.includes("done"))).toHaveLength(1);
    expect(results.filter((r) => r.out.includes("idle"))).toHaveLength(1);

    const held = JSON.parse(cli(dir, ["resources", "status", "--json"]).out) as { resource: string; held: number }[];
    expect(held.find((r) => r.resource === "gpu")?.held).toBe(0);

    drain(dir); // the loser's tts runs now that the gpu is free
    expect(status(dir, runA).stages.find((s) => s.stage_key === "tts")?.state).toBe("SUCCEEDED");
    expect(status(dir, runB).stages.find((s) => s.stage_key === "tts")?.state).toBe("SUCCEEDED");
  }, 300_000);

  it("avatar that loses the connection lands in NEEDS_RECONCILIATION; reconcile then retry works with the journaled op", async () => {
    const { dir, source } = freshFootageProject();
    const { source_id: sourceId, content_id: contentId } = ingestAndCreateContent(dir, source);

    const run = planFootage(dir, contentId, ["voice=original", "avatar=heygen"]);
    drain(dir);
    runThroughEditPlan(dir, run, sourceId);

    drain(dir, { FAKE_HEYGEN_LOSE: "1" }); // cut also runs here; avatar dispatches, loses the connection
    expect(status(dir, run).stages.find((s) => s.stage_key === "avatar")?.state).toBe("NEEDS_RECONCILIATION");

    const reconcileReport = JSON.parse(cli(dir, ["reconcile", run, "--json"]).out) as { operation_id: string; status: string; stage_key: string; stageState: string }[];
    expect(reconcileReport).toHaveLength(1);
    expect(reconcileReport[0]?.status).toBe("FAILED"); // the FakeProvider in this process never dispatched the wrapper's operation
    expect(reconcileReport[0]?.stage_key).toBe("avatar");

    // `reconcile` itself already released the stage back to READY once every NEEDS_RECONCILIATION op on it
    // resolved (found or not); `retry --stage avatar` is a no-op in that case ("nothing to retry") and is
    // exactly the escape hatch a human would reach for if it hadn't.
    const retry = cli(dir, ["retry", run, "--stage", "avatar"]);
    expect(retry.code, retry.err).toBe(0);
    expect(status(dir, run).stages.find((s) => s.stage_key === "avatar")?.state).toBe("READY");

    drain(dir); // a fresh attempt: same op idempotency key, new op row, CONFIRMED this time -> SUCCEEDED
    const after = status(dir, run);
    expect(after.stages.find((s) => s.stage_key === "avatar")?.state).toBe("SUCCEEDED");
    expect(after.artifacts.some((a) => a.type === "avatar_clips" && a.status === "ACCEPTED")).toBe(true);

    const avatarStageRunId = stageId(dir, run, "avatar");
    const store = new SqliteStateStore(join(dir, "data", "state", "harness.db"));
    try {
      const ops = store.listExternalOperations({ stage_run_id: avatarStageRunId });
      const lostOp = ops.find((o) => o.status === "FAILED");
      const confirmedOp = ops.find((o) => o.status === "CONFIRMED");
      expect(lostOp, JSON.stringify(ops)).toBeDefined();
      expect(confirmedOp, JSON.stringify(ops)).toBeDefined();
      expect(confirmedOp!.operation_id).not.toBe(lostOp!.operation_id);
      expect(confirmedOp!.idempotency_key).toBe(lostOp!.idempotency_key);
    } finally {
      store.close();
    }
  }, 300_000);
});
