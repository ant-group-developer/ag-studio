import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactManifestSchema } from "@harness/contracts";
import { acceptedInputsFor, ArtifactRegistry } from "../../src/artifacts/registry.js";
import { directoryDigest, listDirectoryFiles } from "../../src/artifacts/directory.js";
import { sha256String } from "../../src/artifacts/checksum.js";
import { createWorkspace } from "../../src/environment/workspace.js";
import { openTempStore, seedStage } from "../helpers.js";

async function setup() {
  const { store, dir, clock } = openTempStore();
  const { runId, stage } = seedStage(store);
  const claim = store.claim({ owner: "w", capabilities: [], now: clock.now(), leaseSeconds: 90 })!;
  const ws = await createWorkspace(dir, runId, stage.stage_key, claim.attempt.attempt_id);
  writeFileSync(join(ws, "output", "result.txt"), "hello");
  const registry = new ArtifactRegistry(store, dir);
  const ctx = { run: store.getRun(runId)!, stageRun: store.getStageRun(stage.stage_run_id)!, attempt: claim.attempt, executorVersion: "fake@0.1.0", inputArtifactIds: [], checkResultIds: [] };
  return { store, dir, ws, registry, ctx, stage, claim };
}

describe("ArtifactRegistry", () => {
  it("stages outputs, verifies checksums, moves files and commits ACCEPTED with a manifest", async () => {
    const { store, ws, registry, ctx, stage } = await setup();
    const outputs = [{ path: "output/result.txt", type: "script_text", checksum: sha256String("hello"), size_bytes: 5 }];
    const staged = await registry.stageOutputs({ workspaceDir: ws, outputs, mimeTypes: { script_text: "text/plain" }, ctx });
    expect(staged).toHaveLength(1);
    const [art] = store.transaction(() => registry.commitAccepted(staged, ctx));
    expect(art!.status).toBe("ACCEPTED");
    expect(existsSync(fileURLToPath(art!.uri))).toBe(true);
    expect(existsSync(join(ws, "output", "result.txt"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(fileURLToPath(art!.uri), "..", "manifest.json"), "utf8"));
    expect(ArtifactManifestSchema.parse(manifest).status).toBe("accepted");
    expect(store.listArtifacts({ stage_run_id: stage.stage_run_id, status: "ACCEPTED" })).toHaveLength(1);
    expect(store.listEvents({ run_id: ctx.run.run_id }).map((e) => e.event_type)).toContain("artifact.accepted");
  });
  it("throws CHECKSUM_MISMATCH when a declared checksum is wrong and leaves the output in place", async () => {
    const { ws, registry, ctx } = await setup();
    const outputs = [{ path: "output/result.txt", type: "script_text", checksum: sha256String("wrong"), size_bytes: 5 }];
    await expect(registry.stageOutputs({ workspaceDir: ws, outputs, mimeTypes: {}, ctx })).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(existsSync(join(ws, "output", "result.txt"))).toBe(true);
  });
  it("registers REJECTED artifacts pointing at the workspace", async () => {
    const { store, ws, registry, ctx, stage } = await setup();
    const outputs = [{ path: "output/result.txt", type: "script_text", checksum: sha256String("wrong"), size_bytes: 5 }];
    const [art] = store.transaction(() => registry.registerRejected({ workspaceDir: ws, outputs, ctx, reason: "checksum mismatch" }));
    expect(art!.status).toBe("REJECTED");
    expect(store.listArtifacts({ stage_run_id: stage.stage_run_id, status: "ACCEPTED" })).toHaveLength(0);
  });
  it("acceptedInputsFor only returns ACCEPTED artifacts of upstream stages", async () => {
    const { store, ws, registry, ctx, stage } = await setup();
    const staged = await registry.stageOutputs({ workspaceDir: ws, outputs: [{ path: "output/result.txt", type: "script_text", checksum: sha256String("hello"), size_bytes: 5 }], mimeTypes: {}, ctx });
    store.transaction(() => registry.commitAccepted(staged, ctx));
    mkdirSync(join(ws, "output"), { recursive: true }); writeFileSync(join(ws, "output", "junk.txt"), "junk");
    store.transaction(() => registry.registerRejected({ workspaceDir: ws, outputs: [{ path: "output/junk.txt", type: "junk", checksum: sha256String("x"), size_bytes: 4 }], ctx, reason: "bad" }));
    const downstream = seedStage(store, { key: "verify", runId: ctx.run.run_id, depends_on: [stage.stage_key], state: "PENDING" });
    const inputs = acceptedInputsFor(store, downstream.stage);
    expect(inputs.map((a) => a.type)).toEqual(["script_text"]);
  });
  it("rejects an output path that escapes the workspace before touching anything", async () => {
    const { ws, registry, ctx } = await setup();
    const outputs = [{ path: "../escape.txt", type: "t", checksum: sha256String("x"), size_bytes: 1 }];
    await expect(registry.stageOutputs({ workspaceDir: ws, outputs, mimeTypes: {}, ctx })).rejects.toMatchObject({ code: "IO_ERROR" });
  });
  it("moves nothing when a later output fails verification", async () => {
    const { ws, registry, ctx } = await setup();
    writeFileSync(join(ws, "output", "second.txt"), "second");
    const outputs = [
      { path: "output/result.txt", type: "script_text", checksum: sha256String("hello"), size_bytes: 5 },
      { path: "output/second.txt", type: "script_text", checksum: sha256String("wrong"), size_bytes: 6 },
    ];
    await expect(registry.stageOutputs({ workspaceDir: ws, outputs, mimeTypes: {}, ctx })).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(existsSync(join(ws, "output", "result.txt"))).toBe(true);
    expect(existsSync(join(ws, "output", "second.txt"))).toBe(true);
  });
  it("writes a provisional manifest at staging and an accepted manifest only after commit", async () => {
    const { store, ws, registry, ctx } = await setup();
    const staged = await registry.stageOutputs({ workspaceDir: ws, outputs: [{ path: "output/result.txt", type: "script_text", checksum: sha256String("hello"), size_bytes: 5 }], mimeTypes: {}, ctx });
    const read = () => JSON.parse(readFileSync(staged[0]!.manifestPath, "utf8")) as { status: string };
    expect(read().status).toBe("provisional");
    store.transaction(() => registry.commitAccepted(staged, ctx));
    expect(read().status).toBe("accepted");
  });
  it("stages a directory output as one artifact with a file listing in the manifest", async () => {
    const { store, ws, registry, ctx, stage } = await setup();
    mkdirSync(join(ws, "output", "cuts"), { recursive: true });
    writeFileSync(join(ws, "output", "cuts", "001.mp4"), "aaa"); writeFileSync(join(ws, "output", "cuts", "002.mp4"), "bbbb");
    const entries = await listDirectoryFiles(join(ws, "output", "cuts"));
    const { checksum, size_bytes } = directoryDigest(entries);
    const staged = await registry.stageOutputs({ workspaceDir: ws, outputs: [{ path: "output/cuts", type: "clip_set", checksum, size_bytes, kind: "directory" }], mimeTypes: { clip_set: "application/x-directory" }, ctx });
    const [art] = store.transaction(() => registry.commitAccepted(staged, ctx));
    expect(art!.size_bytes).toBe(7);
    expect(existsSync(join(fileURLToPath(art!.uri), "002.mp4"))).toBe(true);
    expect(existsSync(join(ws, "output", "cuts"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(fileURLToPath(art!.uri), "..", "manifest.json"), "utf8"));
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual(["001.mp4", "002.mp4"]);
    expect(store.listArtifacts({ stage_run_id: stage.stage_run_id, status: "ACCEPTED" })).toHaveLength(1);
  });
  it("rejects a directory output whose digest does not match", async () => {
    const { ws, registry, ctx } = await setup();
    mkdirSync(join(ws, "output", "cuts"), { recursive: true }); writeFileSync(join(ws, "output", "cuts", "001.mp4"), "aaa");
    await expect(registry.stageOutputs({ workspaceDir: ws, outputs: [{ path: "output/cuts", type: "clip_set", checksum: sha256String("nope"), size_bytes: 3, kind: "directory" }], mimeTypes: {}, ctx })).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
  });
});
