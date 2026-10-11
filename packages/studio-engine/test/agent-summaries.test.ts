import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptLesson, createProject, createThread, createVideo, dismissLesson, finishTurn, listFileVersions, listLessonProposals, markAgentTurnRunning,
  postUserMessage, saveThreadSummary, seedWorkspace, summaryPath, summaryPrompt, threadsToSummarize, videoThread,
} from "../src/index.js";
import { world } from "./helpers.js";

const T0 = "2026-10-10T08:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

function setup() {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'T', ?, ?)", [T0, T0]);
  const project = createProject(w.db, "team-1", { name: "A", description: "", language: "vi", aspect: "16:9" }, "u", T0);
  const dir = seedWorkspace(mkdtempSync(join(tmpdir(), "sum-")), project, T0);
  const thread = createThread(w.db, { projectId: project.id, kind: "project", title: "Ý tưởng", createdBy: "u" }, T0);
  const talk = (text: string, min: number) => {
    const { turn } = postUserMessage(w.db, { threadId: thread.id, text, actor: { id: "u", role: "editor" } }, at(min));
    markAgentTurnRunning(w.db, turn!.id, at(min));
    finishTurn(w.db, turn!.id, { status: "done", text: "Đã ghi.", parts: [] }, at(min));
  };
  return { ...w, project, dir, thread, talk };
}

describe("thread summaries", () => {
  it("picks threads quiet for a while, with something new since their last summary", () => {
    const { db, thread, talk, project, dir } = setup();
    talk("Làm video phố cổ", 0);
    expect(threadsToSummarize(db, at(5))).toEqual([]);
    expect(threadsToSummarize(db, at(11)).map((t) => t.id)).toEqual([thread.id]);
    saveThreadSummary(db, { thread, dir, summary: { summary_md: "## Mục tiêu\nPhố cổ", lessons: [] }, now: at(11) });
    expect(threadsToSummarize(db, at(30))).toEqual([]);
    talk("Thêm nhạc", 31);
    expect(threadsToSummarize(db, at(45)).map((t) => t.id)).toEqual([thread.id]);
    postUserMessage(db, { threadId: thread.id, text: "còn chờ", actor: { id: "u", role: "editor" } }, at(46));
    expect(threadsToSummarize(db, at(90))).toEqual([]);
    void project;
  });

  it("writes SUMMARY.md where the thread's work lives, and proposes only new lessons", () => {
    const { db, thread, dir, project, talk } = setup();
    talk("x", 0);
    writeFileSync(join(dir, "memory", "lessons.md"), "# Bài học\n- Mở đầu dưới 5 giây. _(từ \"Huế\", 2026-10-01)_\n");
    const out = saveThreadSummary(db, { thread, dir, now: at(20), summary: {
      summary_md: "## Mục tiêu\nVideo phố cổ.", lessons: ["Mở đầu dưới 5 giây.", "Không dùng nhạc buồn.", "không  dùng nhạc buồn."],
    } });
    expect(out).toEqual({ path: `threads/${thread.id}/SUMMARY.md`, lessons: 1 });
    expect(readFileSync(join(dir, "threads", thread.id, "SUMMARY.md"), "utf8")).toContain("# Tóm tắt: Ý tưởng\n\n## Mục tiêu\nVideo phố cổ.");
    expect(listFileVersions(db, project.id, out.path)[0]?.author_kind).toBe("studio");
    expect(listLessonProposals(db, project.id).map((l) => l.text)).toEqual(["Không dùng nhạc buồn."]);
    const v = createVideo(db, project.id, { title: "Huế", createdBy: "u" }, T0);
    expect(summaryPath(videoThread(db, { projectId: project.id, videoId: v.id, title: "Huế", createdBy: "u" }, T0))).toBe(`videos/${v.id}/SUMMARY.md`);
  });

  it("a person accepts a lesson into memory/lessons.md, or dismisses it", () => {
    const { db, thread, dir, project, talk } = setup();
    talk("x", 0);
    saveThreadSummary(db, { thread, dir, now: at(20), summary: { summary_md: "s", lessons: ["Không dùng nhạc buồn.", "Chữ địa danh viết hoa."] } });
    const [a, b] = listLessonProposals(db, project.id, { status: "proposed" });
    acceptLesson(db, { projectId: project.id, lessonId: a!.id, dir, userId: "u", now: at(30) });
    expect(readFileSync(join(dir, "memory", "lessons.md"), "utf8")).toContain("- Không dùng nhạc buồn. _(từ \"Ý tưởng\", 2026-10-10)_");
    expect(listFileVersions(db, project.id, "memory/lessons.md")[0]).toMatchObject({ author_kind: "user", author_id: "u" });
    expect(() => acceptLesson(db, { projectId: project.id, lessonId: a!.id, dir, userId: "u" })).toThrow(/đã được xử lý/);
    dismissLesson(db, { projectId: project.id, lessonId: b!.id, userId: "u" });
    expect(listLessonProposals(db, project.id, { status: "proposed" })).toEqual([]);
  });

  it("asks for a summary and lessons, with the lessons already known", () => {
    const { db, thread, talk } = setup();
    talk("Làm video phố cổ", 0);
    const prompt = summaryPrompt(db, thread, "- Mở đầu dưới 5 giây.");
    expect(prompt).toContain("<bai_hoc_da_co>\n- Mở đầu dưới 5 giây.");
    expect(prompt).toContain("Làm video phố cổ");
  });
});
