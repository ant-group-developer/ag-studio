import { describe, it, expect } from "vitest";
import { buildFolderTree } from "./folder-tree";
import type { FolderItem } from "../api/ag-go-client";

describe("buildFolderTree", () => {
  it("returns empty array for empty input", () => {
    expect(buildFolderTree([])).toEqual([]);
  });

  it("returns root folders when all items have no parent", () => {
    const folders: FolderItem[] = [
      { id: "1", name: "Folder A", parentId: null, usableSegments: 5 },
      { id: "2", name: "Folder B", parentId: null, usableSegments: 3 },
    ];

    const tree = buildFolderTree(folders);
    expect(tree).toHaveLength(2);
    expect(tree[0].key).toBe("1");
    expect(tree[0].title).toBe("Folder A");
    expect(tree[0].usableSegments).toBe(5);
    expect(tree[0].children).toHaveLength(0);
    expect(tree[1].key).toBe("2");
  });

  it("nests children under their parent correctly", () => {
    const folders: FolderItem[] = [
      { id: "root", name: "Root", parentId: null, usableSegments: 10 },
      { id: "child1", name: "Child 1", parentId: "root", usableSegments: 4 },
      { id: "child2", name: "Child 2", parentId: "root", usableSegments: 6 },
    ];

    const tree = buildFolderTree(folders);
    expect(tree).toHaveLength(1);
    expect(tree[0].key).toBe("root");
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].key).toBe("child1");
    expect(tree[0].children[1].key).toBe("child2");
  });

  it("handles multiple levels of nesting", () => {
    const folders: FolderItem[] = [
      { id: "a", name: "A", parentId: null, usableSegments: 0 },
      { id: "b", name: "B", parentId: "a", usableSegments: 0 },
      { id: "c", name: "C", parentId: "b", usableSegments: 2 },
    ];

    const tree = buildFolderTree(folders);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].children[0].key).toBe("c");
  });

  it("places orphaned children at the root level", () => {
    const folders: FolderItem[] = [
      { id: "orphan", name: "Orphan", parentId: "nonexistent", usableSegments: 1 },
    ];

    const tree = buildFolderTree(folders);
    expect(tree).toHaveLength(1);
    expect(tree[0].key).toBe("orphan");
  });
});
