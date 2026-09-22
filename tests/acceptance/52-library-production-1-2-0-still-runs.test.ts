import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type LibraryItem } from "@harness/contracts";
import { HARNESS_ROOT, loadWorkflow, SqliteStateStore } from "@harness/core";
import { hasFfmpeg } from "../media.js";
import {
  addVoice, freshLibraryWorld, ingestShoot, requestCreate, requestStatus, status, studioWorkerUntil,
  writeActiveStyle,
} from "../integration/library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

// Acceptance 52 (sub-project 5B §8): adding `library-production@1.3.0` must not have disturbed `@1.2.0`. The
// studio profile now defaults to 1.3.0, so 1.2.0 is reached the way ADR 111 documents the rollback --
// `library.auto_accept.workflow_release` on the studio project (what `freshLibraryWorld({ media1_2: true })`
// writes). The old release still cuts and assembles with the fixture wrappers, knows nothing about
// compositions or renders, and still reaches an approved item. Acceptance 46 and 32 do the same for 1.1.0
// and 1.0.0.
describe("acceptance 52: library-production@1.2.0 still runs unchanged", () => {
  it("the 1.2.0 definition still has cut/assemble and none of the 5B composition stages", () => {
    const keys = loadWorkflow(HARNESS_ROOT, "library-production@1.2.0").definition.stages.map((s) => s.key);
    expect(keys).toContain("cut");
    expect(keys).toContain("assemble");
    expect(keys).not.toContain("media-compose");
    expect(keys).not.toContain("media-render");

    // ...and 1.3.0 is the one that replaced them, so the assertions above really are about the older release
    const next = loadWorkflow(HARNESS_ROOT, "library-production@1.3.0").definition.stages.map((s) => s.key);
    expect(next).toContain("media-compose");
    expect(next).toContain("media-render");
    expect(next).not.toContain("cut");
    expect(next).not.toContain("assemble");
  });

  it.skipIf(!hasFfmpeg())("a studio pinned back to 1.2.0 still fulfills a request through cut and assemble", () => {
    const world = freshLibraryWorld({ media: false, media1_2: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const voiceId = addVoice(world);
    ingestShoot(world, "shoot-a", 2, { withAudio: true });

    const requestId = requestCreate(world, {
      topic: "Bản 1.2.0 vẫn chạy", style: styleId, sourceHint: "shoot-a",
      voice: "tts", voiceId, duration: [1, 120], language: "en",
    });

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 400, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");

    const manifest = readJson<LibraryItem>(join(world.lib, "items", fulfilled.item_ids[0]!, "manifest.json"));
    expect(manifest.status).toBe("approved");
    const runId = manifest.lineage.run_id;

    const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      const run = store.getRun(runId)!;
      expect(`${run.workflow_release.id}@${run.workflow_release.version}`).toBe("library-production@1.2.0");
    } finally {
      store.close();
    }

    const final = status(world.studio, runId);
    expect(final.run.state).toBe("SUCCEEDED");
    const keys = final.stages.map((s) => s.stage_key);
    expect(keys).toContain("cut");
    expect(keys).toContain("assemble");
    expect(keys).not.toContain("media-render");
    for (const s of final.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");
  }, 600_000);
});
