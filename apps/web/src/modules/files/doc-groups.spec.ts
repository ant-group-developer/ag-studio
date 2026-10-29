import { describe, expect, it } from "vitest";
import type { WorkspaceEntry } from "../../api/workspace-client";
import { docGroups, newDocPath } from "./doc-groups";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const VIDEOS = [{ id: V1, idx: 1, title: "Tràng An" }, { id: V2, idx: 2, title: "Bái Đính" }];
const file = (path: string, mtime = "2026-10-20T00:00:00.000Z"): WorkspaceEntry => ({ path, kind: "file", size: 10, mtime, access: "write" });

const ENTRIES: WorkspaceEntry[] = [
  { path: "channel", kind: "dir", size: 0, mtime: "2026-10-20T00:00:00.000Z", access: "write" },
  file(".studio/status.json"), file("CLAUDE.md"), file("memory/lessons.md"), file("threads/t1/SUMMARY.md"), file("skills/x/SKILL.md"),
  file(`inputs/${V1}/shots.json`), file(`inputs/${V1}/README.md`),
  file("channel/style.md"), file("channel/branding.md"), file("channel/strategy.md"), file("channel/style.json"), file("channel/notes.md"),
  file("research/report.md"), file("research/2026-10-12-xu-huong-vn.md", "2026-10-12T00:00:00.000Z"), file("research/2026-10-12-xu-huong-vn.json"),
  file("research/2026-10-14-chu-de-ninh-binh.md", "2026-10-14T00:00:00.000Z"), file("research/style-2026-10-15-2/README.md"), file("research/style-2026-10-15-2/R1-sheet-1.jpg"),
  file("context/README.md"), file("context/khoi-dong.md"), file("context/audio/nhac.mp3"),
  file(`videos/${V1}/SUMMARY.md`), file(`videos/${V1}/timeline.json`), file(`videos/${V1}/survey.json`), file(`videos/${V1}/sources/index.json`),
  file(`videos/${V1}/edit-plan.json`), file(`videos/${V1}/edit-plan.md`), file(`videos/${V1}/scenes.md`), file(`videos/${V1}/brief.md`),
  file(`videos/${V1}/renders/2026-10-15-render-preview-r1-de405177.md`, "2026-10-15T01:00:00.000Z"),
  file(`videos/${V1}/renders/2026-10-15-render-preview-r3-1a514e22.md`, "2026-10-15T03:00:00.000Z"),
  file(`videos/${V1}/renders/2026-10-15-render-preview-r3-1a514e22/inspect.json`), file(`videos/${V1}/renders/frames/r1-0005.0s.jpg`),
  file(`videos/${V1}/thumbnails/02.jpg`), file(`videos/${V1}/thumbnails/01.jpg`), file(`videos/${V1}/thumbnails/README.md`),
  file(`videos/${V2}/edit-plan.json`),
  file("videos/gone/brief.md"),
];

const names = (g: { items: { nameKey?: string; name: string }[] }) => g.items.map((x) => x.nameKey ?? x.name);

describe("docGroups", () => {
  it("names the channel's, each video's, research and added files, without Studio's and the agent's own", () => {
    const groups = docGroups(ENTRIES, VIDEOS, { researchTitles: new Map([["research/2026-10-12-xu-huong-vn.md", "Xu hướng Việt Nam"]]) });
    expect(groups.map((g) => g.key)).toEqual(["channel", `video:${V2}`, `video:${V1}`, "research", "context"]);
    const [channel, v2, v1, research, context] = groups;
    expect(names(channel!)).toEqual(["strategy", "branding", "style", "agentNotes", "notes"]);
    // the plan as markdown when there is one, renders newest first, thumbnails by number; the cut's own files hidden
    expect(names(v1!)).toEqual(["brief", "scenes", "editPlan", "thumbnails", "thumbnail", "thumbnail", "renderPreview", "renderPreview"]);
    expect(v1!.items.find((x) => x.nameKey === "editPlan")!.path).toBe(`videos/${V1}/edit-plan.md`);
    expect(v1!.items.filter((x) => x.nameKey === "renderPreview").map((x) => x.params?.n)).toEqual([3, 1]);
    expect(v1!.items.filter((x) => x.nameKey === "thumbnail").map((x) => x.params?.n)).toEqual(["01", "02"]);
    expect(names(v2!)).toEqual(["editPlan"]);
    expect(v2!.items[0]!.path).toBe(`videos/${V2}/edit-plan.json`);
    expect(names(research!)).toEqual(["researchReport", "styleWatch", "2026-10-14-chu-de-ninh-binh", "Xu hướng Việt Nam"]);
    expect(research!.items[1]!.params).toEqual({ date: "2026-10-15", n: 2 });
    expect(names(context!)).toEqual(["audio/nhac.mp3", "khoi-dong.md"]);
    expect(context!.items[0]!.kind).toBe("audio");
    const all = groups.flatMap((g) => g.items.map((x) => x.path));
    for (const hidden of [".studio/status.json", "memory/lessons.md", "threads/t1/SUMMARY.md", "skills/x/SKILL.md", `inputs/${V1}/README.md`, "context/README.md", "channel/style.json", `videos/${V1}/SUMMARY.md`, `videos/${V1}/timeline.json`, "videos/gone/brief.md"]) {
      expect(all).not.toContain(hidden);
    }
  });

  it("puts the open video first, then the channel, and shows it while it has nothing yet", () => {
    const groups = docGroups([file("channel/strategy.md")], [...VIDEOS, { id: "v3", idx: 3, title: "Mới" }], { currentVideoId: "v3" });
    expect(groups.map((g) => g.key)).toEqual(["video:v3", "channel", "research"]);
    expect(groups[0]!.items).toEqual([]);
  });
});

describe("newDocPath", () => {
  it("names a new document as it was typed, beside the others", () => {
    expect(newDocPath("Ghi chú khán giả", "context", new Set())).toBe("context/Ghi chú khán giả.md");
    expect(newDocPath(" Đường đi: Bái Đính?  ", "videos/v1", new Set(["videos/v1/Đường đi Bái Đính.md"]))).toBe("videos/v1/Đường đi Bái Đính (2).md");
    expect(newDocPath("???", "context", new Set())).toBe("context/Tài liệu.md");
  });
});
