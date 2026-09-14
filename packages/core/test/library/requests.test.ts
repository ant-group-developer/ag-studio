import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, newId } from "@harness/contracts";
import { claimRequest, createRequest, fulfillRequest, LibraryFs, rejectRequest, reopenRequest } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "library-requests-"));
}

function world() {
  const root = tempRoot();
  const fs = new LibraryFs({ root, role: "channel" });
  const { store, clock } = openTempStore();
  return { root, fs, store, clock, d: { store, fs, clock } };
}

describe("createRequest", () => {
  it("writes an open request file and mirrors it into the store", () => {
    const { d, fs } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a", channel_id: "chan-a" }, topic: "5 ancient ruins", count: 2 });

    expect(request.status).toBe("open");
    expect(request.item_ids).toEqual([]);
    expect(request.notes).toBe("");
    expect(request.created_at).toBe(request.updated_at);

    const onDisk = JSON.parse(readFileSync(fs.paths.requestFile(request.request_id), "utf8"));
    expect(onDisk.status).toBe("open");
    expect(onDisk.request_id).toBe(request.request_id);

    expect(d.store.getContentRequest(request.request_id)).toEqual(request);
  });

  it("defaults notes to empty string and count to 1 when omitted", () => {
    const { d } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    expect(request.notes).toBe("");
    expect(request.count).toBe(1);
    expect(request.voice).toBe("none");
    expect(request.language).toBe("vi");
  });
});

describe("claimRequest", () => {
  it("moves open -> claimed and is idempotent when reclaimed by the same run", () => {
    const { d } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    const run = { project_id: "project-studio", run_id: newId("run") };

    const first = claimRequest(d, { request_id: request.request_id, run });
    expect(first.status).toBe("claimed");
    expect(first.claimed_by_run).toEqual(run);

    const second = claimRequest(d, { request_id: request.request_id, run });
    expect(second).toEqual(first);
  });

  it("rejects a claim from a different run with INVALID_TRANSITION", () => {
    const { d } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    const runA = { project_id: "project-studio", run_id: newId("run") };
    const runB = { project_id: "project-studio", run_id: newId("run") };
    claimRequest(d, { request_id: request.request_id, run: runA });

    let caught: unknown;
    try {
      claimRequest(d, { request_id: request.request_id, run: runB });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "INVALID_TRANSITION")).toBe(true);
  });

  it("rejects claiming a fulfilled or rejected request", () => {
    const { d } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    const run = { project_id: "project-studio", run_id: newId("run") };
    claimRequest(d, { request_id: request.request_id, run });
    fulfillRequest(d, { request_id: request.request_id, item_id: newId("library_item") });

    let caught: unknown;
    try {
      claimRequest(d, { request_id: request.request_id, run });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "INVALID_TRANSITION")).toBe(true);
  });

  it("throws NOT_FOUND for a request file that does not exist", () => {
    const { d } = world();
    let caught: unknown;
    try {
      claimRequest(d, { request_id: newId("content_request"), run: { project_id: "p", run_id: newId("run") } });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "NOT_FOUND")).toBe(true);
  });
});

describe("fulfillRequest", () => {
  it("stays claimed until item_ids reaches count, then becomes fulfilled", () => {
    const { d } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic", count: 2 });
    const run = { project_id: "project-studio", run_id: newId("run") };
    claimRequest(d, { request_id: request.request_id, run });

    const item1 = newId("library_item");
    const afterFirst = fulfillRequest(d, { request_id: request.request_id, item_id: item1 });
    expect(afterFirst.status).toBe("claimed");
    expect(afterFirst.item_ids).toEqual([item1]);

    const item2 = newId("library_item");
    const afterSecond = fulfillRequest(d, { request_id: request.request_id, item_id: item2 });
    expect(afterSecond.status).toBe("fulfilled");
    expect(afterSecond.item_ids).toEqual([item1, item2]);
  });

  it("only transitions from claimed", () => {
    const { d } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    let caught: unknown;
    try {
      fulfillRequest(d, { request_id: request.request_id, item_id: newId("library_item") });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "INVALID_TRANSITION")).toBe(true);
  });
});

describe("rejectRequest", () => {
  it("moves claimed -> rejected and appends the note", () => {
    const { d } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic", notes: "first note" });
    const run = { project_id: "project-studio", run_id: newId("run") };
    claimRequest(d, { request_id: request.request_id, run });

    const rejected = rejectRequest(d, { request_id: request.request_id, note: "not on-brief" });
    expect(rejected.status).toBe("rejected");
    expect(rejected.notes).toBe("first note\nnot on-brief");
  });
});

describe("reopenRequest", () => {
  it("moves rejected -> open, clears claimed_by_run, and keeps prior notes", () => {
    const { d } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    const run = { project_id: "project-studio", run_id: newId("run") };
    claimRequest(d, { request_id: request.request_id, run });
    rejectRequest(d, { request_id: request.request_id, note: "not on-brief" });

    const reopened = reopenRequest(d, { request_id: request.request_id, note: "try again" });
    expect(reopened.status).toBe("open");
    expect(reopened.claimed_by_run).toBeUndefined();
    expect(reopened.notes).toBe("not on-brief\ntry again");
  });

  it("moves claimed -> open directly", () => {
    const { d } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    const run = { project_id: "project-studio", run_id: newId("run") };
    claimRequest(d, { request_id: request.request_id, run });

    const reopened = reopenRequest(d, { request_id: request.request_id, note: "cancelled" });
    expect(reopened.status).toBe("open");
    expect(reopened.claimed_by_run).toBeUndefined();
  });

  it("rejects reopening an already-open request", () => {
    const { d } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    let caught: unknown;
    try {
      reopenRequest(d, { request_id: request.request_id, note: "x" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "INVALID_TRANSITION")).toBe(true);
  });
});
