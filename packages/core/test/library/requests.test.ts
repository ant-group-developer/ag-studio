import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, newId } from "@harness/contracts";
import { claimRequest, createRequest, fulfillRequest, LibraryFs, readRequest, rejectRequest, reopenRequest } from "../../src/index.js";
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
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a", channel_id: "chan-a" }, topic: "5 ancient ruins" });

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

  it("is fixed at count 1: a hand-written request asking for more is CONFIG_INVALID on read", () => {
    const { d, fs } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    fs.writeJsonAtomic(fs.paths.requestFile(request.request_id), { ...request, count: 2 });

    let caught: unknown;
    try {
      readRequest(d, request.request_id);
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });
});

describe("readRequest", () => {
  it("is NOT_FOUND only when the file is absent; an unreadable/invalid file keeps its own error code", () => {
    const { d, fs } = world();

    let caught: unknown;
    try {
      readRequest(d, newId("content_request"));
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "NOT_FOUND")).toBe(true);

    // the file exists but holds garbage: that is an IO_ERROR (the kho is reachable, the content is not
    // usable), never NOT_FOUND -- `library-stage` retries IO_ERROR and fails the run on NOT_FOUND.
    const brokenId = newId("content_request");
    mkdirSync(fs.paths.requests, { recursive: true });
    writeFileSync(fs.paths.requestFile(brokenId), "{ not json");
    caught = undefined;
    try {
      readRequest(d, brokenId);
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "IO_ERROR")).toBe(true);

    // a directory where the request file should be: readFileSync throws EISDIR, still IO_ERROR
    const dirId = newId("content_request");
    mkdirSync(fs.paths.requestFile(dirId), { recursive: true });
    caught = undefined;
    try {
      readRequest(d, dirId);
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "IO_ERROR")).toBe(true);
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
  it("is fulfilled by the first item, since count is pinned at 1", () => {
    const { d } = world();
    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "topic" });
    expect(request.count).toBe(1);
    const run = { project_id: "project-studio", run_id: newId("run") };
    claimRequest(d, { request_id: request.request_id, run });

    const item1 = newId("library_item");
    const fulfilled = fulfillRequest(d, { request_id: request.request_id, item_id: item1 });
    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.item_ids).toEqual([item1]);

    // and a second call is refused: a fulfilled request is no longer claimed (the `>= count` comparison
    // stays in fulfillRequest for the day count can exceed 1 again, but nothing can reach it today)
    let caught: unknown;
    try {
      fulfillRequest(d, { request_id: request.request_id, item_id: newId("library_item") });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "INVALID_TRANSITION")).toBe(true);
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
