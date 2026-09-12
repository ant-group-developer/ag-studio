import { copyFile, link, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact, StageInput } from "@harness/contracts";

export function workspacePath(dataRoot: string, runId: string, stageKey: string, attemptId: string): string {
  return join(dataRoot, "workspaces", runId, stageKey, attemptId);
}

export async function createWorkspace(dataRoot: string, runId: string, stageKey: string, attemptId: string): Promise<string> {
  const dir = workspacePath(dataRoot, runId, stageKey, attemptId);
  for (const sub of ["input", "output", "logs"]) await mkdir(join(dir, sub), { recursive: true });
  return dir;
}

async function linkOrCopy(src: string, dest: string): Promise<void> {
  try { await link(src, dest); } catch { await copyFile(src, dest); }
}

export async function materializeInputs(workspaceDir: string, artifacts: Artifact[]): Promise<StageInput[]> {
  const inputs: StageInput[] = [];
  for (const a of artifacts) {
    const src = fileURLToPath(a.uri);
    const rel = join("input", a.artifact_id, basename(src)).split("\\").join("/");
    await mkdir(join(workspaceDir, "input", a.artifact_id), { recursive: true });
    await linkOrCopy(src, join(workspaceDir, rel));
    inputs.push({ artifact_id: a.artifact_id, checksum: a.checksum, path: rel, type: a.type, kind: "file" });
  }
  return inputs;
}
