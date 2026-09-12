import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export { FakeAgentRuntime, type JournalLike } from "./fake-agent-runtime.js";
export { FakeProvider } from "./fake-provider.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Points at the .ts source (run via tsx) when the package is used from source, or the built .js when run from dist/. */
export const FAKE_STAGE_SCRIPT_PATH = existsSync(join(here, "fake-stage-script.ts")) ? join(here, "fake-stage-script.ts") : join(here, "fake-stage-script.js");
/** Script registry entries for the composition root: name -> argv. Uses tsx so no build is required. */
export function fakeScriptCommands(): Record<string, string[]> {
  return { "fake-stage": FAKE_STAGE_SCRIPT_PATH.endsWith(".ts") ? [process.execPath, "--import", "tsx", FAKE_STAGE_SCRIPT_PATH] : [process.execPath, FAKE_STAGE_SCRIPT_PATH] };
}
