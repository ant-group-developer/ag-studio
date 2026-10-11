import { describe, expect, it } from "vitest";
import {
  CreateProjectSchema, ProjectSettingsSchema, UpdateProjectSchema, VIDEO_STATUSES, projectSettingsOf,
} from "../src/studio-workspace.js";

describe("project settings", () => {
  it("defaults to auto-fix and auto-continue on, no model or skills pinned", () => {
    expect(ProjectSettingsSchema.parse({})).toEqual({ auto_fix: true, auto_continue: true });
  });

  it("refuses unknown keys and bad values", () => {
    expect(ProjectSettingsSchema.safeParse({ colour: "red" }).success).toBe(false);
    expect(ProjectSettingsSchema.safeParse({ target_seconds: -5 }).success).toBe(false);
    expect(ProjectSettingsSchema.safeParse({ team_skills: ["a", "a"] }).success).toBe(true);
  });

  it("reads a stored value, falling back to the defaults when it is broken", () => {
    expect(projectSettingsOf('{"model":"sonnet","target_seconds":90}')).toEqual({ model: "sonnet", target_seconds: 90, auto_fix: true, auto_continue: true });
    expect(projectSettingsOf("not json")).toEqual({ auto_fix: true, auto_continue: true });
    expect(projectSettingsOf(null)).toEqual({ auto_fix: true, auto_continue: true });
  });
});

describe("creating and editing a project", () => {
  it("needs a name; the channel link must be a YouTube URL or a handle", () => {
    expect(CreateProjectSchema.safeParse({ name: "  " }).success).toBe(false);
    const ok = CreateProjectSchema.parse({ name: " Du lịch Việt ", channelUrl: "https://www.youtube.com/@dulichviet" });
    expect(ok).toMatchObject({ name: "Du lịch Việt", channelUrl: "https://www.youtube.com/@dulichviet", language: "vi", aspect: "16:9" });
    expect(CreateProjectSchema.parse({ name: "A", channelUrl: "@dulichviet" }).channelUrl).toBe("@dulichviet");
    expect(CreateProjectSchema.safeParse({ name: "A", channelUrl: "https://evil.example.com/x" }).success).toBe(false);
    expect(CreateProjectSchema.safeParse({ name: "A", aspect: "4:3" }).success).toBe(false);
  });

  it("an edit changes only what it names", () => {
    expect(UpdateProjectSchema.parse({ description: "Kênh du lịch chậm" })).toEqual({ description: "Kênh du lịch chậm" });
    expect(UpdateProjectSchema.safeParse({ settings: { auto_fix: "yes" } }).success).toBe(false);
  });

  it("knows the video statuses", () => {
    expect(VIDEO_STATUSES).toEqual(["draft", "in_progress", "rendering", "done"]);
  });
});
