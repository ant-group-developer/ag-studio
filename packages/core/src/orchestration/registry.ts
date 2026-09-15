import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Directory a workflow release's `workflow.yaml` lives in: `workflows/<id>@<version>/` when that exact
 * versioned directory exists (a harness install carrying more than one release of the same workflow id),
 * else the un-versioned `workflows/<id>/` every workflow used before this task and still uses today.
 */
export function workflowDir(harnessRoot: string, id: string, version: string): string {
  const versioned = join(harnessRoot, "workflows", `${id}@${version}`);
  return existsSync(versioned) ? versioned : join(harnessRoot, "workflows", id);
}

export function loadWorkflow(harnessRoot: string, ref: string): LoadedWorkflow {
  const [id, version] = ref.split("@");
  if (!id || !version) throw new HarnessError("WORKFLOW_INVALID", `workflow ref must be id@version, got "${ref}"`, { ref });
  const raw = readYaml(join(workflowDir(harnessRoot, id, version), "workflow.yaml"));
  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessError("WORKFLOW_INVALID", `workflow ${id} invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`, { issues: parsed.error.issues });
  if (parsed.data.version !== version) throw new HarnessError("WORKFLOW_INVALID", `workflow ${id} has version ${parsed.data.version}, requested ${version}`, { ref });
  return { definition: parsed.data, digest: canonicalDigest(parsed.data) };
}

/**
 * Scans `workflows/*` for `workflow.yaml` files and returns their `id@version` refs, sorted and de-duplicated.
 * `harness doctor`'s unscoped check uses this instead of scanning directory names itself, so `workflows/<id>/`
 * (legacy, unversioned) and `workflows/<id>@<version>/` (this task) are both found.
 *
 * A directory with no `workflow.yaml` is skipped -- it is not a workflow directory at all.
 *
 * A `workflow.yaml` that fails to yield a usable `id`/`version` (YAML syntax error, or missing/non-string
 * fields) is *not* validated against `WorkflowDefinitionSchema` here -- that full validation, and the
 * WORKFLOW_INVALID it can throw, only happens when the ref is actually loaded via `loadWorkflow`. Listing
 * stays cheap and never throws. Such a broken file is still surfaced as a ref, but only when its directory is
 * already named `<id>@<version>` (the versioned-dir convention this task adds): that name is the one
 * trustworthy source of a ref left once the file itself can't be trusted, and doctor can then report the
 * load failure against a real ref instead of silently dropping the directory. A plain `<id>/` directory with a
 * broken `workflow.yaml` has no version anywhere to fall back on, so it is skipped entirely.
 */
export function listWorkflowRefs(harnessRoot: string): string[] {
  const dir = join(harnessRoot, "workflows");
  if (!existsSync(dir)) return [];
  const refs = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const yamlPath = join(dir, entry.name, "workflow.yaml");
    if (!existsSync(yamlPath)) continue;
    let id: string | undefined;
    let version: string | undefined;
    try {
      const raw = parse(readFileSync(yamlPath, "utf8")) as { id?: unknown; version?: unknown };
      if (typeof raw.id === "string" && typeof raw.version === "string") { id = raw.id; version = raw.version; }
    } catch {
      // YAML syntax error: fall through to the directory-name fallback below.
    }
    if (id && version) refs.add(`${id}@${version}`);
    else if (entry.name.includes("@")) refs.add(entry.name);
  }
  return [...refs].sort();
}

export function loadProfile(harnessRoot: string, id: string): ProductionProfile {
  return ProductionProfileSchema.parse(readYaml(join(harnessRoot, "production-profiles", id, "profile.yaml")));
}

export function loadHarnessConfig(harnessRoot: string): HarnessConfig {
  return HarnessConfigSchema.parse(readYaml(join(harnessRoot, "configs", "harness.yaml")));
}
