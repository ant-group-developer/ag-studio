import { describe, expect, it } from "vitest";
import {
  completeTurn, currentProposal, failTurn, insertSystemTurn, insertUserTurn, listTurns, markTurnApplied, markTurnRunning,
  nextPendingTurns, rateLimitTurn, scopeTurns, type ChatScopeKey,
} from "../src/index.js";
import { seedProduction, world } from "./helpers.js";

const T0 = "2026-10-06T10:00:00.000Z";
const T1 = "2026-10-06T10:00:01.000Z";
const T2 = "2026-10-06T10:00:02.000Z";

function setup() {
  const { db } = world();
  const prod = seedProduction(db);
  const gate: ChatScopeKey = { productionId: prod, episodeId: null, runId: "run-1", stageKey: "approve-rnd", scope: "gate" };
  return { db, prod, gate };
}

describe("stage chat turns", () => {
  it("numbers turns in order within a production and pairs each message with a pending reply", () => {
    const { db, prod, gate } = setup();
    const a = insertUserTurn(db, gate, { text: "Gộp tập 3 và 4", createdBy: "auth0|owner" }, T0);
    expect(a.user.turn).toBe(1);
    expect(a.user.status).toBe("done");
    expect(a.assistant).toMatchObject({ turn: 2, role: "assistant", status: "pending", stage_key: "approve-rnd", scope: "gate" });
    const intake: ChatScopeKey = { productionId: prod, episodeId: null, runId: null, stageKey: "intake", scope: "intake" };
    insertSystemTurn(db, intake, "Bạn đã sửa tay", T1);
    expect(listTurns(db, prod).map((t) => [t.turn, t.role])).toEqual([[1, "user"], [2, "assistant"], [3, "system"]]);
  });

  it("folds a second message into the reply still waiting, so Claude answers both at once", () => {
    const { db, prod, gate } = setup();
    insertUserTurn(db, gate, { text: "Gộp tập 3 và 4", createdBy: "u" }, T0);
    insertUserTurn(db, gate, { text: "và bỏ tập 5", createdBy: "u" }, T1);
    expect(listTurns(db, prod).map((t) => [t.role, t.status])).toEqual([["user", "done"], ["user", "done"], ["assistant", "pending"]]);
  });

  it("queues a new reply behind one that is already running", () => {
    const { db, prod, gate } = setup();
    const first = insertUserTurn(db, gate, { text: "Gộp tập 3 và 4", createdBy: "u" }, T0);
    expect(markTurnRunning(db, first.assistant!.id, T1)).toBe(true);
    expect(markTurnRunning(db, first.assistant!.id, T1)).toBe(false);
    insertUserTurn(db, gate, { text: "và bỏ tập 5", createdBy: "u" }, T1);
    expect(listTurns(db, prod).map((t) => [t.role, t.status])).toEqual([
      ["user", "done"], ["assistant", "running"], ["user", "done"], ["assistant", "pending"],
    ]);
    // one scope runs one reply at a time: the queued one waits for the running one
    expect(nextPendingTurns(db, T2, 10)).toEqual([]);
    completeTurn(db, first.assistant!.id, { text: "Đã gộp", action: "revise", proposal: { v: 2 }, problems: [], llmCallId: "call-1" }, T2);
    expect(nextPendingTurns(db, T2, 10).map((t) => t.turn)).toEqual([4]);
  });

  it("hands out the oldest waiting reply of each scope, and a rate-limited one only after its time", () => {
    const { db, prod, gate } = setup();
    const ep: ChatScopeKey = { productionId: prod, episodeId: "ep-1", runId: "run-ep", stageKey: "approve-timeline", scope: "gate" };
    const g = insertUserTurn(db, gate, { text: "a", createdBy: "u" }, T0);
    const e = insertUserTurn(db, ep, { text: "b", createdBy: "u" }, T1);
    expect(nextPendingTurns(db, T1, 10).map((t) => t.id)).toEqual([g.assistant!.id, e.assistant!.id]);
    expect(nextPendingTurns(db, T1, 1).map((t) => t.id)).toEqual([g.assistant!.id]);
    markTurnRunning(db, g.assistant!.id, T1);
    rateLimitTurn(db, g.assistant!.id, "2026-10-06T10:05:00.000Z", T1);
    expect(nextPendingTurns(db, T2, 10).map((t) => t.id)).toEqual([e.assistant!.id]);
    expect(nextPendingTurns(db, "2026-10-06T10:05:00.000Z", 10).map((t) => t.id)).toEqual([g.assistant!.id, e.assistant!.id]);
    expect(markTurnRunning(db, g.assistant!.id, "2026-10-06T10:05:00.000Z")).toBe(true);
  });

  it("current proposal is the newest one in the scope; a failed reply keeps the one before", () => {
    const { db, prod, gate } = setup();
    expect(currentProposal(db, gate)).toBeUndefined();
    const a = insertUserTurn(db, gate, { text: "a", createdBy: "u" }, T0);
    completeTurn(db, a.assistant!.id, { text: "Bản 2", action: "revise", proposal: { v: 2 }, problems: [], llmCallId: null }, T0);
    const b = insertUserTurn(db, gate, { text: "b", createdBy: "u" }, T1);
    completeTurn(db, b.assistant!.id, { text: "Bản 3", action: "revise", proposal: { v: 3 }, problems: [], llmCallId: null }, T1);
    const c = insertUserTurn(db, gate, { text: "c", createdBy: "u" }, T2);
    failTurn(db, c.assistant!.id, { text: "Claude chưa sửa được", problems: [{ code: "x", message: "y" }] }, T2);
    expect(currentProposal(db, gate)).toMatchObject({ id: b.assistant!.id, proposal: { v: 3 }, applied_at: null });
    // a manual edit is a proposal written by the person
    const manual = insertUserTurn(db, gate, { text: "Sửa tay", createdBy: "u", proposal: { v: 4 }, ask: false }, T2);
    expect(manual.assistant).toBeNull();
    expect(currentProposal(db, gate)?.proposal).toEqual({ v: 4 });
    markTurnApplied(db, manual.user.id, T2);
    expect(currentProposal(db, gate)?.applied_at).toBe(T2);
    // another scope of the same production does not see it
    expect(currentProposal(db, { ...gate, stageKey: "approve-branding" })).toBeUndefined();
    expect(scopeTurns(db, gate).map((t) => t.text)).toEqual(["a", "Bản 2", "b", "Bản 3", "c", "Claude chưa sửa được", "Sửa tay"]);
    expect(listTurns(db, prod, { episodeId: "ep-1" })).toEqual([]);
  });

  it("keeps mentions and context as JSON", () => {
    const { db, prod } = setup();
    const intake: ChatScopeKey = { productionId: prod, episodeId: null, runId: null, stageKey: "intake", scope: "intake" };
    const r = insertUserTurn(db, intake, {
      text: "Làm series từ @[Kyoto 2025](folder:f1)", createdBy: "u",
      mentions: [{ kind: "folder", id: "f1", name: "Kyoto 2025" }], context: { folders: [{ id: "f1", name: "Kyoto 2025", usableVideos: 38 }] },
    }, T0);
    const [user] = listTurns(db, prod);
    expect(user).toMatchObject({ id: r.user.id, mentions: [{ id: "f1" }], context: { folders: [{ usableVideos: 38 }] }, run_id: null });
  });
});
