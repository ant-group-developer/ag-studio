import { existsSync } from "node:fs";
import {
  EditStyleSchema,
  HarnessError,
  LibraryClaimSchema,
  LibraryItemSchema,
  type ContentItem,
  type ContentRequest,
  type EditStyle,
  type LibraryClaim,
  type LibraryItem,
} from "@harness/contracts";
import type { SourceCatalog } from "../source-catalog/catalog.js";
import { fulfillRequest, readRequest, reopenRequest, type LibraryDeps } from "./requests.js";

/**
 * Reads an item straight from the kho (not the DB mirror). Only an *absent* manifest is NOT_FOUND; a
 * manifest that exists but cannot be read or parsed keeps `readJson`'s own code (see `readRequest`).
 */
function readItem(d: LibraryDeps, itemId: string): LibraryItem {
  const path = d.fs.paths.manifest(itemId);
  if (!existsSync(path)) {
    throw new HarnessError("NOT_FOUND", `library item not found: ${itemId}`, { item_id: itemId });
  }
  return d.fs.readJson(path, LibraryItemSchema);
}

function saveItem(d: LibraryDeps, item: LibraryItem): LibraryItem {
  d.fs.writeJsonAtomic(d.fs.paths.manifest(item.item_id), item);
  d.store.upsertLibraryItem(item);
  return item;
}

/** Drives the request half of a review: approving pushes the item onto its request, rejecting reopens it. */
function applyToRequest(d: LibraryDeps, p: { request_id: string; item_id: string; decision: "approved" | "rejected"; note: string }): ContentRequest {
  return p.decision === "approved"
    ? fulfillRequest(d, { request_id: p.request_id, item_id: p.item_id })
    : reopenRequest(d, { request_id: p.request_id, note: p.note });
}

/**
 * True when the request half of this review still has to happen: the request is *this item's run's* claim and
 * does not yet show the decision. A request that has since been reopened and re-claimed by a newer run
 * belongs to that run — a replay of this item's review must not touch it.
 */
function requestHalfPending(request: ContentRequest, item: LibraryItem, decision: "approved" | "rejected"): boolean {
  if (request.status !== "claimed") return false;
  if (request.claimed_by_run?.run_id !== item.lineage.run_id) return false;
  return decision === "approved" ? !request.item_ids.includes(item.item_id) : true;
}

/**
 * pending_review -> approved|rejected. When the item carries a request_id, approving fulfills that request
 * (pushing item_id) and rejecting reopens it (with the review note appended).
 *
 * Two writes are involved (the item manifest, then the request file) and the kho has no transaction, so the
 * order and the re-run behaviour matter:
 *
 * 1. the request transition is *checked* before anything is written — a request that cannot take it (never
 *    claimed, claimed by another run, already fulfilled) fails with nothing half-written;
 * 2. the item is written, then the request. If the request write fails after the item write, the error
 *    carries `item_written: true` and names both ids;
 * 3. re-running the same review is not an error. An item that already carries the decision returns as-is,
 *    and if the request half never landed (case 2, or a crash between the writes) it is finished then —
 *    which makes `harness library review <item_id>` the documented recovery for a partial write.
 */
export function applyReview(d: LibraryDeps, p: { item_id: string; decision: "approved" | "rejected"; note?: string; by?: string }): { item: LibraryItem; request?: ContentRequest } {
  const item = readItem(d, p.item_id);
  const note = p.note ?? "";

  if (item.status === p.decision) {
    if (!item.request_id) return { item };
    const request = readRequest(d, item.request_id);
    if (!requestHalfPending(request, item, p.decision)) return { item, request };
    return { item, request: applyToRequest(d, { request_id: item.request_id, item_id: item.item_id, decision: p.decision, note }) };
  }

  if (item.status !== "pending_review") {
    throw new HarnessError("INVALID_TRANSITION", `library item ${p.item_id} is ${item.status}, not pending_review`, { item_id: p.item_id, status: item.status });
  }

  // Pure pre-check (reads only): `fulfillRequest` needs `claimed`, `reopenRequest` accepts `claimed` or
  // `rejected`. Refusing here keeps the item pending_review instead of leaving a reviewed item behind a
  // request that never moved.
  if (item.request_id) {
    const request = readRequest(d, item.request_id);
    const allowed = p.decision === "approved" ? ["claimed"] : ["claimed", "rejected"];
    if (!allowed.includes(request.status)) {
      throw new HarnessError(
        "INVALID_TRANSITION",
        `content request ${item.request_id} is ${request.status}, not ${allowed.join(" or ")}; cannot ${p.decision === "approved" ? "fulfill" : "reopen"} it for item ${p.item_id}`,
        { item_id: p.item_id, request_id: item.request_id, status: request.status },
      );
    }
  }

  const now = d.clock.now();
  const updated: LibraryItem = {
    ...item,
    status: p.decision,
    review: { note, at: now, ...(p.by !== undefined ? { by: p.by } : {}) },
    updated_at: now,
  };
  const saved = saveItem(d, updated);

  if (!item.request_id) return { item: saved };

  try {
    const request = applyToRequest(d, { request_id: item.request_id, item_id: item.item_id, decision: p.decision, note });
    return { item: saved, request };
  } catch (e) {
    const code = e instanceof HarnessError ? e.code : "IO_ERROR";
    const details = e instanceof HarnessError ? e.details : {};
    throw new HarnessError(
      code,
      `library item ${p.item_id} was written as ${p.decision} but its request ${item.request_id} could not be updated: ${e instanceof Error ? e.message : String(e)}; re-run \`harness library review ${p.item_id} --${p.decision === "approved" ? "approve" : "reject"}\` once the kho is reachable`,
      { ...details, item_id: p.item_id, request_id: item.request_id, item_written: true },
    );
  }
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

/** Reads a style straight from the kho (not the DB mirror), mirroring `readItem`/`readRequest`: only an
 * *absent* file is NOT_FOUND. */
function readStyle(d: LibraryDeps, styleId: string): EditStyle {
  const path = d.fs.paths.styleFile(styleId);
  if (!existsSync(path)) {
    throw new HarnessError("NOT_FOUND", `edit style not found: ${styleId}`, { style_id: styleId });
  }
  return d.fs.readJson(path, EditStyleSchema);
}

function saveStyle(d: LibraryDeps, style: EditStyle): EditStyle {
  d.fs.writeJsonAtomic(d.fs.paths.styleFile(style.style_id), style);
  d.store.upsertEditStyle(style);
  return style;
}

/**
 * draft|retired -> active, bumping `revision` and `updated_at` and mirroring the result into the store.
 * Studio-only: `LibraryFs.assertWritable` refuses a channel role's write with CONFIG_INVALID before
 * anything touches disk (styles/** is a studio-owned path), so no separate role check is needed here.
 *
 * Idempotent on an already-active style: returned unchanged, no revision bump and no write -- re-running
 * `harness library styles activate` after a real activation is a no-op instead of an unbounded revision
 * climb. `p.note` has no field to land in on `EditStyleSchema` today (unlike `LibraryItem.review` or
 * `LibraryClaim.note`, a style carries no per-transition note) -- accepted for CLI symmetry with
 * `review`/`withdraw --note` but currently unused; wiring it in would mean growing the schema, out of
 * scope here.
 */
export function activateStyle(d: LibraryDeps, p: { style_id: string; note?: string }): EditStyle {
  const style = readStyle(d, p.style_id);
  if (style.status === "active") return style;
  const updated: EditStyle = { ...style, status: "active", revision: style.revision + 1, updated_at: d.clock.now() };
  return saveStyle(d, updated);
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
    // Look the existing content up by item *and* channel: one kho item can be picked by several channels of
    // the same project, and each pick has its own ContentItem — matching on library_item_id alone would hand
    // this channel whichever channel picked first.
    const content = d.store.listContentItems().find((c) => c.library_item_id === p.item_id && c.library_channel_id === p.channel_id)
      ?? d.catalog.createContent({ source_ids: [], title, library_item_id: p.item_id, library_channel_id: p.channel_id });
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
  const content = d.catalog.createContent({ source_ids: [], title, library_item_id: p.item_id, library_channel_id: p.channel_id });
  return { claim, content };
}
