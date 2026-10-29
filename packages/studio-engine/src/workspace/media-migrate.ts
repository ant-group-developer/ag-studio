/**
 * Moving what was uploaded before the media library into it (plan 2026-10-29 P5), run once by hand on the server
 * (`scripts/migrate-media-library.mjs`), after migration 0006 and the API and worker that read the library:
 *   - footage already on the bucket (`library/studio/projects/<p>/footage/…`, sources `upload_asset` with no
 *     `media_id`) becomes an item of the person who uploaded it, at the same key: nothing is copied;
 *   - audio and video files on the server's disk under a project's `context/` (rows `upload`, and files put there
 *     through the Files tab with no row) are put on the bucket in the uploader's library (the project's owner when no
 *     row says who), their rows point at the item (`media_id`, `meta.key`) under the same path, and the file on the disk
 *     goes to the project's `.trash/` (the cleanup sweep removes it after `workspaceDays`).
 * A dry run (`apply: false`) reads only and answers what would be done. A file that cannot go (missing, too big, of no
 * kind the library takes) is left where it is and listed as skipped. Running it again does only what is left.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { StudioBucket } from "../bucket.js";
import type { StudioDb } from "../studio-db.js";
import { MEDIA_MAX_BYTES, mediaKindOf, newMediaKey, type MediaKind } from "./media-library.js";
import type { SourceRecord } from "./sources-db.js";
import { REFERENCE_UPLOAD_MAX_BYTES } from "./style-watch.js";

export interface MediaMigrationReport {
  /** Footage on the bucket made items (no copy): items, and the sources that now point at them. */
  footage: { items: number; sources: number };
  /** Files of the disk put in the library: items, sources pointing at them, bytes freed on the disk. */
  files: { items: number; sources: number; bytes: number };
  skipped: { project: string; ref: string; reason: string }[];
}

interface Move { projectId: string; ref: string; abs: string; name: string; kind: MediaKind; bytes: number; owner: string; addedAt: string; rows: SourceRecord[]; reference: boolean }

const CONTEXT_DIR = "context";
const asMeta = (s: SourceRecord) => (s.meta ?? {}) as Record<string, unknown>;

/** Every file under a project's `context/` (hidden ones aside), as workspace paths. */
function contextFiles(workspaceDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(join(workspaceDir, ...rel.split("/"))); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const child = `${rel}/${name}`;
      let st;
      try { st = statSync(join(workspaceDir, ...child.split("/"))); } catch { continue; }
      if (st.isDirectory()) { if (depth < 6) walk(child, depth + 1); } else if (st.isFile()) out.push(child);
    }
  };
  walk(CONTEXT_DIR, 0);
  return out;
}

export async function migrateMediaLibrary(db: StudioDb, bucket: StudioBucket, o: {
  workspacesRoot: string; apply: boolean; now?: string; log?: (line: string) => void;
}): Promise<MediaMigrationReport> {
  const now = o.now ?? new Date().toISOString();
  const log = o.log ?? (() => undefined);
  const report: MediaMigrationReport = { footage: { items: 0, sources: 0 }, files: { items: 0, sources: 0, bytes: 0 }, skipped: [] };
  const skip = (project: string, ref: string, reason: string) => { report.skipped.push({ project, ref, reason }); log(`bỏ qua ${project} ${ref}: ${reason}`); };

  // footage on the bucket: one item per asset, at its key
  const footage = await db.all<SourceRecord>("SELECT * FROM project_sources WHERE kind = 'upload_asset' AND media_id IS NULL ORDER BY added_at, id");
  const byAsset = new Map<string, SourceRecord[]>();
  for (const s of footage) byAsset.set(s.ref, [...(byAsset.get(s.ref) ?? []), s]);
  for (const [assetId, rows] of byAsset) {
    const first = rows[0]!;
    const key = typeof asMeta(first).key === "string" ? (asMeta(first).key as string) : null;
    if (!key) { skip(first.project_id, assetId, "không có meta.key"); continue; }
    const known = await db.get<{ id: string }>("SELECT id FROM media_items WHERE id = ? OR key = ?", [assetId, key]);
    const head = known ? null : await bucket.exists(key);
    if (!known && !head) { skip(first.project_id, assetId, `không thấy ${key} trên kho`); continue; }
    report.footage.items += known ? 0 : 1;
    report.footage.sources += rows.length;
    log(`footage ${first.label} (${assetId}) → thư viện của ${first.added_by}, ${rows.length} dòng nguồn`);
    if (!o.apply) continue;
    await db.tx(async () => {
      if (!known) {
        const clip = asMeta(first).clip_key;
        await db.run(
          "INSERT INTO media_items (id, owner_id, kind, key, name, bytes, clip_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [assetId, first.added_by, first.media_type === "image" ? "image" : "video", key, first.label, head!.size, typeof clip === "string" ? clip : null, first.added_at],
        );
      }
      await db.run("UPDATE project_sources SET media_id = ? WHERE kind = 'upload_asset' AND ref = ? AND media_id IS NULL", [known?.id ?? assetId, assetId]);
    });
  }

  // audio and video on the disk: by project and path, with the rows naming them
  const moves: Move[] = [];
  const projects = await db.all<{ id: string; owner_user_id: string }>("SELECT id, owner_user_id FROM projects ORDER BY created_at, id");
  for (const p of projects) {
    const dir = join(o.workspacesRoot, p.id);
    if (!existsSync(dir)) continue;
    const rows = await db.all<SourceRecord>("SELECT * FROM project_sources WHERE project_id = ? AND kind = 'upload' ORDER BY added_at, id", [p.id]);
    const linked = new Set(rows.filter((r) => r.media_id).map((r) => r.ref));
    const open = new Map<string, SourceRecord[]>();
    for (const r of rows) if (!r.media_id && !linked.has(r.ref)) open.set(r.ref, [...(open.get(r.ref) ?? []), r]);
    const refs = new Set([...open.keys(), ...contextFiles(dir).filter((f) => !linked.has(f))]);
    for (const ref of refs) {
      const kind = mediaKindOf(ref);
      const named = open.get(ref) ?? [];
      if (kind !== "audio" && kind !== "video") continue; // documents and photos stay in the workspace
      const abs = join(dir, ...ref.split("/"));
      if (!existsSync(abs)) { if (named.length) skip(p.id, ref, "không còn file trên đĩa"); continue; }
      const bytes = statSync(abs).size;
      const reference = kind === "video";
      const max = reference ? Math.min(MEDIA_MAX_BYTES.video, REFERENCE_UPLOAD_MAX_BYTES) : MEDIA_MAX_BYTES.audio;
      if (bytes > max) { skip(p.id, ref, `lớn hơn ${Math.round(max / 1024 / 1024)} MB`); continue; }
      const first = named[0];
      moves.push({
        projectId: p.id, ref, abs, name: first?.label || basename(ref), kind, bytes, owner: first?.added_by ?? p.owner_user_id,
        addedAt: first?.added_at ?? statSync(abs).mtime.toISOString(), rows: named, reference,
      });
    }
  }
  const trashOf = new Map<string, string>();
  for (const m of moves) {
    report.files.items += 1;
    report.files.sources += Math.max(1, m.rows.length);
    report.files.bytes += m.bytes;
    log(`${m.kind === "audio" ? "audio" : "video mẫu"} ${m.projectId} ${m.ref} (${(m.bytes / 1024 / 1024).toFixed(1)} MB) → thư viện của ${m.owner}`);
    if (!o.apply) continue;
    const { mediaId, key } = newMediaKey(m.owner, m.name);
    await bucket.putFile(key, m.abs);
    const meta = { key, bytes: m.bytes, ...(m.reference ? { reference: true } : {}) };
    await db.tx(async () => {
      await db.run(
        "INSERT INTO media_items (id, owner_id, kind, key, name, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [mediaId, m.owner, m.kind, key, m.name, m.bytes, m.addedAt],
      );
      if (m.rows.length) {
        for (const r of m.rows) {
          await db.run("UPDATE project_sources SET media_id = ?, meta = ? WHERE id = ?", [mediaId, JSON.stringify({ ...asMeta(r), ...meta }), r.id]);
        }
      } else {
        await db.run(
          `INSERT INTO project_sources (id, project_id, video_id, kind, ref, media_type, label, meta, added_by, added_at, media_id)
           VALUES (?, ?, NULL, 'upload', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          [randomUUID(), m.projectId, m.ref, m.kind, m.name, JSON.stringify(meta), m.owner, m.addedAt, mediaId],
        );
      }
    });
    // the disk copy to the project's trash, in one folder per run (its time is the sweep's clock)
    const trash = trashOf.get(m.projectId) ?? join(o.workspacesRoot, m.projectId, ".trash", `media-library-${now.replace(/[:.]/g, "-")}`);
    trashOf.set(m.projectId, trash);
    const to = join(trash, ...m.ref.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    renameSync(m.abs, to);
  }
  return report;
}
