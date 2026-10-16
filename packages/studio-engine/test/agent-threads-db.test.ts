import { afterEach, describe, expect, it } from "vitest";
import {
  automaticTurnsInARow, createProject, createThread, createVideo, finishTurn, listMessages, listThreadRefs, listThreads, markSessionStarted,
  markAgentTurnRunning, messageView, nextPendingAgentTurns, orphanedAgentTurns, postSystemMessage, postUserMessage, queueFollowUp, requestCancel,
  requeueAgentTurn, resetSession, setThreadRef, StudioRunError, turnInput, updateRunningTurn, videoThread, getThread, archiveThread, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";

const T0 = "2026-10-10T08:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

let open: StudioDb | null = null;
afterEach(async () => { await open?.close(); open = null; });

async function setup() {
  const w = await world();
  open = w.db;
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [T0, T0]);
  const project = await createProject(w.db, "team-1", { name: "A", description: "", language: "vi", aspect: "16:9" }, "u", T0);
  const thread = await createThread(w.db, { projectId: project.id, kind: "project", title: "Kênh", createdBy: "u" }, T0);
  return { ...w, project, thread };
}

describe("threads", () => {
  it("one main thread per video, made on first use; a fresh session per thread", async () => {
    const { db, project, thread } = await setup();
    const v = await createVideo(db, project.id, { title: "Huế", createdBy: "u" }, T0);
    const a = await videoThread(db, { projectId: project.id, videoId: v.id, title: "Huế", createdBy: "u" }, T0);
    expect((await videoThread(db, { projectId: project.id, videoId: v.id, title: "x", createdBy: "u" }, T0)).id).toBe(a.id);
    expect(a.claude_session_id).not.toBe(thread.claude_session_id);
    expect((await listThreads(db, project.id)).map((t) => t.title).sort()).toEqual(["Huế", "Kênh"]);
    expect((await listThreads(db, project.id, { videoId: v.id })).map((t) => t.kind)).toEqual(["video"]);
    await markSessionStarted(db, a.id, "/ws/p");
    expect(await getThread(db, a.id)).toMatchObject({ session_started: true, session_cwd: "/ws/p" });
    const fresh = await resetSession(db, a.id);
    expect(await getThread(db, a.id)).toMatchObject({ claude_session_id: fresh, session_started: false });
  });

  it("two first uses of a video's thread at once make one thread", async () => {
    const { db, project } = await setup();
    const v = await createVideo(db, project.id, { title: "Huế", createdBy: "u" }, T0);
    const [a, b] = await Promise.all([1, 2].map(() => videoThread(db, { projectId: project.id, videoId: v.id, title: "Huế", createdBy: "u" }, T0)));
    expect(a!.id).toBe(b!.id);
    expect(await listThreads(db, project.id, { videoId: v.id })).toHaveLength(1);
  });

  it("learns only from threads of the same project", async () => {
    const { db, project, thread } = await setup();
    const other = await createProject(db, "team-1", { name: "B", description: "", language: "vi", aspect: "16:9" }, "u", T0);
    const foreign = await createThread(db, { projectId: other.id, kind: "project", title: "x", createdBy: "u" }, T0);
    const old = await createThread(db, { projectId: project.id, kind: "project", title: "Ý tưởng cũ", createdBy: "u" }, T0);
    await setThreadRef(db, { threadId: thread.id, refThreadId: old.id, mode: "summary", addedBy: "u" }, T0);
    await setThreadRef(db, { threadId: thread.id, refThreadId: old.id, mode: "full", addedBy: "u" }, T0);
    expect(await listThreadRefs(db, thread.id)).toEqual([{ ref_thread_id: old.id, mode: "full", title: "Ý tưởng cũ", video_id: null }]);
    await expect(setThreadRef(db, { threadId: thread.id, refThreadId: foreign.id, mode: "summary", addedBy: "u" })).rejects.toThrow(StudioRunError);
    await expect(setThreadRef(db, { threadId: thread.id, refThreadId: thread.id, mode: "summary", addedBy: "u" })).rejects.toThrow(/chính nó/);
  });
});

describe("messages and turns", () => {
  it("a message queues a turn; messages before it starts join it; the turn reads them all", async () => {
    const { db, thread } = await setup();
    const first = await postUserMessage(db, { threadId: thread.id, text: "Nghiên cứu kênh", actor: { id: "u", role: "editor" } }, at(1));
    const second = await postUserMessage(db, { threadId: thread.id, text: "Và 30 video xu hướng", actor: { id: "u", role: "editor" } }, at(2));
    const msgs = await listMessages(db, thread.id);
    expect(msgs.map((m) => [m.role, m.status])).toEqual([["user", "done"], ["user", "done"], ["assistant", "pending"]]);
    expect(first.turn).not.toBeNull();
    expect(second.turn!.seq).toBe(msgs.at(-1)!.seq);
    expect((await turnInput(db, second.turn!)).map((m) => m.text)).toEqual(["Nghiên cứu kênh", "Và 30 video xu hướng"]);
  });

  it("messages sent at the same moment get their own seq, and one waiting turn answers them all", async () => {
    const { db, thread } = await setup();
    const sent = await Promise.all(["một", "hai", "ba", "bốn"].map((text) => postUserMessage(db, { threadId: thread.id, text, actor: { id: "u", role: "editor" } }, at(1))));
    await postSystemMessage(db, { threadId: thread.id, text: "Render xong", trigger: "job", continueAgent: true }, at(1));
    const msgs = await listMessages(db, thread.id);
    expect(new Set(msgs.map((m) => m.seq)).size).toBe(msgs.length);
    const turns = msgs.filter((m) => m.role === "assistant");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "pending", seq: msgs.at(-1)!.seq });
    expect(sent.map((s) => s.user.seq).sort()).toEqual(msgs.filter((m) => m.role === "user").map((m) => m.seq));
    expect((await turnInput(db, turns[0]!)).map((m) => m.text).sort()).toEqual(["Render xong", "ba", "bốn", "hai", "một"].sort());
  });

  it("one turn runs per thread; a message sent meanwhile gets the next turn", async () => {
    const { db, thread } = await setup();
    const { turn } = await postUserMessage(db, { threadId: thread.id, text: "một", actor: { id: "u", role: "editor" } }, at(1));
    expect((await nextPendingAgentTurns(db, at(2), 10)).map((m) => m.id)).toEqual([turn!.id]);
    expect(await markAgentTurnRunning(db, turn!.id, at(2))).toBe(true);
    expect(await markAgentTurnRunning(db, turn!.id, at(2))).toBe(false);
    expect((await postUserMessage(db, { threadId: thread.id, text: "hai", actor: { id: "u", role: "editor" } }, at(3))).turn).toBeNull();
    expect(await nextPendingAgentTurns(db, at(3), 10)).toEqual([]);
    await updateRunningTurn(db, turn!.id, { text: "Đang đọc…", parts: [{ kind: "text", text: "Đang đọc…" }], phase: { kind: "writing" } }, at(4));
    expect(messageView((await listMessages(db, thread.id)).find((m) => m.id === turn!.id)!)).toMatchObject({ status: "running", phase: { kind: "writing" }, parts: [{ kind: "text" }] });
    await finishTurn(db, turn!.id, { status: "done", text: "Xong", parts: [{ kind: "text", text: "Xong" }], costUsd: 0.02 }, at(5));
    const next = (await queueFollowUp(db, thread.id, at(5)))!;
    expect((await turnInput(db, next)).map((m) => m.text)).toEqual(["hai"]);
    expect(await queueFollowUp(db, thread.id, at(6))).toBeNull();
  });

  it("two workers taking the same turn at once: one gets it", async () => {
    const { db, thread } = await setup();
    const { turn } = await postUserMessage(db, { threadId: thread.id, text: "một", actor: { id: "u", role: "editor" } }, at(1));
    expect((await Promise.all([1, 2, 3].map(() => markAgentTurnRunning(db, turn!.id, at(2))))).filter(Boolean)).toHaveLength(1);
  });

  it("a stopped worker's turn goes back in line; a stop cancels a waiting turn or asks a running one to end", async () => {
    const { db, thread } = await setup();
    const { turn } = await postUserMessage(db, { threadId: thread.id, text: "x", actor: { id: "u", role: "editor" } }, at(1));
    await markAgentTurnRunning(db, turn!.id, at(2));
    expect(await orphanedAgentTurns(db, [])).toEqual([turn!.id]);
    expect(await orphanedAgentTurns(db, [turn!.id])).toEqual([]);
    await requeueAgentTurn(db, turn!.id, at(3));
    expect((await nextPendingAgentTurns(db, at(3), 10)).map((m) => m.id)).toEqual([turn!.id]);
    await markAgentTurnRunning(db, turn!.id, at(4));
    expect(await requestCancel(db, turn!.id, at(5))).toMatchObject({ status: "running", cancel_requested: true });
    const other = await createThread(db, { projectId: thread.project_id, kind: "project", title: "B", createdBy: "u" }, T0);
    const waiting = (await postUserMessage(db, { threadId: other.id, text: "y", actor: { id: "u", role: "editor" } }, at(6))).turn!;
    expect((await requestCancel(db, waiting.id, at(7))).status).toBe("cancelled");
  });

  it("a rate-limited turn waits until its time; Studio notes may continue the agent; automatic turns are counted", async () => {
    const { db, thread } = await setup();
    const { turn } = await postUserMessage(db, { threadId: thread.id, text: "x", actor: { id: "u", role: "editor" } }, at(1));
    await markAgentTurnRunning(db, turn!.id, at(2));
    await finishTurn(db, turn!.id, { status: "rate_limited", text: "", parts: [], notBefore: at(600) }, at(3));
    expect(await nextPendingAgentTurns(db, at(100), 10)).toEqual([]);
    expect((await nextPendingAgentTurns(db, at(601), 10)).map((m) => m.id)).toEqual([turn!.id]);
    await markAgentTurnRunning(db, turn!.id, at(602));
    await finishTurn(db, turn!.id, { status: "done", text: "ok", parts: [] }, at(603));
    const note = await postSystemMessage(db, { threadId: thread.id, text: "Render xem trước xong", trigger: "job", continueAgent: true }, at(700));
    expect(note.turn).toMatchObject({ trigger: "job", status: "pending" });
    expect(await automaticTurnsInARow(db, thread.id)).toBe(1);
    expect((await postSystemMessage(db, { threadId: thread.id, text: "chỉ báo", trigger: "system" }, at(701))).turn).toBeNull();
  });

  it("an archived thread takes no messages", async () => {
    const { db, thread } = await setup();
    await archiveThread(db, thread.id, at(1));
    await expect(postUserMessage(db, { threadId: thread.id, text: "x", actor: { id: "u", role: "editor" } }, at(2))).rejects.toThrow(/lưu trữ/);
  });
});
