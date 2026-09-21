import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type LibraryItem } from "@harness/contracts";
import { HARNESS_ROOT, loadWorkflow, SqliteStateStore } from "@harness/core";
import { hasFfmpeg } from "../media.js";
import { cli, freshLibraryWorld, requestCreate, requestStatus, status, studioWorkerUntil, writeActiveStyle } from "../integration/library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

// Acceptance 46 (sub-project 5A §7): adding `library-production@1.2.0` must not have disturbed `@1.1.0`. The
// old release still runs on the old fixture shape -- ONE source, the `index-source` and `tts` ops wrappers,
// `narration.txt` -- all the way to an approved item, on a studio project whose autopilot is pinned back to
// it (`library.auto_accept.workflow_release`, the operator's documented rollback knob). Acceptance 32 does
// the same for `@1.0.0`.
describe("acceptance 46: library-production@1.1.0 still runs unchanged", () => {
  it("the 1.1.0 definition still has index-source and no 5A media stage", () => {
    const wf = loadWorkflow(HARNESS_ROOT, "library-production@1.1.0");
    const keys = wf.definition.stages.map((s) => s.key);
    expect(keys).toContain("index-source");
    expect(keys).toContain("tts");
    expect(keys).not.toContain("media-fit-edl");
    expect(keys).not.toContain("media-index");
    expect(keys).not.toContain("media-transcribe");
    expect(keys).not.toContain("media-tts");

    // ...and 1.2.0 is the one that has them, so the assertions above are really about the older release
    const next = loadWorkflow(HARNESS_ROOT, "library-production@1.2.0").definition.stages.map((s) => s.key);
    expect(next).toContain("media-fit-edl");
    expect(next).not.toContain("index-source");
  });

  it.skipIf(!hasFfmpeg())("a pinned-1.1.0 studio still fulfills a request from a single source", () => {
    const world = freshLibraryWorld({ media: true, autopilot: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const ingested = cli(world.studio, ["source", "ingest", world.sample, "--rights", "cleared", "--json"], env);
    expect(ingested.code, ingested.err).toBe(0);

    const requestId = requestCreate(world, { topic: "Bản 1.1.0 vẫn chạy", style: styleId, sourceHint: "main", voice: "none" });
    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 300, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");

    const manifest = readJson<LibraryItem>(join(world.lib, "items", fulfilled.item_ids[0]!, "manifest.json"));
    expect(manifest.status).toBe("approved");
    const runId = manifest.lineage.run_id;

    const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      const run = store.getRun(runId)!;
      expect(`${run.workflow_release.id}@${run.workflow_release.version}`).toBe("library-production@1.1.0");
    } finally {
      store.close();
    }

    const final = status(world.studio, runId);
    expect(final.run.state).toBe("SUCCEEDED");
    const keys = final.stages.map((s) => s.stage_key);
    expect(keys).toContain("index-source");
    expect(keys).not.toContain("media-fit-edl");
    for (const s of final.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");
  }, 300_000);
});
