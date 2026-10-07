/** The chat's fingerprint moves when the thread may have changed, and only then (the event stream sends it). */
import { describe, expect, it } from "vitest";
import { chatFingerprint, insertUserTurn, startPlanRun } from "../src/index.js";
import { seedProduction, world } from "./helpers.js";

describe("chatFingerprint", () => {
  it("moves with a message, a run and its stages; stays still otherwise", () => {
    const w = world();
    const prod = seedProduction(w.db);
    const a = chatFingerprint(w.db, prod, null);
    expect(chatFingerprint(w.db, prod, null)).toBe(a);
    insertUserTurn(w.db, { productionId: prod, episodeId: null, runId: null, stageKey: "intake", scope: "intake" }, { text: "Làm series", createdBy: "auth0|owner" }, "2026-10-07T10:00:00.000Z");
    const b = chatFingerprint(w.db, prod, null);
    expect(b).not.toBe(a);
    w.db.run("UPDATE productions SET keywords = ? WHERE id = ?", [JSON.stringify(["phở"]), prod]);
    const { runId } = startPlanRun(w.core, w.db, prod);
    const c = chatFingerprint(w.db, prod, null);
    expect(c).not.toBe(b);
    expect(c).toContain(runId);
    // another production's chat does not move this one
    const other = seedProduction(w.db, { id: "33333333-3333-4333-8333-333333333333" });
    insertUserTurn(w.db, { productionId: other, episodeId: null, runId: null, stageKey: "intake", scope: "intake" }, { text: "x", createdBy: "auth0|owner" }, "2026-10-07T10:01:00.000Z");
    expect(chatFingerprint(w.db, prod, null)).toBe(c);
    w.core.close();
  });
});
