import { existsSync } from "node:fs";
import {
  HarnessError,
  LibraryClaimSchema,
  LibraryItemSchema,
  type ContentItem,
  type ContentRequest,
  type LibraryClaim,
  type LibraryItem,
} from "@harness/contracts";
import type { SourceCatalog } from "../source-catalog/catalog.js";
import { fulfillRequest, reopenRequest, type LibraryDeps } from "./requests.js";

/** Reads an item straight from the kho (not the DB mirror); a missing file is NOT_FOUND. */
function readItem(d: LibraryDeps, itemId: string): LibraryItem {
  const path = d.fs.paths.manifest(itemId);
  try {
    return d.fs.readJson(path, LibraryItemSchema);
  } catch (e) {
    if (e instanceof HarnessError && e.code === "IO_ERROR") {
      throw new HarnessError("NOT_FOUND", `library item not found: ${itemId}`, { item_id: itemId });
    }
    throw e;
  }
}

function saveItem(d: LibraryDeps, item: LibraryItem): LibraryItem {
  d.fs.writeJsonAtomic(d.fs.paths.manifest(item.item_id), item);
  d.store.upsertLibraryItem(item);
  return item;
}

/** pending_review -> approved|rejected. When the item carries a request_id, approving fulfills that
 * request (pushing item_id) and rejecting reopens it (with the review note appended). */
export function applyReview(d: LibraryDeps, p: { item_id: string; decision: "approved" | "rejected"; note?: string; by?: string }): { item: LibraryItem; request?: ContentRequest } {
  const item = readItem(d, p.item_id);
  if (item.status !== "pending_review") {
    throw new HarnessError("INVALID_TRANSITION", `library item ${p.item_id} is ${item.status}, not pending_review`, { item_id: p.item_id, status: item.status });
  }
  const now = d.clock.now();
  const updated: LibraryItem = {
    ...item,
    status: p.decision,
    review: { note: p.note ?? "", at: now, ...(p.by !== undefined ? { by: p.by } : {}) },
    updated_at: now,
  };
  const saved = saveItem(d, updated);

  let request: ContentRequest | undefined;
  if (item.request_id) {
    request = p.decision === "approved"
      ? fulfillRequest(d, { request_id: item.request_id, item_id: item.item_id })
      : reopenRequest(d, { request_id: item.request_id, note: p.note ?? "" });
  }
  return request ? { item: saved, request } : { item: saved };
}

/** approved|rejected -> withdrawn; withdrawn stands in for deletion (the kho never deletes). */
export function withdrawItem(d: LibraryDeps, p: { item_id: string; note?: string }): LibraryItem {
  const item = readItem(d, p.item_id);
  if (item.status !== "approved" && item.status !== "rejected") {
    throw new HarnessError("INVALID_TRANSITION", `library item ${p.item_id} is ${item.status}, not approved or rejected`, { item_id: p.item_id, status: item.status });
  }
  const now = d.clock.now();
  const note = p.note ? (item.review.note ? `${item.review.note}\n${p.note}` : p.note) : item.review.note;
  const updated: LibraryItem = { ...item, status: "withdrawn", review: { ...item.review, note }, updated_at: now };
  return saveItem(d, updated);
}

/** Channel role: a *new* claim requires the item to be approved (checked against the kho file, not
 * the DB mirror) — else INVALID_TRANSITION. Claiming is per-channel and idempotent: once a claim
 * file exists for this item+channel, it (and its ContentItem) is returned regardless of the item's
 * later status, without writing again or re-checking approval. */
export function claimItem(
  d: LibraryDeps & { catalog: SourceCatalog },
  p: { item_id: string; channel_id: string; portfolio_id: string; note?: string },
): { claim: LibraryClaim; content: ContentItem } {
  const item = readItem(d, p.item_id);
  const claimPath = d.fs.paths.claimFile(p.item_id, p.channel_id);
  const title = item.title_hint || item.item_id;

  // An existing claim is honored regardless of the item's current status (mirrors claimRequest's
  // same-run idempotency): a channel that already picked the item keeps its claim and ContentItem
  // even if the item was later withdrawn or rejected — approval is only gatekept for a *new* claim.
  if (existsSync(claimPath)) {
    const claim = d.fs.readJson(claimPath, LibraryClaimSchema);
    const content = d.store.listContentItems().find((c) => c.library_item_id === p.item_id)
      ?? d.catalog.createContent({ source_ids: [], title, library_item_id: p.item_id });
    return { claim, content };
  }

  if (item.status !== "approved") {
    throw new HarnessError("INVALID_TRANSITION", `library item ${p.item_id} is ${item.status}, not approved`, { item_id: p.item_id, status: item.status });
  }

  const claim: LibraryClaim = {
    schema_version: "harness.library-claim/v1",
    item_id: p.item_id,
    channel_id: p.channel_id,
    portfolio_id: p.portfolio_id,
    claimed_at: d.clock.now(),
    note: p.note ?? "",
  };
  d.fs.writeJsonAtomic(claimPath, claim);
  const content = d.catalog.createContent({ source_ids: [], title, library_item_id: p.item_id });
  return { claim, content };
}
