import type { FolderItem } from "../api/ag-go-client";

export interface FolderTreeNode {
  key: string;
  title: string;
  children: FolderTreeNode[];
  usableVideos: number;
}

export function buildFolderTree(folders: FolderItem[]): FolderTreeNode[] {
  const nodeMap = new Map<string, FolderTreeNode>();

  for (const folder of folders) {
    nodeMap.set(folder.id, {
      key: folder.id,
      title: folder.name,
      children: [],
      usableVideos: folder.usableVideos,
    });
  }

  const roots: FolderTreeNode[] = [];

  for (const folder of folders) {
    const node = nodeMap.get(folder.id)!;
    if (folder.parentId === null) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(folder.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
  }

  return roots;
}
