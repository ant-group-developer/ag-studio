import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheCommit, cacheEvict, cacheLookup, type MezzCache } from "../../../src/media/render/cache.js";

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  return d;
}

function cache(maxBytes = 10_000_000): MezzCache {
  return { dir: join(tempDir("mezz-cache-"), "mezz"), maxBytes };
}

/** Writes `bytes` bytes to `<tmp>/<name>` and returns the path -- stands in for a rendered mezzanine. */
function tmpFile(bytes: number, name = "x.mp4"): string {
  const dir = tempDir("mezz-tmp-");
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

describe("cacheCommit / cacheLookup", () => {
  it("commits a tmp render into the cache and finds it again, bumping last_used_at", () => {
    const c = cache();
    const committed = cacheCommit(c, "k1", tmpFile(1024), { seconds: 2, bytes: 1024, now: "2026-09-22T10:00:00.000Z" });
    expect(committed).toBe(join(c.dir, "k1.mp4"));
    expect(existsSync(committed)).toBe(true);
    expect(statSync(committed).size).toBe(1024);

    const sidecarBefore = JSON.parse(readFileSync(join(c.dir, "k1.json"), "utf8")) as Record<string, unknown>;
    expect(sidecarBefore).toMatchObject({ key: "k1", seconds: 2, bytes: 1024, created_at: "2026-09-22T10:00:00.000Z", last_used_at: "2026-09-22T10:00:00.000Z" });

    const hit = cacheLookup(c, "k1", "mp4", "2026-09-22T11:30:00.000Z");
    expect(hit).toBe(committed);
    const sidecarAfter = JSON.parse(readFileSync(join(c.dir, "k1.json"), "utf8")) as Record<string, unknown>;
    expect(sidecarAfter.last_used_at).toBe("2026-09-22T11:30:00.000Z");
    // created_at never moves: the LRU sweep orders by last_used_at only.
    expect(sidecarAfter.created_at).toBe("2026-09-22T10:00:00.000Z");
  });

  it("misses on an unknown key without creating anything", () => {
    const c = cache();
    expect(cacheLookup(c, "nope", "mp4", "2026-09-22T10:00:00.000Z")).toBeNull();
    expect(existsSync(join(c.dir, "nope.mp4"))).toBe(false);
  });

  it("treats a media file with no sidecar as a miss AND deletes the orphan", () => {
    const c = cache();
    mkdirSync(c.dir, { recursive: true });
    const orphan = join(c.dir, "k2.mp4");
    writeFileSync(orphan, Buffer.alloc(512, 3));

    expect(cacheLookup(c, "k2", "mp4", "2026-09-22T10:00:00.000Z")).toBeNull();
    expect(existsSync(orphan)).toBe(false);
  });

  it("treats an unparsable sidecar as a miss and deletes both files", () => {
    const c = cache();
    cacheCommit(c, "k3", tmpFile(256), { seconds: 1, bytes: 256, now: "2026-09-22T10:00:00.000Z" });
    writeFileSync(join(c.dir, "k3.json"), "{not json");

    expect(cacheLookup(c, "k3", "mp4", "2026-09-22T10:00:00.000Z")).toBeNull();
    expect(existsSync(join(c.dir, "k3.mp4"))).toBe(false);
    expect(existsSync(join(c.dir, "k3.json"))).toBe(false);
  });
});

describe("cacheEvict", () => {
  it("removes least-recently-used entries until the cache fits maxBytes", () => {
    const c = cache(2500);
    cacheCommit(c, "old", tmpFile(1000, "a.mp4"), { seconds: 1, bytes: 1000, now: "2026-09-22T08:00:00.000Z" });
    cacheCommit(c, "mid", tmpFile(1000, "b.mp4"), { seconds: 1, bytes: 1000, now: "2026-09-22T09:00:00.000Z" });
    cacheCommit(c, "new", tmpFile(1000, "c.mp4"), { seconds: 1, bytes: 1000, now: "2026-09-22T10:00:00.000Z" });

    const evicted = cacheEvict(c);
    expect(evicted.removed).toBe(1);
    expect(evicted.bytes).toBeGreaterThanOrEqual(1000);
    expect(existsSync(join(c.dir, "old.mp4"))).toBe(false);
    expect(existsSync(join(c.dir, "old.json"))).toBe(false);
    expect(existsSync(join(c.dir, "mid.mp4"))).toBe(true);
    expect(existsSync(join(c.dir, "new.mp4"))).toBe(true);
  });

  it("a fresh lookup makes an old entry survive the next sweep", () => {
    const c = cache(2500);
    cacheCommit(c, "old", tmpFile(1000, "a.mp4"), { seconds: 1, bytes: 1000, now: "2026-09-22T08:00:00.000Z" });
    cacheCommit(c, "mid", tmpFile(1000, "b.mp4"), { seconds: 1, bytes: 1000, now: "2026-09-22T09:00:00.000Z" });
    cacheCommit(c, "new", tmpFile(1000, "c.mp4"), { seconds: 1, bytes: 1000, now: "2026-09-22T10:00:00.000Z" });
    cacheLookup(c, "old", "mp4", "2026-09-22T11:00:00.000Z");

    cacheEvict(c);
    expect(existsSync(join(c.dir, "old.mp4"))).toBe(true);
    expect(existsSync(join(c.dir, "mid.mp4"))).toBe(false);
  });

  it("does nothing when the cache is under the limit, or when the dir does not exist yet", () => {
    const c = cache(10_000);
    expect(cacheEvict(c)).toEqual({ removed: 0, bytes: 0 });
    cacheCommit(c, "k", tmpFile(100), { seconds: 1, bytes: 100, now: "2026-09-22T10:00:00.000Z" });
    expect(cacheEvict(c)).toEqual({ removed: 0, bytes: 0 });
    expect(existsSync(join(c.dir, "k.mp4"))).toBe(true);
  });

  it("sweeps sidecars whose media file is gone, even when the cache is under the limit", () => {
    const c = cache(10_000);
    cacheCommit(c, "keep", tmpFile(100), { seconds: 1, bytes: 100, now: "2026-09-22T10:00:00.000Z" });
    writeFileSync(join(c.dir, "ghost.json"), JSON.stringify({ key: "ghost", seconds: 1, bytes: 1, created_at: "2026-09-22T08:00:00.000Z", last_used_at: "2026-09-22T08:00:00.000Z" }));

    // Housekeeping, not eviction: the counters stay at zero because nothing that took up space was removed.
    expect(cacheEvict(c)).toEqual({ removed: 0, bytes: 0 });
    expect(existsSync(join(c.dir, "ghost.json"))).toBe(false);
    expect(existsSync(join(c.dir, "keep.mp4"))).toBe(true);
    expect(existsSync(join(c.dir, "keep.json"))).toBe(true);
  });

  it("evicts orphan media files (no sidecar) first, whatever their mtime", () => {
    const c = cache(1500);
    cacheCommit(c, "keep", tmpFile(1000, "a.mp4"), { seconds: 1, bytes: 1000, now: "2026-09-22T08:00:00.000Z" });
    mkdirSync(c.dir, { recursive: true });
    writeFileSync(join(c.dir, "orphan.mp4"), Buffer.alloc(1000, 1));

    const evicted = cacheEvict(c);
    expect(evicted.removed).toBe(1);
    expect(existsSync(join(c.dir, "orphan.mp4"))).toBe(false);
    expect(existsSync(join(c.dir, "keep.mp4"))).toBe(true);
    rmSync(c.dir, { recursive: true, force: true });
  });
});
