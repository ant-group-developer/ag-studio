/**
 * The project workspace on disk (spec 2026-10-10 agent-workspace §3.1, ADR-0001 item 181): safe relative paths, who
 * may read and write what, atomic writes checked against the copy the writer saw, and a version row for every change
 * of a text file — by a person on the web, by the agent (found by `scanWorkspace` after its turn), or by Studio.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { StudioRunError } from "../errors.js";
import type { StudioDb } from "../studio-db.js";

/** Longest relative path accepted (Windows MAX_PATH leaves room for the root). */
const MAX_REL_PATH = 200;
/** A text file's content is kept with its version up to this size (bigger ones: checksum only). */
export const MAX_VERSIONED_TEXT_BYTES = 1024 * 1024;
/** Largest file the API returns as text. */
export const MAX_READ_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 5000;

const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".csv", ".tsv", ".srt", ".vtt", ".html", ".xml"]);
const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".yaml": "text/yaml",
  ".yml": "text/yaml", ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".srt": "text/plain", ".vtt": "text/vtt",
  ".html": "text/html", ".xml": "application/xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".m4a": "audio/mp4", ".mp4": "video/mp4",
};
export const mimeOf = (path: string): string => MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
export const isTextPath = (path: string): boolean => TEXT_EXTS.has(extname(path).toLowerCase());

const badPath = (path: string, why: string) => new StudioRunError("invalid", `đường dẫn "${path.slice(0, 80)}" không hợp lệ: ${why}`, { code: "bad_path" });

/** `a\b/./c` → `a/b/c`; refuses absolute paths, drive letters, `..`, NUL, empty or over-long paths. */
export function normalizeRelPath(raw: string): string {
  const s = String(raw ?? "").replace(/\\/g, "/");
  if (!s || s.includes("\u0000")) throw badPath(s, "rỗng");
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s)) throw badPath(s, "phải là đường dẫn tương đối");
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw badPath(s, "không được dùng ..");
    if (/[<>:"|?*]/.test(seg) || seg.endsWith(" ") || seg.endsWith(".")) throw badPath(s, "tên có ký tự không dùng được");
    parts.push(seg);
  }
  const out = parts.join("/");
  if (!out) throw badPath(s, "rỗng");
  if (out.length > MAX_REL_PATH) throw badPath(s, "quá dài");
  return out;
}

const PROJECT_ID = /^[0-9a-fA-F-]{8,64}$/;

export function projectDir(root: string, projectId: string): string {
  if (!PROJECT_ID.test(projectId)) throw new StudioRunError("invalid", `id dự án "${projectId}" không hợp lệ`, { code: "bad_project" });
  return join(root, projectId);
}

/** The absolute path of `rel` inside `dir`; refuses a path that passes through a link (it could lead out). */
export function resolveInside(dir: string, rel: string): { rel: string; abs: string } {
  const norm = normalizeRelPath(rel);
  let cur = dir;
  for (const seg of norm.split("/")) {
    cur = join(cur, seg);
    if (!existsSync(cur)) break;
    if (lstatSync(cur).isSymbolicLink()) throw badPath(norm, "đi qua liên kết");
  }
  return { rel: norm, abs: join(dir, ...norm.split("/")) };
}

export type FileAccess = "write" | "read" | "none";

/** Paths only Studio writes (inputs it prepared, the timeline mirror, renders, status). */
const STUDIO_WRITTEN = [/^inputs\//, /^videos\/[^/]+\/sources\//, /^videos\/[^/]+\/renders\//, /^videos\/[^/]+\/timeline\.json$/];

/**
 * Who may do what with a path. Hidden: `.claude/`, `.git/`, `.trash/`. `.studio/` is Studio's (a person may edit
 * the project's playbook there); what Studio prepares is read-only to everyone else.
 */
export function accessFor(rel: string, actor: "user" | "agent"): FileAccess {
  const p = normalizeRelPath(rel);
  if (/^(\.claude|\.git|\.trash)(\/|$)/.test(p)) return "none";
  if (p === ".studio/playbook.yaml") return actor === "user" ? "write" : "read";
  if (/^\.studio(\/|$)/.test(p)) return "read";
  if (STUDIO_WRITTEN.some((re) => re.test(p))) return "read";
  return "write";
}

export interface WorkspaceEntry {
  path: string; kind: "file" | "dir"; size: number; mtime: string; access: FileAccess;
}

/** Every file and folder a person may see, sorted by path (folders before their files). */
export function listWorkspaceTree(dir: string, opts: { under?: string } = {}): WorkspaceEntry[] {
  const out: WorkspaceEntry[] = [];
  const start = opts.under ? resolveInside(dir, opts.under) : { rel: "", abs: dir };
  const walk = (abs: string, rel: string) => {
    if (out.length >= MAX_TREE_ENTRIES) return;
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (accessFor(childRel, "user") === "none") continue;
      const childAbs = join(abs, name);
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        out.push({ path: childRel, kind: "dir", size: 0, mtime: st.mtime.toISOString(), access: accessFor(childRel, "user") });
        walk(childAbs, childRel);
      } else if (st.isFile()) {
        out.push({ path: childRel, kind: "file", size: st.size, mtime: st.mtime.toISOString(), access: accessFor(childRel, "user") });
      }
      if (out.length >= MAX_TREE_ENTRIES) return;
    }
  };
  if (existsSync(start.abs)) walk(start.abs, start.rel);
  return out;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Bytes that are text: a known text extension, valid UTF-8, no NUL. */
function asText(path: string, bytes: Buffer): string | null {
  if (!isTextPath(path) || bytes.includes(0)) return null;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

export interface WorkspaceFile {
  path: string; size: number;
  /** The checksum to save or delete against; null for a file told from its size alone (not text, or too large to show). */
  sha256: string | null;
  mtime: string; mime: string; binary: boolean; text: string | null;
}

/** Where a workspace file is and what `stat` says of it, without reading it; `not_found` when it is not a file. */
export function statWorkspaceFile(dir: string, rel: string): { path: string; abs: string; size: number; mtime: string; mime: string } {
  const { rel: path, abs } = resolveInside(dir, rel);
  const st = existsSync(abs) ? statSync(abs) : null;
  if (!st?.isFile()) throw new StudioRunError("not_found", `không có file ${path}`);
  return { path, abs, size: st.size, mtime: st.mtime.toISOString(), mime: mimeOf(path) };
}

/**
 * A workspace file to show. A text file (a text extension, not larger than `maxTextBytes`) is read whole, with its
 * checksum; any other file — a 300 MB video too — is told from `stat` alone, never read nor hashed, so opening it
 * does not hold up the process.
 */
export function readWorkspaceFile(dir: string, rel: string, opts: { maxTextBytes?: number } = {}): WorkspaceFile {
  const { abs, ...meta } = statWorkspaceFile(dir, rel);
  if (!isTextPath(meta.path) || meta.size > (opts.maxTextBytes ?? MAX_READ_TEXT_BYTES)) return { ...meta, sha256: null, binary: true, text: null };
  const bytes = readFileSync(abs);
  const text = asText(meta.path, bytes);
  return { ...meta, size: bytes.length, sha256: sha256(bytes), binary: text === null, text };
}

/** The bytes of a file (for images, PDFs, audio the web shows). */
export function readWorkspaceBytes(dir: string, rel: string): { path: string; bytes: Buffer; mime: string } {
  const { rel: path, abs } = resolveInside(dir, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new StudioRunError("not_found", `không có file ${path}`);
  return { path, bytes: readFileSync(abs), mime: mimeOf(path) };
}

export interface FileAuthor { kind: "user" | "agent" | "studio"; id: string | null; messageId?: string | null }

function currentSha(abs: string): string | null {
  return existsSync(abs) && statSync(abs).isFile() ? sha256(readFileSync(abs)) : null;
}

function checkBase(path: string, abs: string, baseSha256: string | null | undefined): void {
  if (baseSha256 === undefined) return;
  const current = currentSha(abs);
  if (current !== baseSha256) {
    throw new StudioRunError("conflict", `${path} đã đổi từ lúc bạn mở (hoặc đã có sẵn)`, { code: "file_conflict", currentSha256: current });
  }
}

export function recordFileVersion(db: StudioDb, p: {
  projectId: string; path: string; bytes: Buffer | null; author: FileAuthor; now: string; issues?: unknown;
}): string {
  const id = randomUUID();
  const text = p.bytes && p.bytes.length <= MAX_VERSIONED_TEXT_BYTES ? asText(p.path, p.bytes) : null;
  db.run(
    `INSERT INTO project_file_versions (id, project_id, path, sha256, size, content, author_kind, author_id, message_id, issues, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, p.projectId, p.path, p.bytes ? sha256(p.bytes) : "", p.bytes?.length ?? 0, text, p.author.kind, p.author.id, p.author.messageId ?? null,
      p.issues === undefined ? null : JSON.stringify(p.issues), p.now],
  );
  return id;
}

/**
 * Writes `content` to `path` (folders made as needed) through a temporary file and a rename. `baseSha256`: the
 * checksum of the copy the writer edited (`null` = the file must not exist yet; absent = no check).
 */
export function writeWorkspaceFile(db: StudioDb, p: {
  projectId: string; dir: string; path: string; content: string | Buffer; baseSha256?: string | null; author: FileAuthor; now?: string;
}): { path: string; sha256: string; size: number; versionId: string } {
  const { rel, abs } = resolveInside(p.dir, p.path);
  const actor = p.author.kind === "studio" ? null : p.author.kind;
  if (actor && accessFor(rel, actor) !== "write") throw new StudioRunError("rejected", `${rel} chỉ đọc`, { code: "read_only" });
  const bytes = typeof p.content === "string" ? Buffer.from(p.content, "utf8") : p.content;
  checkBase(rel, abs, p.baseSha256);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, abs);
  const versionId = recordFileVersion(db, { projectId: p.projectId, path: rel, bytes, author: p.author, now: p.now ?? new Date().toISOString() });
  return { path: rel, sha256: sha256(bytes), size: bytes.length, versionId };
}

export function deleteWorkspaceFile(db: StudioDb, p: {
  projectId: string; dir: string; path: string; baseSha256?: string; author: FileAuthor; now?: string;
}): void {
  const { rel, abs } = resolveInside(p.dir, p.path);
  const actor = p.author.kind === "studio" ? null : p.author.kind;
  if (actor && accessFor(rel, actor) !== "write") throw new StudioRunError("rejected", `${rel} chỉ đọc`, { code: "read_only" });
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new StudioRunError("not_found", `không có file ${rel}`);
  checkBase(rel, abs, p.baseSha256);
  rmSync(abs);
  recordFileVersion(db, { projectId: p.projectId, path: rel, bytes: null, author: p.author, now: p.now ?? new Date().toISOString() });
}

export interface FileVersionRow {
  id: string; path: string; sha256: string; size: number; author_kind: FileAuthor["kind"]; author_id: string | null;
  message_id: string | null; created_at: string; has_content: number;
}

export function listFileVersions(db: StudioDb, projectId: string, rel: string, limit = 100): FileVersionRow[] {
  const path = normalizeRelPath(rel);
  return db.all<FileVersionRow>(
    `SELECT id, path, sha256, size, author_kind, author_id, message_id, created_at, content IS NOT NULL AS has_content
       FROM project_file_versions WHERE project_id = ? AND path = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [projectId, path, limit],
  );
}

export function getFileVersion(db: StudioDb, projectId: string, id: string): (FileVersionRow & { content: string | null; issues: string | null }) | undefined {
  return db.get(
    `SELECT id, path, sha256, size, author_kind, author_id, message_id, created_at, content IS NOT NULL AS has_content, content, issues
       FROM project_file_versions WHERE project_id = ? AND id = ?`,
    [projectId, id],
  );
}

/** Paths whose changes are versioned: text files outside what Studio prepares and outside `.studio/`. */
function versioned(rel: string): boolean {
  return isTextPath(rel) && accessFor(rel, "agent") === "write";
}

/**
 * After an agent turn (or at any time): the versioned files that differ from their latest version get a new one
 * by `author`; files that disappeared get a deletion. Answers what changed.
 */
export function scanWorkspace(db: StudioDb, p: { projectId: string; dir: string; author: FileAuthor; now?: string }): { changed: string[]; deleted: string[] } {
  const now = p.now ?? new Date().toISOString();
  const latest = new Map(
    db.all<{ path: string; sha256: string }>(
      `SELECT v.path, v.sha256 FROM project_file_versions v
        WHERE v.project_id = ? AND v.rowid = (SELECT MAX(w.rowid) FROM project_file_versions w WHERE w.project_id = v.project_id AND w.path = v.path)`,
      [p.projectId],
    ).map((r) => [r.path, r.sha256]),
  );
  const changed: string[] = [];
  const seen = new Set<string>();
  for (const e of listWorkspaceTree(p.dir)) {
    if (e.kind !== "file" || !versioned(e.path)) continue;
    seen.add(e.path);
    const bytes = readFileSync(join(p.dir, ...e.path.split("/")));
    if (latest.get(e.path) === sha256(bytes)) continue;
    recordFileVersion(db, { projectId: p.projectId, path: e.path, bytes, author: p.author, now });
    changed.push(e.path);
  }
  const deleted: string[] = [];
  for (const [path, sha] of latest) {
    if (sha === "" || seen.has(path) || !versioned(path)) continue;
    recordFileVersion(db, { projectId: p.projectId, path, bytes: null, author: p.author, now });
    deleted.push(path);
  }
  return { changed, deleted };
}

