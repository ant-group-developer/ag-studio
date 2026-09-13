import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError } from "@harness/contracts";
import { loadScriptsRegistry, scriptCommandsFrom } from "../../src/config/scripts.js";

describe("scripts registry", () => {
  it("returns undefined without a file, parses a valid one, rejects an invalid one", () => {
    const p = mkdtempSync(join(tmpdir(), "sr-"));
    expect(loadScriptsRegistry(p)).toBeUndefined();
    mkdirSync(join(p, "executors"));
    writeFileSync(join(p, "executors", "scripts.yaml"), "schema_version: harness.scripts/v1\nscripts:\n  tts: { argv: [node, executors/wrappers/tts.mjs], requires_resources: [gpu], env_refs: { TTS_KEY: 'secret://tts/main' } }\n");
    const reg = loadScriptsRegistry(p)!;
    expect(scriptCommandsFrom(reg, p).tts).toEqual({ argv: ["node", "executors/wrappers/tts.mjs"], cwd: p, env_refs: { TTS_KEY: "secret://tts/main" } });
    writeFileSync(join(p, "executors", "scripts.yaml"), "schema_version: harness.scripts/v1\nscripts:\n  tts: { argv: [] }\n");
    try { loadScriptsRegistry(p); throw new Error("no throw"); } catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); }
  });
});
