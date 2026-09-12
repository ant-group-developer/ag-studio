import { copyFile, link, mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Checksum } from "@harness/contracts";
import { canonicalDigest, sha256File } from "./checksum.js";

export interface DirectoryEntry { path: string; checksum: Checksum; size_bytes: number }

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(root, p, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Every regular file below `dir`, relative forward-slash paths, sorted, with sha256 and size. */
export async function listDirectoryFiles(dir: string): Promise<DirectoryEntry[]> {
  if (!(await stat(dir)).isDirectory()) throw new Error(`not a directory: ${dir}`);
  const files: string[] = [];
  await walk(dir, dir, files);
  const entries: DirectoryEntry[] = [];
  for (const f of files) {
    const { checksum, size_bytes } = await sha256File(f);
    entries.push({ path: relative(dir, f).split("\\").join("/"), checksum, size_bytes });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The artifact-level checksum of a directory is the canonical digest of its file listing. */
export function directoryDigest(entries: DirectoryEntry[]): { checksum: Checksum; size_bytes: number } {
  return { checksum: canonicalDigest(entries), size_bytes: entries.reduce((n, e) => n + e.size_bytes, 0) };
}

export async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = join(src, e.name); const d = join(dest, e.name);
    if (e.isDirectory()) await copyTree(s, d);
    else { try { await link(s, d); } catch { await copyFile(s, d); } }
  }
}
