import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, newId, type LibraryItem } from "@harness/contracts";
import { applyReview, claimItem, claimRequest, createRequest, LibraryFs, NullMediaProber, SourceCatalog, withdrawItem } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

const SHA = "sha256:" + "a".repeat(64);

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "library-review-"));
}

function makeItem(id: string, overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    schema_version: "harness.library-item/v1",
    item_id: id,
    status: "pending_review",
    title_hint: "Ancient ruins ep. 1",
    summary: "",
    style: { style_id: newId("edit_style"), revision: 1 },
    duration_seconds: 120,
    media: null,
    files: [{ path: "episode.mp4", checksum: SHA, size_bytes: 10, mime_type: "video/mp4" }],
    lineage: { project_id: "project-studio", run_id: newId("run"), content_id: newId("content_item"), source_ids: [] },
    review: { note: "" },
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function world() {
  const root = tempRoot();
  const studio = new LibraryFs({ root, role: "studio" });
  const channel = new LibraryFs({ root, role: "channel" });
  const { store, dir, clock } = openTempStore();
  const catalog = new SourceCatalog({ store, dataRoot: dir, prober: new NullMediaProber(), clock, materialize: "copy" });
  return { root, studio, channel, store, clock, catalog };
}

describe("applyReview", () => {
  it("approves a pending item and fulfills its request", () => {
    const { studio, channel, store, clock } = world();
    const d = { store, fs: studio, clock };
    const dChannel = { store, fs: channel, clock };

    const request = createRequest(dChannel, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    const run = { project_id: "project-studio", run_id: newId("run") };
    claimRequest(d, { request_id: request.request_id, run });

    const itemId = newId("library_item");
    const item = makeItem(itemId, { request_id: request.request_id });
    studio.writeJsonAtomic(studio.paths.manifest(itemId), item);

    const result = applyReview(d, { item_id: itemId, decision: "approved", note: "looks great", by: "reviewer-1" });

    expect(result.item.status).toBe("approved");
    expect(result.item.review).toEqual({ note: "looks great", at: clock.now(), by: "reviewer-1" });
    const onDisk = JSON.parse(readFileSync(studio.paths.manifest(itemId), "utf8"));
    expect(onDisk.status).toBe("approved");

    expect(result.request?.status).toBe("fulfilled");
    expect(result.request?.item_ids).toEqual([itemId]);
    expect(store.getContentRequest(request.request_id)?.status).toBe("fulfilled");
  });

  it("rejects a pending item and reopens its request with the note", () => {
    const { studio, channel, store, clock } = world();
    const d = { store, fs: studio, clock };
    const dChannel = { store, fs: channel, clock };

    const request = createRequest(dChannel, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    const run = { project_id: "project-studio", run_id: newId("run") };
    claimRequest(d, { request_id: request.request_id, run });

    const itemId = newId("library_item");
    const item = makeItem(itemId, { request_id: request.request_id });
    studio.writeJsonAtomic(studio.paths.manifest(itemId), item);

    const result = applyReview(d, { item_id: itemId, decision: "rejected", note: "off brief" });

    expect(result.item.status).toBe("rejected");
    expect(result.request?.status).toBe("open");
    expect(result.request?.claimed_by_run).toBeUndefined();
    expect(result.request?.notes).toContain("off brief");
  });

  it("only transitions from pending_review (re-running the same decision is the one exception)", () => {
    const { studio, store, clock } = world();
    const d = { store, fs: studio, clock };
    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId, { status: "approved" }));

    // reversing an already-applied decision is not a review, it is a second opinion: refused
    let caught: unknown;
    try {
      applyReview(d, { item_id: itemId, decision: "rejected" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "INVALID_TRANSITION")).toBe(true);

    // a withdrawn item cannot be reviewed at all
    const withdrawnId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(withdrawnId), makeItem(withdrawnId, { status: "withdrawn" }));
    caught = undefined;
    try {
      applyReview(d, { item_id: withdrawnId, decision: "approved" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "INVALID_TRANSITION")).toBe(true);
  });

  it("is a no-op re-run when the item already carries the decision and the request already reflects it", () => {
    const { studio, channel, store, clock } = world();
    const d = { store, fs: studio, clock };
    const dChannel = { store, fs: channel, clock };

    const request = createRequest(dChannel, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    const run = { project_id: "project-studio", run_id: newId("run") };
    claimRequest(d, { request_id: request.request_id, run });

    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId, { request_id: request.request_id, lineage: { project_id: run.project_id, run_id: run.run_id, content_id: newId("content_item"), source_ids: [] } }));

    const first = applyReview(d, { item_id: itemId, decision: "approved", note: "ok" });
    expect(first.request?.status).toBe("fulfilled");

    // re-running the same review (gate replayed, or `harness library review` run twice) is not an error
    const again = applyReview(d, { item_id: itemId, decision: "approved", note: "ok" });
    expect(again.item.status).toBe("approved");
    expect(again.item.updated_at).toBe(first.item.updated_at); // nothing rewritten
    expect(again.request?.status).toBe("fulfilled");
    expect(again.request?.item_ids).toEqual([itemId]);
  });

  it("finishes the request half when a previous run wrote the item but not the request", () => {
    const { studio, channel, store, clock } = world();
    const d = { store, fs: studio, clock };
    const dChannel = { store, fs: channel, clock };

    const request = createRequest(dChannel, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    const run = { project_id: "project-studio", run_id: newId("run") };
    claimRequest(d, { request_id: request.request_id, run });

    // exactly the crash state: manifest already `approved`, request still `claimed` by this item's run
    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId, {
      status: "approved",
      request_id: request.request_id,
      lineage: { project_id: run.project_id, run_id: run.run_id, content_id: newId("content_item"), source_ids: [] },
    }));

    const result = applyReview(d, { item_id: itemId, decision: "approved", note: "ok" });
    expect(result.item.status).toBe("approved");
    expect(result.request?.status).toBe("fulfilled");
    expect(result.request?.item_ids).toEqual([itemId]);
  });

  it("checks the request transition before writing the item, so a bad request leaves nothing half-written", () => {
    const { studio, channel, store, clock } = world();
    const d = { store, fs: studio, clock };
    const dChannel = { store, fs: channel, clock };

    // a request nobody ever claimed: `fulfillRequest` would refuse it
    const request = createRequest(dChannel, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });

    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId, { request_id: request.request_id }));

    let caught: unknown;
    try {
      applyReview(d, { item_id: itemId, decision: "approved" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "INVALID_TRANSITION")).toBe(true);
    // the item was never written: no `approved` manifest pointing at an `open` request
    expect(JSON.parse(readFileSync(studio.paths.manifest(itemId), "utf8")).status).toBe("pending_review");
    expect(store.getContentRequest(request.request_id)?.status).toBe("open");
  });

  it("keeps IO_ERROR as IO_ERROR when the manifest exists but cannot be read", () => {
    const { studio, store, clock } = world();
    const d = { store, fs: studio, clock };

    const missingId = newId("library_item");
    let caught: unknown;
    try {
      applyReview(d, { item_id: missingId, decision: "approved" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "NOT_FOUND")).toBe(true);

    const brokenId = newId("library_item");
    mkdirSync(studio.paths.itemDir(brokenId), { recursive: true });
    writeFileSync(studio.paths.manifest(brokenId), "{ not json");
    caught = undefined;
    try {
      applyReview(d, { item_id: brokenId, decision: "approved" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "IO_ERROR")).toBe(true);
  });

  it("does not touch a request when the item has none", () => {
    const { studio, store, clock } = world();
    const d = { store, fs: studio, clock };
    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId));

    const result = applyReview(d, { item_id: itemId, decision: "approved" });
    expect(result.item.status).toBe("approved");
    expect(result.request).toBeUndefined();
  });
});

describe("withdrawItem", () => {
  it("moves approved -> withdrawn and appends the note", () => {
    const { studio, store, clock } = world();
    const d = { store, fs: studio, clock };
    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId, { status: "approved", review: { note: "prior" } }));

    const withdrawn = withdrawItem(d, { item_id: itemId, note: "channel no longer needs it" });
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.review.note).toBe("prior\nchannel no longer needs it");
  });

  it("rejects withdrawing a pending_review item", () => {
    const { studio, store, clock } = world();
    const d = { store, fs: studio, clock };
    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId));

    let caught: unknown;
    try {
      withdrawItem(d, { item_id: itemId });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "INVALID_TRANSITION")).toBe(true);
  });
});

describe("claimItem", () => {
  it("rejects claiming a pending_review item", () => {
    const { studio, channel, store, clock, catalog } = world();
    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId));

    let caught: unknown;
    try {
      claimItem({ store, fs: channel, clock, catalog }, { item_id: itemId, channel_id: "chan-a", portfolio_id: "portfolio-a" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "INVALID_TRANSITION")).toBe(true);
  });

  it("claims an approved item, writing a claim file and a ContentItem with library_item_id", () => {
    const { studio, channel, store, clock, catalog } = world();
    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId, { status: "approved" }));

    const result = claimItem({ store, fs: channel, clock, catalog }, { item_id: itemId, channel_id: "chan-a", portfolio_id: "portfolio-a", note: "for next slot" });

    expect(result.claim.item_id).toBe(itemId);
    expect(result.claim.channel_id).toBe("chan-a");
    expect(existsSync(channel.paths.claimFile(itemId, "chan-a"))).toBe(true);

    expect(result.content.library_item_id).toBe(itemId);
    expect(result.content.source_ids).toEqual([]);
    expect(result.content.title).toBe("Ancient ruins ep. 1");
    expect(store.getContentItem(result.content.content_id)).toEqual(result.content);
  });

  it("is idempotent for a second claim by the same channel", () => {
    const { studio, channel, store, clock, catalog } = world();
    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId, { status: "approved" }));

    const first = claimItem({ store, fs: channel, clock, catalog }, { item_id: itemId, channel_id: "chan-a", portfolio_id: "portfolio-a" });
    const second = claimItem({ store, fs: channel, clock, catalog }, { item_id: itemId, channel_id: "chan-a", portfolio_id: "portfolio-a" });

    expect(second.claim).toEqual(first.claim);
    expect(second.content.content_id).toBe(first.content.content_id);
    expect(store.listContentItems().filter((c) => c.library_item_id === itemId)).toHaveLength(1);
  });

  it("gives each channel its own ContentItem for the same item, and hands back the right one on a re-pick", () => {
    const { studio, channel, store, clock, catalog } = world();
    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId, { status: "approved" }));
    const d = { store, fs: channel, clock, catalog };

    const one = claimItem(d, { item_id: itemId, channel_id: "chan-one", portfolio_id: "portfolio-a" });
    const two = claimItem(d, { item_id: itemId, channel_id: "chan-two", portfolio_id: "portfolio-b" });

    // two channels picking the same kho item are two separate local ContentItems, each tagged with its channel
    expect(two.content.content_id).not.toBe(one.content.content_id);
    expect(one.content.library_channel_id).toBe("chan-one");
    expect(two.content.library_channel_id).toBe("chan-two");
    expect(store.listContentItems().filter((c) => c.library_item_id === itemId)).toHaveLength(2);

    // the idempotent branch must not hand channel one the *other* channel's content
    const oneAgain = claimItem(d, { item_id: itemId, channel_id: "chan-one", portfolio_id: "portfolio-a" });
    expect(oneAgain.content.content_id).toBe(one.content.content_id);
    const twoAgain = claimItem(d, { item_id: itemId, channel_id: "chan-two", portfolio_id: "portfolio-b" });
    expect(twoAgain.content.content_id).toBe(two.content.content_id);
    expect(store.listContentItems().filter((c) => c.library_item_id === itemId)).toHaveLength(2);
  });

  it("keeps honoring an existing claim after the item later becomes withdrawn", () => {
    const { studio, channel, store, clock, catalog } = world();
    const itemId = newId("library_item");
    const approved = makeItem(itemId, { status: "approved" });
    studio.writeJsonAtomic(studio.paths.manifest(itemId), approved);

    const first = claimItem({ store, fs: channel, clock, catalog }, { item_id: itemId, channel_id: "chan-a", portfolio_id: "portfolio-a" });

    studio.writeJsonAtomic(studio.paths.manifest(itemId), { ...approved, status: "withdrawn", updated_at: clock.now() });

    const second = claimItem({ store, fs: channel, clock, catalog }, { item_id: itemId, channel_id: "chan-a", portfolio_id: "portfolio-a" });

    expect(second.claim).toEqual(first.claim);
    expect(second.content.content_id).toBe(first.content.content_id);
    expect(store.listContentItems().filter((c) => c.library_item_id === itemId)).toHaveLength(1);
  });

  it("rejects the studio role writing a claim file with CONFIG_INVALID", () => {
    const { studio, store, clock, catalog } = world();
    const itemId = newId("library_item");
    studio.writeJsonAtomic(studio.paths.manifest(itemId), makeItem(itemId, { status: "approved" }));

    let caught: unknown;
    try {
      claimItem({ store, fs: studio, clock, catalog }, { item_id: itemId, channel_id: "chan-a", portfolio_id: "portfolio-a" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });
});
