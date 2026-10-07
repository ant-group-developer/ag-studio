import { describe, expect, it } from "vitest";
import { agentSessionFor, saveAgentSession } from "../src/index.js";
import { world } from "./helpers.js";

describe("Claude sessions of the files-mode stages", () => {
  it("keeps one session per (run, stage); a later attempt overwrites it", () => {
    const { db } = world();
    expect(agentSessionFor(db, "run-1", "source-survey")).toBeNull();
    saveAgentSession(db, { runId: "run-1", stageKey: "source-survey", attemptId: "att-1", sessionId: "sess-1", cwd: "E:/ws/1" }, "2026-10-06T10:00:00.000Z");
    saveAgentSession(db, { runId: "run-1", stageKey: "source-survey", attemptId: "att-2", sessionId: "sess-2", cwd: "E:/ws/2" }, "2026-10-06T10:05:00.000Z");
    saveAgentSession(db, { runId: "run-2", stageKey: "source-survey", attemptId: "att-3", sessionId: "sess-3", cwd: "E:/ws/3" }, "2026-10-06T10:06:00.000Z");
    expect(agentSessionFor(db, "run-1", "source-survey")).toEqual({ attemptId: "att-2", sessionId: "sess-2", cwd: "E:/ws/2", createdAt: "2026-10-06T10:05:00.000Z" });
    expect(agentSessionFor(db, "run-2", "source-survey")?.sessionId).toBe("sess-3");
  });
});
