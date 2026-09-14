import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HarnessError, newId, type Clock, type ContentItem, type ContentVariant, type LibraryBrief, type MediaProber, type ProductionProfile, type SourceItem, type StateStore } from "@harness/contracts";
import { canonicalDigest, sha256File } from "../artifacts/checksum.js";

export interface IngestInput { path: string; collection?: string; rights_status?: "unknown" | "cleared" | "restricted"; language?: string | null }
export interface VerifyRow { source_id: string; ok: boolean; reason: string | null }

export const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".wav": "audio/wav", ".mp3": "audio/mpeg",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".srt": "text/plain",
};

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

  createContent(p: { source_ids: string[]; title: string; library_item_id?: string; library_brief?: LibraryBrief }): ContentItem {
    for (const id of p.source_ids) if (!this.d.store.getSourceItem(id)) throw new HarnessError("NOT_FOUND", `source not found: ${id}`, { source_id: id });
    const content: ContentItem = {
      schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: p.source_ids, revision: 1, title: p.title, created_at: this.d.clock.now(),
      ...(p.library_item_id !== undefined ? { library_item_id: p.library_item_id } : {}),
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
