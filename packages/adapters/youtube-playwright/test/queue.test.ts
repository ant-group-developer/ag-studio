import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newestUploadFor, readQueue, type QueueLine } from "../src/queue.js";

describe("readQueue", () => {
  it("returns [] when the file is missing", () => {
    expect(readQueue(join(mkdtempSync(join(tmpdir(), "queue-")), "no-such-file.json"))).toEqual([]);
  });

  it("returns [] when the file is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-"));
    const path = join(dir, "publish-queue.json");
    writeFileSync(path, "{ not json");
    expect(readQueue(path)).toEqual([]);
  });

  it("returns [] when the JSON is valid but not an array", () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-"));
    const path = join(dir, "publish-queue.json");
    writeFileSync(path, JSON.stringify({ oops: true }));
    expect(readQueue(path)).toEqual([]);
  });

  it("parses a well-formed queue file", () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-"));
    const path = join(dir, "publish-queue.json");
    const lines: QueueLine[] = [{ ep: "05", videoId: "yt-1", addedAt: "2026-09-10T00:00:00.000Z" }];
    writeFileSync(path, JSON.stringify(lines));
    expect(readQueue(path)).toEqual(lines);
  });
});

describe("newestUploadFor", () => {
  it("picks the newest line for the matching episode, at or after since", () => {
    const lines: QueueLine[] = [
      { ep: "15", videoId: "a", addedAt: "2026-09-10T00:00:00.000Z" },
      { ep: "15", videoId: "b", addedAt: "2026-09-12T00:00:00.000Z" },
      { ep: "15", videoId: "c", addedAt: "2026-09-11T00:00:00.000Z" },
    ];
    expect(newestUploadFor(lines, 15, "2026-09-01T00:00:00.000Z")?.videoId).toBe("b");
  });

  it("compares ep with String(ep).padStart(2, '0'), so a bare numeric episode_no matches a zero-padded ep", () => {
    const lines: QueueLine[] = [{ ep: "05", videoId: "a", addedAt: "2026-09-10T00:00:00.000Z" }];
    expect(newestUploadFor(lines, 5, "2026-09-01T00:00:00.000Z")?.videoId).toBe("a");
  });

  it("ignores lines older than since", () => {
    const lines: QueueLine[] = [{ ep: "15", videoId: "a", addedAt: "2026-09-01T00:00:00.000Z" }];
    expect(newestUploadFor(lines, 15, "2026-09-05T00:00:00.000Z")).toBeUndefined();
  });

  it("ignores removed lines", () => {
    const lines: QueueLine[] = [{ ep: "15", videoId: "a", addedAt: "2026-09-10T00:00:00.000Z", removed: true }];
    expect(newestUploadFor(lines, 15, "2026-09-01T00:00:00.000Z")).toBeUndefined();
  });

  it("ignores lines for a different episode", () => {
    const lines: QueueLine[] = [{ ep: "16", videoId: "a", addedAt: "2026-09-10T00:00:00.000Z" }];
    expect(newestUploadFor(lines, 15, "2026-09-01T00:00:00.000Z")).toBeUndefined();
  });

  it("returns undefined for an empty queue", () => {
    expect(newestUploadFor([], 15, "2026-09-01T00:00:00.000Z")).toBeUndefined();
  });
});
