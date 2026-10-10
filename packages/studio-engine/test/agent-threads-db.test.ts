import { describe, expect, it } from "vitest";
import {
  automaticTurnsInARow, createProject, createThread, createVideo, finishTurn, listMessages, listThreadRefs, listThreads, markSessionStarted,
  markTurnRunning, messageView, nextPendingTurns, orphanedRunningTurns, postSystemMessage, postUserMessage, queueFollowUp, requestCancel,
  requeueTurn, resetSession, setThreadRef, StudioRunError, turnInput, updateRunningTurn, videoThread, getThread, archiveThread,
} from "../src/index.js";
import { world } from "./helpers.js";

const T0 = "2026-10-10T08:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

function setup() {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [T0, T0]);
  const project = createProject(w.db, "team-1", { name: "A", description: "", language: "vi", aspect: "16:9" }, "u", T0);
  const thread = createThread(w.db, { projectId: project.id, kind: "project", title: "Kênh", createdBy: "u" }, T0);
  return { ...w, project, thread };
}

describe("threads", () => {
  it("one main thread per video, made on first use; a fresh session per thread", () => {
    const { db, project, thread } = setup();
    const v = createVideo(db, project.id, { title: "Huế", createdBy: "u" }, T0);
    const a = videoThread(db, { projectId: project.id, videoId: v.id, title: "Huế", createdBy: "u" }, T0);
    expect(videoThread(db, { projectId: project.id, videoId: v.id, title: "x", createdBy: "u" }, T0).id).toBe(a.id);
    expect(a.claude_session_id).not.toBe(thread.claude_session_id);
    expect(listThreads(db, project.id).map((t) => t.title).sort()).toEqual(["Huế", "Kênh"]);
    expect(listThreads(db, project.id, { videoId: v.id }).map((t) => t.kind)).toEqual(["video"]);
    markSessionStarted(db, a.id, "/ws/p");
    expect(getThread(db, a.id)).toMatchObject({ session_started: 1, session_cwd: "/ws/p" });
    const fresh = resetSession(db, a.id);
    expect(getThread(db, a.id)).toMatchObject({ claude_session_id: fresh, session_started: 0 });
  });

  it("learns only from threads of the same project", () => {
    const { db, project, thread } = setup();
    const other = createProject(db, "team-1", { name: "B", description: "", language: "vi", aspect: "16:9" }, "u", T0);
    const foreign = createThread(db, { projectId: other.id, kind: "project", title: "x", createdBy: "u" }, T0);
    const old = createThread(db, { projectId: project.id, kind: "project", title: "Ý tưởng cũ", createdBy: "u" }, T0);
    setThreadRef(db, { threadId: thread.id, refThreadId: old.id, mode: "summary", addedBy: "u" }, T0);
    setThreadRef(db, { threadId: thread.id, refThreadId: old.id, mode: "full", addedBy: "u" }, T0);
    expect(listThreadRefs(db, thread.id)).toEqual([{ ref_thread_id: old.id, mode: "full", title: "Ý tưởng cũ", video_id: null }]);
    expect(() => setThreadRef(db, { threadId: thread.id, refThreadId: foreign.id, mode: "summary", addedBy: "u" })).toThrow(StudioRunError);
    expect(() => setThreadRef(db, { threadId: thread.id, refThreadId: thread.id, mode: "summary", addedBy: "u" })).toThrow(/chính nó/);
  });
});

describe("messages and turns", () => {
  it("a message queues a turn; messages before it starts join it; the turn reads them all", () => {
    const { db, thread } = setup();
    const first = postUserMessage(db, { threadId: thread.id, text: "Nghiên cứu kênh", createdBy: "u" }, at(1));
    const second = postUserMessage(db, { threadId: thread.id, text: "Và 30 video xu hướng", createdBy: "u" }, at(2));
    const msgs = listMessages(db, thread.id);
    expect(msgs.map((m) => [m.role, m.status])).toEqual([["user", "done"], ["user", "done"], ["assistant", "pending"]]);
    expect(first.turn).not.toBeNull();
    expect(second.turn!.seq).toBe(msgs.at(-1)!.seq);
    expect(turnInput(db, second.turn!).map((m) => m.text)).toEqual(["Nghiên cứu kênh", "Và 30 video xu hướng"]);
  });

  it("one turn runs per thread; a message sent meanwhile gets the next turn", () => {
    const { db, thread } = setup();
    const { turn } = postUserMessage(db, { threadId: thread.id, text: "một", createdBy: "u" }, at(1));
    expect(nextPendingTurns(db, at(2), 10).map((m) => m.id)).toEqual([turn!.id]);
    expect(markTurnRunning(db, turn!.id, at(2))).toBe(true);
    expect(markTurnRunning(db, turn!.id, at(2))).toBe(false);
    expect(postUserMessage(db, { threadId: thread.id, text: "hai", createdBy: "u" }, at(3)).turn).toBeNull();
    expect(nextPendingTurns(db, at(3), 10)).toEqual([]);
    updateRunningTurn(db, turn!.id, { text: "Đang đọc…", parts: [{ kind: "text", text: "Đang đọc…" }], phase: { kind: "writing" } }, at(4));
    expect(messageView(listMessages(db, thread.id).find((m) => m.id === turn!.id)!)).toMatchObject({ status: "running", phase: { kind: "writing" }, parts: [{ kind: "text" }] });
    finishTurn(db, turn!.id, { status: "done", text: "Xong", parts: [{ kind: "text", text: "Xong" }], costUsd: 0.02 }, at(5));
    const next = queueFollowUp(db, thread.id, at(5))!;
    expect(turnInput(db, next).map((m) => m.text)).toEqual(["hai"]);
    expect(queueFollowUp(db, thread.id, at(6))).toBeNull();
  });

  it("a stopped worker's turn goes back in line; a stop cancels a waiting turn or asks a running one to end", () => {
    const { db, thread } = setup();
    const { turn } = postUserMessage(db, { threadId: thread.id, text: "x", createdBy: "u" }, at(1));
    markTurnRunning(db, turn!.id, at(2));
    expect(orphanedRunningTurns(db, [])).toEqual([turn!.id]);
    expect(orphanedRunningTurns(db, [turn!.id])).toEqual([]);
    requeueTurn(db, turn!.id, at(3));
    expect(nextPendingTurns(db, at(3), 10).map((m) => m.id)).toEqual([turn!.id]);
    markTurnRunning(db, turn!.id, at(4));
    expect(requestCancel(db, turn!.id, at(5))).toMatchObject({ status: "running", cancel_requested: 1 });
    const other = createThread(db, { projectId: thread.project_id, kind: "project", title: "B", createdBy: "u" }, T0);
    const waiting = postUserMessage(db, { threadId: other.id, text: "y", createdBy: "u" }, at(6)).turn!;
    expect(requestCancel(db, waiting.id, at(7)).status).toBe("cancelled");
  });

  it("a rate-limited turn waits until its time; Studio notes may continue the agent; automatic turns are counted", () => {
    const { db, thread } = setup();
    const { turn } = postUserMessage(db, { threadId: thread.id, text: "x", createdBy: "u" }, at(1));
    markTurnRunning(db, turn!.id, at(2));
    finishTurn(db, turn!.id, { status: "rate_limited", text: "", parts: [], notBefore: at(600) }, at(3));
    expect(nextPendingTurns(db, at(100), 10)).toEqual([]);
    expect(nextPendingTurns(db, at(601), 10).map((m) => m.id)).toEqual([turn!.id]);
    markTurnRunning(db, turn!.id, at(602));
    finishTurn(db, turn!.id, { status: "done", text: "ok", parts: [] }, at(603));
    const note = postSystemMessage(db, { threadId: thread.id, text: "Render xem trước xong", trigger: "job", continueAgent: true }, at(700));
    expect(note.turn).toMatchObject({ trigger: "job", status: "pending" });
    expect(automaticTurnsInARow(db, thread.id)).toBe(1);
    expect(postSystemMessage(db, { threadId: thread.id, text: "chỉ báo", trigger: "system" }, at(701)).turn).toBeNull();
  });

  it("an archived thread takes no messages", () => {
    const { db, thread } = setup();
    archiveThread(db, thread.id, at(1));
    expect(() => postUserMessage(db, { threadId: thread.id, text: "x", createdBy: "u" }, at(2))).toThrow(/lưu trữ/);
  });
});
