import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProject, DEFAULT_PLAYBOOK, defaultPlaybookYaml, docStatus, loadPlaybook, playbookContextLines, playbookStatus, readFrontmatter, validateFileText,
  validatorFor, writeFrontmatter,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";

function ws() {
  const dir = mkdtempSync(join(tmpdir(), "playbook-"));
  for (const d of ["research", "channel", "videos/v1", ".studio"]) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}
const write = (dir: string, rel: string, text: string) => writeFileSync(join(dir, ...rel.split("/")), text);

describe("frontmatter", () => {
  it("reads and writes the YAML block, keeping the body", () => {
    expect(readFrontmatter("---\nstatus: done\ntitle: Huế\n---\n# Huế\n")).toMatchObject({ present: true, data: { status: "done", title: "Huế" }, body: "# Huế\n" });
    expect(readFrontmatter("# không có\n")).toMatchObject({ present: false, body: "# không có\n" });
    expect(readFrontmatter("---\n: : :\n---\n").error).toMatch(/YAML sai/);
    expect(writeFrontmatter("# Huế\n", { status: "done" })).toBe("---\nstatus: done\n---\n# Huế\n");
    expect(writeFrontmatter("---\ntitle: Huế\n---\nthân\n", { status: "skipped" })).toBe("---\ntitle: Huế\nstatus: skipped\n---\nthân\n");
    expect([docStatus("---\nstatus: done\n---\n"), docStatus("x"), docStatus("---\nstatus: lạ\n---\n")]).toEqual(["done", "draft", "draft"]);
  });
});

describe("file validators", () => {
  it("knows which check a path gets", () => {
    expect(["videos/a/brief.md", "channel/branding.md", "videos/a/youtube-kit.md", "channel/style.json", ".studio/playbook.yaml", "x.json", "context/a.md", "a.png"].map(validatorFor))
      .toEqual(["brief", "branding", "youtube_kit", "style", "playbook", "json", "markdown", null]);
  });

  it("a brief needs a title; the branding's text look must be readable", () => {
    expect(validateFileText("videos/a/brief.md", "---\nstatus: draft\n---\n")[0]).toMatchObject({ level: "error", message: expect.stringContaining("title") });
    expect(validateFileText("videos/a/brief.md", "---\ntitle: Huế\ntarget_seconds: 360\nnarration: none\n---\n")).toEqual([]);
    expect(validateFileText("videos/a/brief.md", "# không frontmatter\n")[0]?.code).toBe("frontmatter_missing");
    const unreadable = "---\ntext_look: { text_color: '#FFFFFF', outline_color: '#EEEEEE', box_color: null, size: m }\n---\n";
    expect(validateFileText("channel/branding.md", unreadable).map((i) => i.code)).toEqual(["text_look_no_contrast"]);
    const fine = "---\ntext_look: { text_color: '#FFFFFF', outline_color: '#111111', box_color: null, size: m }\nmusic_mood: [calm]\n---\n";
    expect(validateFileText("channel/branding.md", fine)).toEqual([]);
    expect(validateFileText("channel/branding.md", "---\nstatus: draft\n---\n").map((i) => i.level)).toEqual(["warning"]);
  });

  it("a YouTube kit needs three different titles and a description", () => {
    const kit = (titles: string[], body: string) => `---\ntitles: ${JSON.stringify(titles)}\ntags: [hue]\nhashtags: ['#Hue']\n---\n${body}`;
    expect(validateFileText("videos/a/youtube-kit.md", kit(["A", "B", "C"], "Mô tả"))).toEqual([expect.objectContaining({ level: "warning", code: "thumbnails_missing" })]);
    expect(validateFileText("videos/a/youtube-kit.md", kit(["A", "A", "C"], "")).map((i) => i.code).sort()).toEqual(["description_missing", "duplicate_title", "thumbnails_missing"]);
    expect(validateFileText("videos/a/youtube-kit.md", kit(["A"], "x"))[0]?.code).toBe("schema");
  });

  it("checks JSON, YAML of the playbook, and leaves other files alone", () => {
    expect(validateFileText("research/a.json", "{oops")[0]?.code).toBe("json");
    expect(validateFileText(".studio/playbook.yaml", "schema_version: studio.playbook/v1\nsteps: []\n")[0]?.code).toBe("schema");
    expect(validateFileText("context/a.md", "# ok\n")).toEqual([]);
  });
});

describe("playbook", () => {
  it("uses the default unless the project's file checks out; a broken one says why", () => {
    const dir = ws();
    expect(loadPlaybook(dir)).toMatchObject({ custom: false, issues: [] });
    write(dir, ".studio/playbook.yaml", "schema_version: studio.playbook/v1\nsteps:\n  - key: brief\n    scope: video\n    title: Brief\n    requires: [nope]\n    outputs: [{ path: 'videos/{video}/brief.md', role: doc }]\n    prompts: { do: Viết brief }\n");
    const bad = loadPlaybook(dir);
    expect(bad.custom).toBe(false);
    expect(bad.issues[0]?.message).toContain("không có bước \"nope\"");
    write(dir, ".studio/playbook.yaml", "schema_version: studio.playbook/v1\nsteps:\n  - key: brief\n    scope: video\n    title: Brief\n    outputs: [{ path: 'videos/{video}/brief.md', role: doc }]\n    prompts: { do: Viết brief }\n");
    expect(loadPlaybook(dir)).toMatchObject({ custom: true, playbook: { steps: [{ key: "brief" }] } });
    write(dir, ".studio/playbook.yaml", defaultPlaybookYaml());
    expect(loadPlaybook(dir)).toMatchObject({ custom: true, issues: [] });
    expect(loadPlaybook(dir).playbook).toEqual(DEFAULT_PLAYBOOK);
    expect(DEFAULT_PLAYBOOK.steps.map((s) => s.key)).toEqual(["research", "channel", "style", "branding", "brief", "prepare", "scenes", "edit-plan", "timeline", "preview", "youtube-kit", "thumbnail", "final"]);
  });

  it("says where each step stands and suggests the next ones", () => {
    const { db } = world();
    db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'T', ?, ?)", [NOW, NOW]);
    const p = createProject(db, "team-1", { name: "A", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
    const dir = ws();
    const st0 = playbookStatus(db, dir, { projectId: p.id, videoId: "v1" });
    expect(st0.project.map((s) => s.status)).toEqual(["missing", "missing", "missing", "missing"]);
    expect(st0.next).toEqual([{ scope: "project", key: "research" }, { scope: "video", key: "brief" }]);

    write(dir, "research/report.md", "---\nstatus: done\n---\n# Báo cáo\n");
    write(dir, "channel/strategy.md", "---\nstatus: done\n---\n# Chiến lược\n");
    write(dir, "channel/branding.md", "---\nstatus: done\ntext_look: { text_color: '#FFFFFF', outline_color: '#FAFAFA', box_color: null, size: m }\n---\n");
    write(dir, "channel/style.md", "---\nstatus: skipped\n---\n");
    write(dir, "videos/v1/brief.md", "---\ntitle: Huế\n---\n");
    const st1 = playbookStatus(db, dir, { projectId: p.id, videoId: "v1", facts: (key) => (key === "prepare" ? { status: "running", detail: "2/5 video" } : undefined) });
    expect(Object.fromEntries([...st1.project, ...st1.video!].map((s) => [s.key, s.status]))).toMatchObject({
      research: "done", channel: "done", style: "skipped", branding: "invalid", brief: "draft", prepare: "running", scenes: "missing",
    });
    expect(st1.project.find((s) => s.key === "branding")!.issues[0]!.message).toContain("channel/branding.md: text_look");
    expect(st1.next).toEqual([{ scope: "project", key: "branding" }, { scope: "video", key: "brief" }]);
    expect(st1.video!.find((s) => s.key === "brief")!.prompts.do).toContain("videos/v1/brief.md");

    // the research changes after the strategy was done: the strategy is stale
    write(dir, "research/report.md", "---\nstatus: done\n---\n# Báo cáo mới\n");
    const st2 = playbookStatus(db, dir, { projectId: p.id, videoId: "v1" });
    expect(st2.project.find((s) => s.key === "channel")).toMatchObject({ status: "stale", staleBecause: ["research"] });
    // rewriting the strategy makes it current again
    write(dir, "channel/strategy.md", "---\nstatus: done\n---\n# Chiến lược mới\n");
    expect(playbookStatus(db, dir, { projectId: p.id, videoId: "v1" }).project.find((s) => s.key === "channel")!.status).toBe("done");

    const lines = playbookContextLines(st1);
    expect(lines[1]).toBe("- Kênh: research ✓ · channel ✓ · style – · branding ✗");
    expect(lines.some((l) => l.startsWith("Bước gợi ý tiếp theo: Branding (channel/branding.md)"))).toBe(true);
  });
});
