import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Clock, ContentRequest, EditStyle, LibraryItem, StateStore } from "@harness/contracts";
import { ContentRequestSchema, EditStyleSchema, LibraryItemSchema } from "@harness/contracts";
import { canonicalDigest } from "../artifacts/checksum.js";
import type { LibraryFs, LibraryRole } from "./files.js";

export interface SyncReport {
  imported: { styles: string[]; requests: string[]; items: string[] };
  updated: { styles: string[]; requests: string[]; items: string[] };
  corrupt: { path: string; reason: string }[];
  missing: { kind: "style" | "request" | "item"; id: string }[];
}

function emptyReport(): SyncReport {
  return { imported: { styles: [], requests: [], items: [] }, updated: { styles: [], requests: [], items: [] }, corrupt: [], missing: [] };
}

/**
 * Compares a freshly-read library entity against its mirror row in the store.
 * Absent in the DB -> "imported". Present but the file is newer (by updated_at)
 * or its content differs (canonicalDigest) -> "updated". Otherwise unchanged.
 */
function classify<T extends { updated_at: string }>(fromFile: T, fromDb: T | undefined): "imported" | "updated" | "unchanged" {
  if (!fromDb) return "imported";
  if (fromFile.updated_at > fromDb.updated_at) return "updated";
  if (canonicalDigest(fromFile) !== canonicalDigest(fromDb)) return "updated";
  return "unchanged";
}

function reasonFor(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function syncLibrary(d: { store: StateStore; fs: LibraryFs; role: LibraryRole; clock: Clock }): Promise<SyncReport> {
  const report = emptyReport();

  const styleIds = d.fs.listStyleIds();
  for (const id of styleIds) {
    const path = d.fs.paths.styleFile(id);
    let style: EditStyle;
    try {
      style = d.fs.readJson(path, EditStyleSchema);
    } catch (e) {
      report.corrupt.push({ path, reason: reasonFor(e) });
      continue;
    }
    const outcome = classify(style, d.store.getEditStyle(style.style_id));
    if (outcome === "unchanged") continue;
    d.store.upsertEditStyle(style);
    report[outcome].styles.push(style.style_id);
  }

  const requestIds = d.fs.listRequestIds();
  for (const id of requestIds) {
    const path = d.fs.paths.requestFile(id);
    let request: ContentRequest;
    try {
      request = d.fs.readJson(path, ContentRequestSchema);
    } catch (e) {
      report.corrupt.push({ path, reason: reasonFor(e) });
      continue;
    }
    const outcome = classify(request, d.store.getContentRequest(request.request_id));
    if (outcome === "unchanged") continue;
    d.store.upsertContentRequest(request);
    report[outcome].requests.push(request.request_id);
  }

  const itemIds = d.fs.listItemIds();
  for (const id of itemIds) {
    const path = d.fs.paths.manifest(id);
    // The whole per-item pass (manifest read *and* every data-file check) is one bad file at most:
    // any thrown error here (missing manifest, corrupt JSON, a data-file read that errors instead of
    // just mismatching — deleted mid-sync, a permission error, a flaky mount) must not abort the loop.
    try {
      const item = d.fs.readJson<LibraryItem>(path, LibraryItemSchema);
      const itemDir = d.fs.paths.itemDir(id);
      let bad: { path: string; reason: string } | undefined;
      for (const f of item.files) {
        const filePath = join(itemDir, f.path);
        if (!existsSync(filePath)) {
          bad = { path: filePath, reason: `missing file: ${filePath}` };
          break;
        }
        let ok: boolean;
        try {
          ok = await d.fs.verifyFile(itemDir, f);
        } catch (e) {
          bad = { path: filePath, reason: reasonFor(e) };
          break;
        }
        if (!ok) {
          bad = { path: filePath, reason: `checksum mismatch: ${filePath}` };
          break;
        }
      }
      if (bad) {
        report.corrupt.push(bad);
        continue;
      }
      const outcome = classify(item, d.store.getLibraryItem(item.item_id));
      if (outcome === "unchanged") continue;
      d.store.upsertLibraryItem(item);
      report[outcome].items.push(item.item_id);
    } catch (e) {
      report.corrupt.push({ path, reason: reasonFor(e) });
    }
  }

  const fsStyleIds = new Set(styleIds);
  for (const s of d.store.listEditStyles()) {
    if (!fsStyleIds.has(s.style_id)) report.missing.push({ kind: "style", id: s.style_id });
  }
  const fsRequestIds = new Set(requestIds);
  for (const r of d.store.listContentRequests()) {
    if (!fsRequestIds.has(r.request_id)) report.missing.push({ kind: "request", id: r.request_id });
  }
  const fsItemIds = new Set(itemIds);
  for (const i of d.store.listLibraryItems()) {
    if (!fsItemIds.has(i.item_id)) report.missing.push({ kind: "item", id: i.item_id });
  }

  if (d.role === "studio") writeIndex({ fs: d.fs, store: d.store, clock: d.clock });

  return report;
}

export function writeIndex(d: { fs: LibraryFs; store: StateStore; clock: Clock }): void {
  const index = {
    generated_at: d.clock.now(),
    styles: d.store.listEditStyles().map((s) => ({ id: s.style_id, revision: s.revision, status: s.status, name: s.name })),
    requests: d.store.listContentRequests().map((r) => ({ id: r.request_id, status: r.status, topic: r.topic })),
    items: d.store.listLibraryItems().map((i) => ({ id: i.item_id, status: i.status, title_hint: i.title_hint, duration_seconds: i.duration_seconds, style: i.style })),
  };
  d.fs.writeJsonAtomic(d.fs.paths.index, index);
}
