/**
 * What an agent turn changed in the workspace (migration 0038): every file version the turn wrote — found by
 * `scanWorkspace` after it, or written by a Studio tool during it — compared with the version just before the turn.
 */
import { StudioRunError } from "../errors.js";
import type { StudioDb } from "../studio-db.js";
import { isTextPath, MAX_VERSIONED_TEXT_BYTES } from "./files.js";
import { lineDiff, type DiffHunk } from "./line-diff.js";

export type FileChangeKind = "added" | "modified" | "deleted";

/** One file a turn changed. `added`/`removed`: lines, when both sides are text kept with their version (≤ 1 MB). */
export interface ChangedFile {
  path: string; change: FileChangeKind; version_id: string; before_version_id: string | null; added?: number; removed?: number;
}

interface VersionText { id: string; sha256: string; content: string | null }

/** The version of `path` just before the one numbered `seq` (the one a change is compared with), if any. */
export async function versionBefore(db: StudioDb, projectId: string, path: string, seq: number): Promise<VersionText | undefined> {
  return db.get<VersionText>(
    "SELECT id, sha256, content FROM project_file_versions WHERE project_id = ? AND path = ? AND seq < ? ORDER BY seq DESC LIMIT 1",
    [projectId, path, seq],
  );
}

/**
 * The files turn `messageId` changed, by path: its last version of each against the version before its first one.
 * A file it made then removed, or put back as it was, is not listed.
 */
export async function turnChangedFiles(db: StudioDb, projectId: string, messageId: string): Promise<ChangedFile[]> {
  const groups = await db.all<{ path: string; first: number; last: number }>(
    `SELECT path, MIN(seq) AS first, MAX(seq) AS last FROM project_file_versions
      WHERE message_id = ? AND project_id = ? GROUP BY path ORDER BY path`,
    [messageId, projectId],
  );
  const out: ChangedFile[] = [];
  for (const g of groups) {
    const after = await db.get<VersionText>("SELECT id, sha256, content FROM project_file_versions WHERE seq = ?", [g.last]);
    if (!after) continue;
    const before = await versionBefore(db, projectId, g.path, g.first);
    const existed = !!before && before.sha256 !== "";
    const exists = after.sha256 !== "";
    if (!existed && !exists) continue;
    if (existed && exists && before!.sha256 === after.sha256) continue;
    const change: FileChangeKind = !existed ? "added" : !exists ? "deleted" : "modified";
    const row: ChangedFile = { path: g.path, change, version_id: after.id, before_version_id: before?.id ?? null };
    const oldText = existed ? before!.content : "";
    const newText = exists ? after.content : "";
    if (oldText !== null && newText !== null) {
      const d = lineDiff(oldText, newText, { context: 0 });
      if (d) { row.added = d.added; row.removed = d.removed; }
    }
    out.push(row);
  }
  return out;
}

/** What a version changed, as unified-diff hunks; or why it cannot be shown (not text, or too big to keep or compare). */
export type VersionDiff = { path: string; version_id: string; before_version_id: string | null } & (
  | { hunks: DiffHunk[]; added: number; removed: number }
  | { unavailable: "binary" | "too_large" }
);

interface VersionRow { seq: number; id: string; path: string; sha256: string; size: number; content: string | null }

/** A version's text ("" for a deletion), or why there is none. */
function versionText(path: string, v: VersionRow | undefined): string | { unavailable: "binary" | "too_large" } {
  if (!v || v.sha256 === "") return "";
  if (v.content !== null) return v.content;
  return isTextPath(path) && v.size > MAX_VERSIONED_TEXT_BYTES ? { unavailable: "too_large" } : { unavailable: "binary" };
}

/**
 * Compares version `versionId` with `base` (another version of the same file, e.g. the one before a turn; `null` = an
 * empty file, for a file a turn made) or, by default, with the version just before it (nothing before = an empty file).
 * 3 lines of context around each change.
 */
export async function versionDiff(db: StudioDb, projectId: string, versionId: string, opts: { base?: string | null } = {}): Promise<VersionDiff> {
  const cols = "seq, id, path, sha256, size, content";
  const v = await db.get<VersionRow>(`SELECT ${cols} FROM project_file_versions WHERE project_id = ? AND id = ?`, [projectId, versionId]);
  if (!v) throw new StudioRunError("not_found", `không có phiên bản ${versionId}`);
  let before: VersionRow | undefined;
  if (opts.base === null) {
    before = undefined;
  } else if (opts.base) {
    before = await db.get<VersionRow>(`SELECT ${cols} FROM project_file_versions WHERE project_id = ? AND id = ?`, [projectId, opts.base]);
    if (!before || before.path !== v.path) throw new StudioRunError("invalid", "bản so sánh phải là một phiên bản của cùng file", { code: "bad_base" });
  } else {
    before = await db.get<VersionRow>(
      `SELECT ${cols} FROM project_file_versions WHERE project_id = ? AND path = ? AND seq < ? ORDER BY seq DESC LIMIT 1`,
      [projectId, v.path, v.seq],
    );
  }
  const head = { path: v.path, version_id: v.id, before_version_id: before?.id ?? null };
  const oldText = versionText(v.path, before);
  const newText = versionText(v.path, v);
  if (typeof newText !== "string") return { ...head, ...newText };
  if (typeof oldText !== "string") return { ...head, ...oldText };
  const d = lineDiff(oldText, newText, { context: 3 });
  return d ? { ...head, ...d } : { ...head, unavailable: "too_large" };
}
