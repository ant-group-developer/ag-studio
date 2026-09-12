import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@harness/contracts";
import { sha256String } from "../../src/artifacts/checksum.js";
import { ArtifactRegistry } from "../../src/artifacts/registry.js";
import { sweepOrphanArtifacts } from "../../src/artifacts/sweep.js";
import { createWorkspace } from "../../src/environment/workspace.js";
import { beginAttempt, openTempStore, seedStage } from "../helpers.js";

function orphanDir(dataRoot: string, ageSeconds: number, withManifest = true): string {
  const id = newId("artifact");
  const dir = join(dataRoot, "artifacts", "content-x", "variant-y", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.txt"), "x");
  if (withManifest) writeFileSync(join(dir, "manifest.json"), JSON.stringify({ artifact_id: id, status: "provisional" }));
  const old = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(withManifest ? join(dir, "manifest.json") : dir, old, old);
  return dir;
}

describe("sweepOrphanArtifacts", () => {
  it("removes old orphans, keeps young ones and accepted artifacts", async () => {
    const { store, dir, clock } = openTempStore();
    const oldOrphan = orphanDir(dir, 7200);
    const youngOrphan = orphanDir(dir, 10);
    const noManifest = orphanDir(dir, 7200, false);
    // a real ACCEPTED artifact
    const { runId, stage } = seedStage(store);
    const claim = store.claim({ owner: "w", capabilities: [], now: clock.now(), leaseSeconds: 90 })!;
    const { attempt } = beginAttempt(store, claim);
    const ws = await createWorkspace(dir, runId, stage.stage_key, attempt.attempt_id);
    writeFileSync(join(ws, "output", "result.txt"), "hello");
    const registry = new ArtifactRegistry(store, dir);
    const ctx = { run: store.getRun(runId)!, stageRun: store.getStageRun(stage.stage_run_id)!, attempt, executorVersion: "x", inputArtifactIds: [], checkResultIds: [] };
    const staged = await registry.stageOutputs({ workspaceDir: ws, outputs: [{ path: "output/result.txt", type: "t", checksum: sha256String("hello"), size_bytes: 5 }], mimeTypes: {}, ctx });
    const [accepted] = store.transaction(() => registry.commitAccepted(staged, ctx));
    const acceptedDir = join(staged[0]!.manifestPath, "..");
    utimesSync(staged[0]!.manifestPath, new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000));

    const dry = sweepOrphanArtifacts({ store, dataRoot: dir, now: new Date().toISOString(), olderThanSeconds: 3600, dryRun: true });
    expect(dry.removed.sort()).toEqual([oldOrphan, noManifest].sort());
    expect(existsSync(oldOrphan)).toBe(true);

    const real = sweepOrphanArtifacts({ store, dataRoot: dir, now: new Date().toISOString(), olderThanSeconds: 3600, dryRun: false });
    expect(real.removed.sort()).toEqual([oldOrphan, noManifest].sort());
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(noManifest)).toBe(false);
    expect(existsSync(youngOrphan)).toBe(true);
    expect(existsSync(acceptedDir)).toBe(true);
    expect(real.kept.some((k) => k.artifact_id === accepted!.artifact_id && k.reason === "ACCEPTED")).toBe(true);
    expect(real.scanned).toBe(4);
  });
});
