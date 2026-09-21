import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HarnessError, newId, type Clock, type ContentItem, type ContentVariant, type LibraryBrief, type MediaProber, type ProductionProfile, type SourceItem, type StateStore } from "@harness/contracts";
import { canonicalDigest, sha256File } from "../artifacts/checksum.js";

export interface IngestInput { path: string; collection?: string; rights_status?: "unknown" | "cleared" | "restricted"; language?: string | null }
export interface IngestDirectoryInput { dir: string; recursive: boolean; collection?: string; rights_status?: "unknown" | "cleared" | "restricted"; language?: string | null }
export interface IngestDirectoryReport {
  ingested: { source: SourceItem; created: boolean }[];
  skipped: { path: string; why: string }[];
}
export interface VerifyRow { source_id: string; ok: boolean; reason: string | null }

export const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".m4v": "video/x-m4v", ".avi": "video/x-msvideo", ".webm": "video/webm",
  ".wav": "audio/wav", ".mp3": "audio/mpeg",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".srt": "text/plain",
};

/** Video extensions `ingestDirectory` picks up (task-7 brief, sub-project 5A): case-insensitive. */
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".m4v", ".avi", ".webm"]);

/** Depth-first listing of every video file under `dir`: hidden entries (name starts with `.`) and symlinks
 * (files or directories -- "not followed", task-7 brief) are skipped entirely; a non-video file is ignored
 * silently; a subdirectory is only descended into when `recursive`. Sorted by `basename` for a deterministic
 * ingest order. */
function listVideoFiles(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (recursive) out.push(...listVideoFiles(full, recursive)); continue; }
    if (entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out.sort((a, b) => (basename(a) < basename(b) ? -1 : basename(a) > basename(b) ? 1 : 0));
}

export function mimeTypeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function normalizedDir(dataRoot: string, sourceId: string): string { return join(dataRoot, "sources", "normalized", sourceId); }

export class SourceCatalog {
  constructor(private readonly d: { store: StateStore; dataRoot: string; prober: MediaProber; clock: Clock; materialize: "link" | "copy" | "reference" }) {}

  async ingest(p: IngestInput): Promise<{ source: SourceItem; created: boolean }> {
    const src = resolve(p.path);
    if (!existsSync(src) || !statSync(src).isFile()) throw new HarnessError("NOT_FOUND", `source file not found: ${src}`, { path: src });
    const { checksum, size_bytes } = await sha256File(src);
    const existing = this.d.store.findSourceItemByChecksum(checksum);
    if (existing) return { source: existing, created: false };
    const probed = await this.d.prober.probe(src);
    const id = newId("source_item");
    const dir = normalizedDir(this.d.dataRoot, id);
    mkdirSync(dir, { recursive: true });
    let uri = pathToFileURL(src).href;
    if (this.d.materialize !== "reference") {
      const dest = join(dir, basename(src));
      if (this.d.materialize === "copy") copyFileSync(src, dest);
      // hardlink shares the inode: editing the original later changes the normalized bytes too (documented caveat of materialize: link)
      else { try { linkSync(src, dest); } catch { copyFileSync(src, dest); } }
      uri = pathToFileURL(dest).href;
    }
    const source: SourceItem = {
      schema_version: "harness.source-item/v1", source_id: id, uri, original_uri: pathToFileURL(src).href, checksum, collection: p.collection ?? "main",
      mime_type: probed?.mime_type ?? mimeTypeForPath(src), size_bytes, media: probed?.media ?? null,
      rights_status: p.rights_status ?? "unknown", language: p.language ?? null, duration_seconds: probed?.duration_seconds ?? null, ingested_at: this.d.clock.now(),
    };
    writeFileSync(join(dir, "source.json"), JSON.stringify(source, null, 2) + "\n");
    try { this.d.store.insertSourceItem(source); }
    catch (e) {
      const winner = this.d.store.findSourceItemByChecksum(checksum);
      if (winner && /UNIQUE/.test(String((e as Error).message))) {
        rmSync(dir, { recursive: true, force: true }); // a concurrent ingest won; drop our normalized copy
        return { source: winner, created: false };
      }
      throw e;
    }
    return { source, created: true };
  }

  /** Ingests every video file under a directory (task-7 brief, sub-project 5A: a shoot is a directory of many
   * clips, registered together into one kho `collection`). A file that fails to ingest (unreadable, vanished
   * between listing and hashing, …) is recorded in `skipped` with its error message and does not stop the
   * rest of the walk; an empty directory is not an error. */
  async ingestDirectory(p: IngestDirectoryInput): Promise<IngestDirectoryReport> {
    const dir = resolve(p.dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new HarnessError("NOT_FOUND", `directory not found: ${dir}`, { path: dir });
    const ingested: { source: SourceItem; created: boolean }[] = [];
    const skipped: { path: string; why: string }[] = [];
    for (const file of listVideoFiles(dir, p.recursive)) {
      try {
        const r = await this.ingest({
          path: file,
          ...(p.collection !== undefined ? { collection: p.collection } : {}),
          ...(p.rights_status !== undefined ? { rights_status: p.rights_status } : {}),
          ...(p.language !== undefined ? { language: p.language } : {}),
        });
        ingested.push(r);
      } catch (e) {
        skipped.push({ path: file, why: e instanceof Error ? e.message : String(e) });
      }
    }
    return { ingested, skipped };
  }

  async verify(): Promise<VerifyRow[]> {
    const rows: VerifyRow[] = [];
    for (const s of this.d.store.listSourceItems()) {
      const path = fileURLToPath(s.uri);
      if (!existsSync(path)) { rows.push({ source_id: s.source_id, ok: false, reason: "file missing" }); continue; }
      const actual = await sha256File(path);
      rows.push(actual.checksum === s.checksum ? { source_id: s.source_id, ok: true, reason: null } : { source_id: s.source_id, ok: false, reason: `checksum mismatch: ${actual.checksum}` });
    }
    return rows;
  }

  createContent(p: { source_ids: string[]; title: string; library_item_id?: string; library_channel_id?: string; library_brief?: LibraryBrief }): ContentItem {
    for (const id of p.source_ids) if (!this.d.store.getSourceItem(id)) throw new HarnessError("NOT_FOUND", `source not found: ${id}`, { source_id: id });
    const content: ContentItem = {
      schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: p.source_ids, revision: 1, title: p.title, created_at: this.d.clock.now(),
      ...(p.library_item_id !== undefined ? { library_item_id: p.library_item_id } : {}),
      ...(p.library_channel_id !== undefined ? { library_channel_id: p.library_channel_id } : {}),
      ...(p.library_brief !== undefined ? { library_brief: p.library_brief } : {}),
    };
    this.d.store.insertContentItem(content);
    return content;
  }

  /** options_defaults ⊕ options, validated against options_schema (unknown key or value → CONFIG_INVALID). */
  resolveOptions(profile: ProductionProfile, options: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...profile.options_defaults, ...options };
    for (const [k, v] of Object.entries(merged)) {
      const allowed = profile.options_schema[k];
      if (!allowed) throw new HarnessError("CONFIG_INVALID", `unknown option "${k}" for profile ${profile.profile_id}`, { key: k });
      if (typeof v !== "string" || !allowed.includes(v)) throw new HarnessError("CONFIG_INVALID", `option ${k}=${String(v)} not in [${allowed.join(", ")}]`, { key: k, value: v });
    }
    return Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  }

  getOrCreateVariant(p: { content_id: string; profile: ProductionProfile; options: Record<string, unknown> }): { variant: ContentVariant; created: boolean } {
    if (!this.d.store.getContentItem(p.content_id)) throw new HarnessError("NOT_FOUND", `content not found: ${p.content_id}`, { content_id: p.content_id });
    const options = this.resolveOptions(p.profile, p.options);
    const key = { content_id: p.content_id, profile_id: p.profile.profile_id, profile_revision: p.profile.revision, options_digest: canonicalDigest(options) };
    const existing = this.d.store.findContentVariant(key);
    if (existing) return { variant: existing, created: false };
    const variant: ContentVariant = { schema_version: "harness.content-variant/v1", variant_id: newId("content_variant"), ...key, options, created_at: this.d.clock.now() };
    this.d.store.insertContentVariant(variant);
    return { variant, created: true };
  }
}
