import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { HarnessError, ScriptsRegistrySchema, type ScriptCommand, type ScriptsRegistry } from "@harness/contracts";

export const SCRIPTS_FILE = join("executors", "scripts.yaml");

/** `executors/scripts.yaml` of an operations project, or undefined when the project has none. */
export function loadScriptsRegistry(projectDir: string): ScriptsRegistry | undefined {
  const file = join(projectDir, SCRIPTS_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = ScriptsRegistrySchema.safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", `${file} invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, { file, issues: parsed.error.issues });
  return parsed.data;
}

/** Registry script specs -> ScriptExecutor commands, with `cwd` resolved against the project directory. */
export function scriptCommandsFrom(registry: ScriptsRegistry, projectDir: string): Record<string, ScriptCommand> {
  return Object.fromEntries(Object.entries(registry.scripts).map(([name, s]) => [name, { argv: s.argv, cwd: resolve(projectDir, s.cwd), env_refs: s.env_refs, ...(s.timeout_seconds !== undefined ? { timeout_seconds: s.timeout_seconds } : {}) }]));
}
