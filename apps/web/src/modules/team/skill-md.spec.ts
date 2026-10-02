import { describe, expect, it } from "vitest";
import { parseSkillMarkdown, skillFileName, STARTER_TEMPLATES, toSkillMarkdown } from "./skill-md";

describe("team skill markdown files", () => {
  it("reads name, purpose and steps from the frontmatter and keeps the body", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: Quy chuẩn tiêu đề\ndescription: \"Tiêu đề bắt mắt, đúng sự thật\"\napplies_to: [youtube-kit, plan-episodes, render]\n---\n\n# Tiêu đề\n- ≤ 60 ký tự\n",
      "file.md",
    );
    expect(parsed).toEqual({
      name: "Quy chuẩn tiêu đề",
      purpose: "Tiêu đề bắt mắt, đúng sự thật",
      appliesTo: ["plan-episodes", "youtube-kit"],
      content: "# Tiêu đề\n- ≤ 60 ký tự",
    });
  });

  it("takes the name from the first heading, then the file name, when there is no frontmatter", () => {
    expect(parseSkillMarkdown("# Nhịp dựng\nCắt mỗi 3–5 giây", "x.md")).toMatchObject({ name: "Nhịp dựng", appliesTo: [], purpose: "" });
    expect(parseSkillMarkdown("Chỉ có nội dung", "quy-chuan-nhac.md")).toMatchObject({ name: "quy-chuan-nhac", content: "Chỉ có nội dung" });
    expect(parseSkillMarkdown("---\napplies_to: rnd, branding\n---\nBody", "a.md").appliesTo).toEqual(["rnd", "branding"]);
  });

  it("writes a file the import reads back the same", () => {
    const skill = { name: "Mục đích: kênh ẩm thực", purpose: "Vì sao \"làm\" kênh", appliesTo: ["rnd" as const], content: "Kể chuyện món ăn Việt" };
    const md = toSkillMarkdown(skill);
    expect(md.startsWith("---\nname: \"Mục đích: kênh ẩm thực\"\n")).toBe(true);
    expect(parseSkillMarkdown(md, "x.md")).toEqual(skill);
    expect(skillFileName("Quy chuẩn làm video!")).toBe("quy-chuan-lam-video.md");
  });

  it("ships a Vietnamese video-standards template that parses", () => {
    expect(STARTER_TEMPLATES.length).toBeGreaterThan(0);
    for (const tpl of STARTER_TEMPLATES) {
      const parsed = parseSkillMarkdown(toSkillMarkdown(tpl), "x.md");
      expect(parsed.name).toBe(tpl.name);
      expect(parsed.content.length).toBeGreaterThan(200);
    }
  });
});
