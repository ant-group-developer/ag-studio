import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateWorkspaceFile, validatorFor } from "../src/index.js";

const SRC = "src_01J0000000000000000000000A";
const V = "v1";

function workspace(withIndex = true) {
  const dir = mkdtempSync(join(tmpdir(), "validators-video-"));
  mkdirSync(join(dir, "videos", V, "sources"), { recursive: true });
  if (withIndex) {
    writeFileSync(join(dir, "videos", V, "sources", "index.json"), JSON.stringify({
      schema_version: "studio.video-sources/v1", video_id: V,
      sources: [{ source_id: SRC, shots: [{ shot_id: "s000-000", in: 0, out: 10 }, { shot_id: "s000-001", in: 10, out: 20 }] }],
    }));
  }
  return dir;
}
const write = (dir: string, name: string, v: unknown) => writeFileSync(join(dir, "videos", V, name), JSON.stringify(v));
const row = (shot_id: string, inS: number, out: number) => ({ source_id: SRC, shot_id, in: inS, out, score: 4, tags: [], usable: true, note: "", speech: "none" });
const plan = (shots: unknown[], over: Record<string, unknown> = {}) => ({
  schema_version: "studio.edit-plan/v1", narration: "tts", language: "vi", target_seconds: 30, shots,
  lines: [{ line_id: "L001", text: "Xin chào" }], texts: [], music_mood: null, ...over,
});
const shot = (order: number, shot_id: string, inS: number, out: number, line_id: string | null = null) =>
  ({ order, shot_id, source_id: SRC, in: inS, out, line_id, transition: "cut", section_title: null, note: "" });

describe("checks of a video's survey and edit plan", () => {
  it("are found by path", () => {
    expect(validatorFor(`videos/${V}/survey.json`)).toBe("survey");
    expect(validatorFor(`videos/${V}/edit-plan.json`)).toBe("edit_plan");
  });

  it("a survey: its shots must be the video's, unscored shots are a warning", () => {
    const dir = workspace();
    write(dir, "survey.json", { schema_version: "harness.survey-index/v2", shots: [row("s000-000", 0, 10)] });
    expect(validateWorkspaceFile(dir, `videos/${V}/survey.json`)).toEqual([{ level: "warning", code: "unscored", message: "1 cảnh chưa chấm (s000-001)" }]);
    write(dir, "survey.json", { schema_version: "harness.survey-index/v2", shots: [row("s000-007", 0, 10)] });
    expect(validateWorkspaceFile(dir, `videos/${V}/survey.json`)[0]).toMatchObject({ level: "error", code: "unknown_shot" });
    write(dir, "survey.json", { schema_version: "harness.survey-index/v2", shots: [{ shot_id: "x" }] });
    expect(validateWorkspaceFile(dir, `videos/${V}/survey.json`)[0]).toMatchObject({ level: "error", code: "schema" });
  });

  it("an edit plan: lines, texts and shots must hold together, inside the video's shots", () => {
    const dir = workspace();
    write(dir, "edit-plan.json", plan([shot(1, "s000-000", 1, 8, "L001"), shot(2, "s000-001", 12, 18)]));
    expect(validateWorkspaceFile(dir, `videos/${V}/edit-plan.json`)).toEqual([]);
    write(dir, "edit-plan.json", plan([shot(1, "s000-000", 1, 8, "L002"), shot(1, "s000-001", 12, 25)], { texts: [{ text_id: "T001", kind: "title", text: "A", at_order: 9, offset_s: 0, duration: 2, position: "top_left" }] }));
    expect(validateWorkspaceFile(dir, `videos/${V}/edit-plan.json`).map((i) => i.code)).toEqual(["duplicate_order", "unknown_line", "line_unused", "text_anchor"]);
    write(dir, "edit-plan.json", plan([shot(1, "s000-001", 12, 25, "L001")]));
    expect(validateWorkspaceFile(dir, `videos/${V}/edit-plan.json`).map((i) => i.code)).toEqual(["outside_shot"]);
    const bare = workspace(false);
    write(bare, "edit-plan.json", plan([shot(1, "s000-000", 1, 8, "L001")]));
    expect(validateWorkspaceFile(bare, `videos/${V}/edit-plan.json`).map((i) => i.code)).toEqual(["no_sources"]);
  });

  it("an edit plan against the scene selection: editing advice as warnings, what the timeline rejects as errors", () => {
    const dir = workspace();
    write(dir, "survey.json", { schema_version: "harness.survey-index/v2", shots: [row("s000-000", 0, 10), { ...row("s000-001", 10, 20), usable: false, note: "rung" }] });
    // the length is off the plan's 30 s target in every case here
    const advice = () => validateWorkspaceFile(dir, `videos/${V}/edit-plan.json`).filter((i) => i.code !== "duration_off_target");
    write(dir, "edit-plan.json", plan([shot(1, "s000-000", 1, 4, "L001"), shot(2, "s000-000", 4.5, 8)]));
    expect(advice()).toEqual([{ level: "warning", code: "jump_cut", message: expect.stringContaining("jump cut") }]);
    write(dir, "edit-plan.json", plan([shot(1, "s000-000", 1, 8, "L001"), shot(2, "s000-001", 12, 18)]));
    expect(advice()).toEqual([{ level: "warning", code: "not_usable", message: expect.stringContaining("rung") }]);
    write(dir, "edit-plan.json", plan([shot(1, "s000-000", 3, 8, "L001"), shot(2, "s000-000", 0, 0.3)]));
    expect(advice()).toEqual([{ level: "error", code: "too_short", message: expect.any(String) }]);
    // a survey that does not check out has its own errors: the plan is checked against the shots only
    write(dir, "survey.json", { schema_version: "harness.survey-index/v2", shots: [{ shot_id: "x" }] });
    expect(advice()).toEqual([]);
  });
});
