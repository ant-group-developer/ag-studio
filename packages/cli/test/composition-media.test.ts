import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isHarnessError, ProjectConfigSchema, type ProjectConfig } from "@harness/contracts";
import { mediaEngineOptions } from "../src/composition.js";

const HARNESS_ROOT = "E:/harness-root";
const REDACT = (s: string) => s;

const BASE = {
  schema_version: "harness.project-config/v1" as const,
  project_id: "p", template_release: "1.0.0", runtime: "codex" as const,
  data_root: "./data", portfolios: [{ portfolio_id: "pf", display_name: "PF" }],
  adapters: { media: "python" as const },
};

function project(media: Record<string, unknown>): ProjectConfig {
  return ProjectConfigSchema.parse({ ...BASE, media });
}

describe("mediaEngineOptions", () => {
  it("top-level media.python only: used as python, no transcribePython/ttsPython override", () => {
    const opts = mediaEngineOptions(project({ python: "D:/venv/python.exe" }), HARNESS_ROOT, REDACT);
    expect(opts.python).toBe("D:/venv/python.exe");
    expect(opts).not.toHaveProperty("transcribePython");
    expect(opts).not.toHaveProperty("ttsPython");
    expect(opts.enginesDir).toBe(join(HARNESS_ROOT, "engines", "python"));
  });

  it("both per-engine overrides, no top-level: python falls back to one of them, both overrides passed through", () => {
    const opts = mediaEngineOptions(
      project({ transcribe: { python: "D:/venv-a/python.exe" }, tts: { python: "D:/venv-b/python.exe" } }),
      HARNESS_ROOT, REDACT,
    );
    expect(["D:/venv-a/python.exe", "D:/venv-b/python.exe"]).toContain(opts.python);
    expect(opts.transcribePython).toBe("D:/venv-a/python.exe");
    expect(opts.ttsPython).toBe("D:/venv-b/python.exe");
  });

  it("one override + top-level: top-level is python, the one override is passed through, the other stage falls back to python inside PythonMediaEngine", () => {
    const opts = mediaEngineOptions(
      project({ python: "D:/venv/python.exe", transcribe: { python: "D:/venv-a/python.exe" } }),
      HARNESS_ROOT, REDACT,
    );
    expect(opts.python).toBe("D:/venv/python.exe");
    expect(opts.transcribePython).toBe("D:/venv-a/python.exe");
    expect(opts).not.toHaveProperty("ttsPython");
  });

  it("nothing set: throws CONFIG_INVALID naming media.python", () => {
    try {
      mediaEngineOptions(project({}), HARNESS_ROOT, REDACT);
      expect.fail("expected mediaEngineOptions to throw");
    } catch (e) {
      expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true);
      expect(String((e as { message: string }).message)).toContain("media.python");
    }
  });

  it("only transcribe.python set (no top-level, no tts.python): throws CONFIG_INVALID naming media.tts.python", () => {
    try {
      mediaEngineOptions(project({ transcribe: { python: "D:/venv-a/python.exe" } }), HARNESS_ROOT, REDACT);
      expect.fail("expected mediaEngineOptions to throw");
    } catch (e) {
      expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true);
      expect(String((e as { message: string }).message)).toContain("media.tts.python");
    }
  });

  it("only tts.python set (no top-level, no transcribe.python): throws CONFIG_INVALID naming media.transcribe.python", () => {
    try {
      mediaEngineOptions(project({ tts: { python: "D:/venv-b/python.exe" } }), HARNESS_ROOT, REDACT);
      expect.fail("expected mediaEngineOptions to throw");
    } catch (e) {
      expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true);
      expect(String((e as { message: string }).message)).toContain("media.transcribe.python");
    }
  });
});
