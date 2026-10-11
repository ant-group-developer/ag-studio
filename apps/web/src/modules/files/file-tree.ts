import type { FileAccess, WorkspaceEntry } from "../../api/workspace-client";

export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  access: FileAccess;
  children: TreeNode[];
}

const collator = new Intl.Collator("vi", { numeric: true, sensitivity: "base" });

/** The flat listing as nested folders: folders first, then files, each by name (numbers in order). */
export function buildTree(entries: WorkspaceEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", kind: "dir", size: 0, access: "write", children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);
  const ensureDir = (path: string): TreeNode => {
    const found = byPath.get(path);
    if (found) return found;
    const slash = path.lastIndexOf("/");
    const parent = ensureDir(slash < 0 ? "" : path.slice(0, slash));
    const node: TreeNode = { name: path.slice(slash + 1), path, kind: "dir", size: 0, access: "write", children: [] };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const e of entries) {
    if (e.kind === "dir") {
      const node = ensureDir(e.path);
      node.access = e.access;
      continue;
    }
    const slash = e.path.lastIndexOf("/");
    const parent = ensureDir(slash < 0 ? "" : e.path.slice(0, slash));
    const node: TreeNode = { name: e.path.slice(slash + 1), path: e.path, kind: "file", size: e.size, access: e.access, children: [] };
    parent.children.push(node);
    byPath.set(e.path, node);
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "dir" ? -1 : 1));
    for (const n of nodes) sort(n.children);
  };
  sort(root.children);
  return root.children;
}

/** The folders on the way to `path` (to open them when a file is shown). */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
