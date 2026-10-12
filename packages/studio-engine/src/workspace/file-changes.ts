/**
 * What an agent turn changed in the workspace (migration 0038): every file version the turn wrote — found by
 * `scanWorkspace` after it, or written by a Studio tool during it — compared with the version just before the turn.
 */
import type { StudioDb } from "../studio-db.js";
import { lineDiff } from "./line-diff.js";

export type FileChangeKind = "added" | "modified" | "deleted";

/** One file a turn changed. `added`/`removed`: lines, when both sides are text kept with their version (≤ 1 MB). */
export interface ChangedFile {
  path: string; change: FileChangeKind; version_id: string; before_version_id: string | null; added?: number; removed?: number;
}

interface VersionText { id: string; sha256: string; content: string | null }

/** The version of `path` just before the row `rowid` (the one a change is compared with), if any. */
export function versionBefore(db: StudioDb, projectId: string, path: string, rowid: number): VersionText | undefined {
  return db.get<VersionText>(
    "SELECT id, sha256, content FROM project_file_versions WHERE project_id = ? AND path = ? AND rowid < ? ORDER BY rowid DESC LIMIT 1",
    [projectId, path, rowid],
  );
}

/**
 * The files turn `messageId` changed, by path: its last version of each against the version before its first one.
 * A file it made then removed, or put back as it was, is not listed.
 */
export function turnChangedFiles(db: StudioDb, projectId: string, messageId: string): ChangedFile[] {
  const groups = db.all<{ path: string; first: number; last: number }>(
    `SELECT path, MIN(rowid) AS first, MAX(rowid) AS last FROM project_file_versions
      WHERE message_id = ? AND project_id = ? GROUP BY path ORDER BY path`,
    [messageId, projectId],
  );
  const out: ChangedFile[] = [];
  for (const g of groups) {
    const after = db.get<VersionText>("SELECT id, sha256, content FROM project_file_versions WHERE rowid = ?", [g.last]);
    if (!after) continue;
    const before = versionBefore(db, projectId, g.path, g.first);
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
