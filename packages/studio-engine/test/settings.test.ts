import { afterEach, describe, expect, it } from "vitest";
import { assistantName, claudeMaxConcurrent, clearYoutubeBlocked, getStudioSetting, noteYoutubeBlocked, setAssistantName, setClaudeMaxConcurrent, youtubeBlock } from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-06T10:00:00.000Z";

let w: Awaited<ReturnType<typeof world>> | undefined;
async function open() { w = await world(); return w; }
afterEach(async () => { await w?.db.close(); w = undefined; });

describe("Claude concurrency setting", async () => {
  it("uses the env value (or 20) until someone saves one on the web, then the saved one", async () => {
    const { db } = await open();
    expect(await claudeMaxConcurrent(db, 7)).toEqual({ value: 7, source: "env" });
    await setClaudeMaxConcurrent(db, 3, "auth0|admin", NOW);
    expect(await claudeMaxConcurrent(db, 7)).toEqual({ value: 3, source: "settings" });
    expect(await getStudioSetting(db, "claude.max_concurrent")).toEqual({ value: 3, updated_at: NOW, updated_by: "auth0|admin" });
    await setClaudeMaxConcurrent(db, 12, "auth0|admin", NOW);
    expect((await claudeMaxConcurrent(db, 7)).value).toBe(12);
  });

  it("refuses to save anything but a whole number 1–100", async () => {
    const { db } = await open();
    for (const bad of [0, -1, 101, 2.5, Number.NaN]) await expect(setClaudeMaxConcurrent(db, bad, "u", NOW)).rejects.toThrow(/1 to 100/);
    expect(await getStudioSetting(db, "claude.max_concurrent")).toBeUndefined();
  });

  it("falls back to the env value when the stored one is broken", async () => {
    const { db } = await open();
    await db.run("INSERT INTO studio_settings (key, value, updated_at, updated_by) VALUES ('claude.max_concurrent', '\"many\"', ?, 'u')", [NOW]);
    expect(await claudeMaxConcurrent(db, 5)).toEqual({ value: 5, source: "env" });
  });
});

describe("assistant name setting", async () => {
  it("is Claude until an admin names it; a blank name goes back to Claude", async () => {
    const { db } = await open();
    expect(await assistantName(db)).toBe("Claude");
    await setAssistantName(db, "  Trợ lý AG  ", "auth0|admin", NOW);
    expect(await assistantName(db)).toBe("Trợ lý AG");
    expect(await getStudioSetting(db, "assistant.name")).toEqual({ value: "Trợ lý AG", updated_at: NOW, updated_by: "auth0|admin" });
    await setAssistantName(db, "   ", "auth0|admin", NOW);
    expect(await assistantName(db)).toBe("Claude");
    expect(await getStudioSetting(db, "assistant.name")).toBeUndefined();
  });

  it("refuses a name over 40 characters or with control characters", async () => {
    const { db } = await open();
    await expect(setAssistantName(db, "x".repeat(41), "u", NOW)).rejects.toThrow(/40/);
    await expect(setAssistantName(db, "AG\nAI", "u", NOW)).rejects.toThrow(/40/);
    expect(await assistantName(db)).toBe("Claude");
  });

  it("reads Claude when the stored value is broken", async () => {
    const { db } = await open();
    await db.run("INSERT INTO studio_settings (key, value, updated_at, updated_by) VALUES ('assistant.name', '42', ?, 'u')", [NOW]);
    expect(await assistantName(db)).toBe("Claude");
  });
});

describe("YouTube blocking the Studio server", async () => {
  it("is remembered 6 hours from the last time it was seen, forgotten after, cleared by a download that went through", async () => {
    const { db } = await open();
    expect(await youtubeBlock(db, NOW)).toBeNull();
    await noteYoutubeBlocked(db, NOW);
    expect(await getStudioSetting(db, "youtube.blocked_until")).toMatchObject({ updated_by: "studio" });
    expect(await youtubeBlock(db, "2026-10-06T15:59:00.000Z")).toEqual({ blockedAt: NOW, until: "2026-10-06T16:00:00.000Z", where: "studio" });
    expect(await youtubeBlock(db, "2026-10-06T16:00:01.000Z")).toBeNull();
    await noteYoutubeBlocked(db, NOW);
    await clearYoutubeBlocked(db);
    expect(await youtubeBlock(db, NOW)).toBeNull();
  });
});
