import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { HarnessConfigSchema, HarnessError, ProductionProfileSchema, WorkflowDefinitionSchema, type Checksum, type HarnessConfig, type ProductionProfile, type WorkflowDefinition } from "@harness/contracts";
import { canonicalDigest } from "../artifacts/checksum.js";

export const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export interface LoadedWorkflow { definition: WorkflowDefinition; digest: Checksum }

function readYaml(path: string): unknown {
  if (!existsSync(path)) throw new HarnessError("NOT_FOUND", `file not found: ${path}`, { path });
  return parse(readFileSync(path, "utf8"));
}

export function loadWorkflow(harnessRoot: string, ref: string): LoadedWorkflow {
  const [id, version] = ref.split("@");
  if (!id || !version) throw new HarnessError("WORKFLOW_INVALID", `workflow ref must be id@version, got "${ref}"`, { ref });
  const raw = readYaml(join(harnessRoot, "workflows", id, "workflow.yaml"));
  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("WORKFLOW_INVALID", `workflow ${id} invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`, { issues: parsed.error.issues });
  if (parsed.data.version !== version) throw new HarnessError("WORKFLOW_INVALID", `workflow ${id} has version ${parsed.data.version}, requested ${version}`, { ref });
  return { definition: parsed.data, digest: canonicalDigest(parsed.data) };
}

export function loadProfile(harnessRoot: string, id: string): ProductionProfile {
  return ProductionProfileSchema.parse(readYaml(join(harnessRoot, "production-profiles", id, "profile.yaml")));
}

export function loadHarnessConfig(harnessRoot: string): HarnessConfig {
  return HarnessConfigSchema.parse(readYaml(join(harnessRoot, "configs", "harness.yaml")));
}
