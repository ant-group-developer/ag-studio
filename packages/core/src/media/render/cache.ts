/** Content-addressed mezzanine cache -- sub-project 5B Task 7, spec §5.1. A cache entry is a pair of files
 * in one flat directory: `<key>.mp4` (the rendered mezzanine) and `<key>.json` (its sidecar). The sidecar is
 * the only source of truth for the LRU sweep: file `atime` is not reliable on Windows, so `last_used_at` is
 * written explicitly on every hit. A media file with no readable sidecar is unusable (nothing knows how long
 * it is or when it was last wanted) and is deleted on sight. */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { HarnessError } from "@harness/contracts";

export interface MezzCache {
  /** Flat directory holding `<key>.mp4` + `<key>.json` pairs; created on demand. */
  dir: string;
  /** LRU ceiling in bytes (`media.render.cache_max_gb` x 1024^3), enforced by `cacheEvict` after each run. */
  maxBytes: number;
}

const sidecarSchema = z.object({
  key: z.string().min(1),
  seconds: z.number().min(0),
  bytes: z.number().int().min(0),
  created_at: z.string().min(1),
  last_used_at: z.string().min(1),
}).strict();

export type MezzCacheSidecar = z.infer<typeof sidecarSchema>;

const mediaPath = (c: MezzCache, key: string, ext: "mp4"): string => join(c.dir, `${key}.${ext}`);
const sidecarPath = (c: MezzCache, key: string): string => join(c.dir, `${key}.json`);

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A cache file we cannot delete (a virus scanner still holding it open, say) is not worth failing a
    // render over -- the next sweep tries again.
  }
}

/**
 * `<dir>/<key>.<ext>` when it exists AND its sidecar parses; `null` otherwise. A hit rewrites the sidecar
 * with `now` as `last_used_at` (leaving `created_at` alone) so `cacheEvict` can order entries by real use.
 *
 * A media file with a missing or unparsable sidecar counts as a MISS and both files are deleted, per spec
 * §5.1 ("thiếu sidecar → coi như miss và xoá file"). `now` defaults to the wall clock; the runner passes its
 * injected `Clock` so the whole render shares one timestamp and tests never need real time.
 */
export function cacheLookup(c: MezzCache, key: string, ext: "mp4", now: string = new Date().toISOString()): string | null {
  const media = mediaPath(c, key, ext);
  if (!existsSync(media)) return null;

  const sidecar = sidecarPath(c, key);
  let parsed: MezzCacheSidecar;
  try {
    parsed = sidecarSchema.parse(JSON.parse(readFileSync(sidecar, "utf8")));
  } catch {
    removeQuietly(media);
    removeQuietly(sidecar);
    return null;
  }

  try {
    writeFileSync(sidecar, JSON.stringify({ ...parsed, last_used_at: now }));
  } catch {
    // A sidecar we cannot rewrite still describes a usable file; it just looks older than it is to the next
    // sweep, which is the safe direction to be wrong in.
  }
  return media;
}

/**
 * Moves a finished render at `tmpPath` into the cache as `<key>.mp4` and writes its sidecar; returns the
 * cached path. `renameSync` first (atomic on the same volume, which is the normal case when the workspace
 * and the cache share a data root); `EXDEV`/`EPERM` fall back to copy-then-delete, since the run output dir
 * and `data_root/cache` can legitimately sit on different drives on a Windows host.
 */
export function cacheCommit(c: MezzCache, key: string, tmpPath: string, meta: { seconds: number; bytes: number; now: string }): string {
  mkdirSync(c.dir, { recursive: true });
  const media = mediaPath(c, key, "mp4");
  removeQuietly(media);

  try {
    renameSync(tmpPath, media);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") {
      throw new HarnessError("IO_ERROR", `mezzanine cache commit failed for ${key}: ${(e as Error).message}`, { key, tmp_path: tmpPath, target: media });
    }
    copyFileSync(tmpPath, media);
    removeQuietly(tmpPath);
  }

  const sidecar: MezzCacheSidecar = { key, seconds: meta.seconds, bytes: meta.bytes, created_at: meta.now, last_used_at: meta.now };
  writeFileSync(sidecarPath(c, key), JSON.stringify(sidecar));
  return media;
}

/**
 * Sweeps the cache down to `maxBytes` by deleting whole entries (media + sidecar), oldest `last_used_at`
 * first. Media files with no readable sidecar are treated as infinitely old, so an orphan left behind by an
 * interrupted commit is the first thing to go. Returns how many entries were removed and how many bytes that
 * freed. A cache directory that does not exist yet is a no-op, not an error.
 */
export function cacheEvict(c: MezzCache): { removed: number; bytes: number } {
  if (!existsSync(c.dir)) return { removed: 0, bytes: 0 };

  let entries: { key: string; media: string; bytes: number; lastUsed: number }[];
  try {
    entries = readdirSync(c.dir)
      .filter((name) => extname(name) === ".mp4")
      .map((name) => {
        const key = basename(name, ".mp4");
        const media = join(c.dir, name);
        let bytes = 0;
        try {
          bytes = statSync(media).size;
        } catch {
          bytes = 0;
        }
        let lastUsed = Number.NEGATIVE_INFINITY;
        try {
          const parsed = sidecarSchema.parse(JSON.parse(readFileSync(sidecarPath(c, key), "utf8")));
          const t = Date.parse(parsed.last_used_at);
          if (Number.isFinite(t)) lastUsed = t;
        } catch {
          lastUsed = Number.NEGATIVE_INFINITY;
        }
        return { key, media, bytes, lastUsed };
      });
  } catch {
    return { removed: 0, bytes: 0 };
  }

  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= c.maxBytes) return { removed: 0, bytes: 0 };

  entries.sort((a, b) => a.lastUsed - b.lastUsed || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let removed = 0;
  let freed = 0;
  for (const e of entries) {
    if (total <= c.maxBytes) break;
    removeQuietly(e.media);
    removeQuietly(sidecarPath(c, e.key));
    total -= e.bytes;
    freed += e.bytes;
    removed++;
  }
  return { removed, bytes: freed };
}
