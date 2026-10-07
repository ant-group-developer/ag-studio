import { describe, expect, it } from "vitest";
import { assistantName, claudeMaxConcurrent, getStudioSetting, setAssistantName, setClaudeMaxConcurrent } from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-06T10:00:00.000Z";

describe("Claude concurrency setting", () => {
  it("uses the env value (or 20) until someone saves one on the web, then the saved one", () => {
    const { db } = world();
    expect(claudeMaxConcurrent(db, 7)).toEqual({ value: 7, source: "env" });
    setClaudeMaxConcurrent(db, 3, "auth0|admin", NOW);
    expect(claudeMaxConcurrent(db, 7)).toEqual({ value: 3, source: "settings" });
    expect(getStudioSetting(db, "claude.max_concurrent")).toEqual({ value: 3, updated_at: NOW, updated_by: "auth0|admin" });
    setClaudeMaxConcurrent(db, 12, "auth0|admin", NOW);
    expect(claudeMaxConcurrent(db, 7).value).toBe(12);
  });

  it("refuses to save anything but a whole number 1–100", () => {
    const { db } = world();
    for (const bad of [0, -1, 101, 2.5, Number.NaN]) expect(() => setClaudeMaxConcurrent(db, bad, "u", NOW)).toThrow(/1 to 100/);
    expect(getStudioSetting(db, "claude.max_concurrent")).toBeUndefined();
  });

  it("falls back to the env value when the stored one is broken", () => {
    const { db } = world();
    db.run("INSERT INTO studio_settings (key, value, updated_at, updated_by) VALUES ('claude.max_concurrent', '\"many\"', ?, 'u')", [NOW]);
    expect(claudeMaxConcurrent(db, 5)).toEqual({ value: 5, source: "env" });
  });
});

describe("assistant name setting", () => {
  it("is Claude until an admin names it; a blank name goes back to Claude", () => {
    const { db } = world();
    expect(assistantName(db)).toBe("Claude");
    setAssistantName(db, "  Trợ lý AG  ", "auth0|admin", NOW);
    expect(assistantName(db)).toBe("Trợ lý AG");
    expect(getStudioSetting(db, "assistant.name")).toEqual({ value: "Trợ lý AG", updated_at: NOW, updated_by: "auth0|admin" });
    setAssistantName(db, "   ", "auth0|admin", NOW);
    expect(assistantName(db)).toBe("Claude");
    expect(getStudioSetting(db, "assistant.name")).toBeUndefined();
  });

  it("refuses a name over 40 characters or with control characters", () => {
    const { db } = world();
    expect(() => setAssistantName(db, "x".repeat(41), "u", NOW)).toThrow(/40/);
    expect(() => setAssistantName(db, "AG\nAI", "u", NOW)).toThrow(/40/);
    expect(assistantName(db)).toBe("Claude");
  });

  it("reads Claude when the stored value is broken", () => {
    const { db } = world();
    db.run("INSERT INTO studio_settings (key, value, updated_at, updated_by) VALUES ('assistant.name', '42', ?, 'u')", [NOW]);
    expect(assistantName(db)).toBe("Claude");
  });
});
