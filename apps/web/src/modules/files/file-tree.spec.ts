import { describe, expect, it } from "vitest";
import { ancestors, buildTree, isMarkdown } from "./file-tree";

const e = (path: string, kind: "file" | "dir" = "file", access: "write" | "read" = "write") => ({ path, kind, size: 1, mtime: "", access });

describe("buildTree", () => {
  it("nests the flat listing, folders first, names in natural order", () => {
    const tree = buildTree([e("videos", "dir"), e("videos/v10", "dir"), e("videos/v2", "dir"), e("videos/v2/brief.md"), e("CLAUDE.md"), e("context", "dir"), e(".studio", "dir", "read"), e(".studio/status.json", "file", "read")]);
    expect(tree.map((n) => n.name)).toEqual([".studio", "context", "videos", "CLAUDE.md"]);
    expect(tree[2]!.children.map((n) => n.name)).toEqual(["v2", "v10"]);
    expect(tree[2]!.children[0]!.children[0]).toMatchObject({ path: "videos/v2/brief.md", kind: "file" });
    expect(tree[0]!.access).toBe("read");
  });

  it("makes the folders of a file listed without them", () => {
    expect(buildTree([e("a/b/c.md")])[0]).toMatchObject({ path: "a", children: [{ path: "a/b", children: [{ path: "a/b/c.md" }] }] });
  });
});

describe("helpers", () => {
  it("lists the folders above a path, and knows markdown", () => {
    expect(ancestors("videos/v1/brief.md")).toEqual(["videos", "videos/v1"]);
    expect(ancestors("CLAUDE.md")).toEqual([]);
    expect([isMarkdown("a.md"), isMarkdown("a.MARKDOWN"), isMarkdown("a.json")]).toEqual([true, true, false]);
  });
});
