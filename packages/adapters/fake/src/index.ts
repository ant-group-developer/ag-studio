import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ScriptCommand } from "@harness/contracts";
export { FakeAgentRuntime, type JournalLike } from "./fake-agent-runtime.js";
export { FakeProvider } from "./fake-provider.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Points at the .ts source (run via tsx) when the package is used from source, or the built .js when run from dist/. */
export const FAKE_STAGE_SCRIPT_PATH = existsSync(join(here, "fake-stage-script.ts")) ? join(here, "fake-stage-script.ts") : join(here, "fake-stage-script.js");

/** Absolute file:// URL of tsx's ESM loader, resolved from this package, so `--import` works from any cwd (workspaces live outside the repo). */
export function tsxLoaderUrl(): string {
  const pkgPath = createRequire(import.meta.url).resolve("tsx/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { exports?: Record<string, unknown> };
  const dot = pkg.exports?.["."];
  const entry = typeof dot === "string" ? dot : (dot as { import?: string | { default?: string } } | undefined)?.import;
  const rel = typeof entry === "string" ? entry : entry?.default;
  if (!rel) throw new Error("cannot locate tsx ESM loader entry in tsx/package.json exports");
  return pathToFileURL(join(dirname(pkgPath), rel)).href;
}

/** Script registry entries for the composition root: name -> command. Uses tsx on source, plain node on built output. */
export function fakeScriptCommands(): Record<string, ScriptCommand> {
  return { "fake-stage": { argv: FAKE_STAGE_SCRIPT_PATH.endsWith(".ts") ? [process.execPath, "--import", tsxLoaderUrl(), FAKE_STAGE_SCRIPT_PATH] : [process.execPath, FAKE_STAGE_SCRIPT_PATH] } };
}
