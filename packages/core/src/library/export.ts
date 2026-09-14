import { existsSync, readdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import {
  LibraryItemSchema,
  newId,
  type Checksum,
  type ContentItem,
  type EditStyle,
  type LibraryBrief,
  type LibraryFile,
  type LibraryItem,
  type MediaProber,
  type Run,
} from "@harness/contracts";
import { canonicalDigest } from "../artifacts/checksum.js";
import { listDirectoryFiles } from "../artifacts/directory.js";
import type { LibraryDeps } from "./requests.js";

export interface ExportReceipt {
  item_id: string;
  item_dir: string;
  files: LibraryFile[];
  manifest_checksum: Checksum;
}

/** Reads the current manifest's `created_at`, or undefined when there is none yet (first export
 * of this item_id, whether freshly minted or an existingItemId whose manifest was never written). */
function existingCreatedAt(d: LibraryDeps, manifestPath: string): string | undefined {
  if (!existsSync(manifestPath)) return undefined;
  return d.fs.readJson(manifestPath, LibraryItemSchema).created_at;
}

/**
 * The one place the kho removes files: after a re-export overwrites `items/<id>/` with a new file set
 * (e.g. fewer thumbnails, or the same slot with a different source extension), any regular file directly
 * in the item dir that is neither `manifest.json` nor one of the freshly-copied `files[].path` is stale
 * data from the previous export of this *same, still-unreviewed* item — not a reviewed artifact and not
 * anything a channel wrote — so it is deleted. Never recurses, so `claims/` (channel-owned) is untouched.
 */
function pruneStaleFiles(dir: string, keep: readonly string[]): void {
  if (!existsSync(dir)) return;
  const keepNames = new Set(keep);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue; // skips claims/ (a directory) and anything else that isn't a plain file
    if (entry.name === "manifest.json" || keepNames.has(entry.name)) continue;
    rmSync(join(dir, entry.name));
  }
}

/**
 * Copies an episode + thumbnails + optional captions + edit-plan into `items/<item_id>/`, probes the
 * episode for duration/media, and writes `manifest.json` as `pending_review`. Idempotent on
 * `existingItemId`: re-running with the same id overwrites the same directory (files re-copied,
 * `created_at` preserved from the manifest already on disk) instead of minting a new item.
 */
export async function exportItem(
  d: LibraryDeps & { prober: MediaProber },
  p: {
    run: Run;
    content: ContentItem;
    brief: LibraryBrief;
    episodePath: string;
    thumbnailPaths: string[];
    captionsPath?: string;
    editPlanPath: string;
    existingItemId?: string;
  },
): Promise<{ item: LibraryItem; receipt: ExportReceipt }> {
  const item_id = p.existingItemId ?? newId("library_item");
  const dir = d.fs.paths.itemDir(item_id);
  const manifestPath = d.fs.paths.manifest(item_id);
  const createdAt = existingCreatedAt(d, manifestPath);

  const files: LibraryFile[] = [];
  files.push(await d.fs.copyFileWithChecksum(p.episodePath, join(dir, "episode.mp4")));
  for (const [i, thumbnailPath] of p.thumbnailPaths.entries()) {
    const name = `thumbnail-${String(i + 1).padStart(2, "0")}${extname(thumbnailPath)}`;
    files.push(await d.fs.copyFileWithChecksum(thumbnailPath, join(dir, name)));
  }
  if (p.captionsPath !== undefined) {
    files.push(await d.fs.copyFileWithChecksum(p.captionsPath, join(dir, "captions.json")));
  }
  files.push(await d.fs.copyFileWithChecksum(p.editPlanPath, join(dir, "edit-plan.json")));

  const probed = await d.prober.probe(p.episodePath);
  const now = d.clock.now();

  const item: LibraryItem = {
    schema_version: "harness.library-item/v1",
    item_id,
    status: "pending_review",
    title_hint: p.content.title,
    summary: p.brief.topic,
    style: { style_id: p.brief.style_id, revision: p.brief.style_revision },
    ...(p.brief.request_id !== undefined ? { request_id: p.brief.request_id } : {}),
    duration_seconds: probed?.duration_seconds ?? 0,
    media: probed?.media ?? null,
    files,
    lineage: {
      project_id: p.run.project_id,
      run_id: p.run.run_id,
      content_id: p.content.content_id,
      source_ids: p.content.source_ids,
    },
    review: { note: "" },
    created_at: createdAt ?? now,
    updated_at: now,
  };

  // Manifest first, prune second: between the two, a concurrent reader (another machine's `library sync`)
  // sees a manifest that lists only files still on disk. The other order would publish a window where the
  // manifest vouches for a file that has already been deleted, which reads as a corrupt item.
  d.fs.writeJsonAtomic(manifestPath, item);
  pruneStaleFiles(dir, files.map((f) => f.path));
  d.store.upsertLibraryItem(item);

  const receipt: ExportReceipt = {
    item_id,
    item_dir: dir,
    files,
    manifest_checksum: canonicalDigest(item),
  };

  return { item, receipt };
}

/**
 * Copies every file under `evidenceDir` (recursive, relative paths preserved) into `styles/<id>/evidence/`,
 * appending one `style.evidence` entry per newly-copied file (existing entries, including ones added by a
 * hand-written note, are kept as-is), then writes `style.json` and mirrors it into the store.
 */
export async function exportStyle(d: LibraryDeps, p: { style: EditStyle; evidenceDir?: string }): Promise<{ style: EditStyle; dir: string }> {
  const dir = d.fs.paths.styleDir(p.style.style_id);
  const evidence = [...p.style.evidence];
  const known = new Set(evidence.map((e) => e.path));

  if (p.evidenceDir !== undefined) {
    const entries = await listDirectoryFiles(p.evidenceDir);
    for (const entry of entries) {
      const dest = join(dir, "evidence", entry.path);
      await d.fs.copyFileWithChecksum(join(p.evidenceDir, entry.path), dest);
      const relPath = `evidence/${entry.path}`;
      if (!known.has(relPath)) {
        evidence.push({ path: relPath, note: "" });
        known.add(relPath);
      }
    }
  }

  const style: EditStyle = { ...p.style, evidence, updated_at: d.clock.now() };
  d.fs.writeJsonAtomic(d.fs.paths.styleFile(style.style_id), style);
  d.store.upsertEditStyle(style);
  return { style, dir };
}
