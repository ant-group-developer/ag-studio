import { existsSync, readFileSync } from "node:fs";

/** One line of the legacy channel repo's `outputs/<project>/publish-queue.json`. */
export interface QueueLine {
  ep: string;
  videoId: string;
  addedAt: string;
  url?: string;
  title?: string;
  via?: string;
  removed?: boolean;
}

/** Parses a `publish-queue.json`; a missing file or invalid JSON both read as no lines rather than throwing. */
export function readQueue(path: string): QueueLine[] {
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as QueueLine[]) : [];
  } catch {
    return [];
  }
}

/**
 * The most recent, non-removed queue line for `episode_no` added at or after `since`. `ep` is compared as
 * `String(ep).padStart(2, "0")` since the legacy queue writer is not guaranteed to zero-pad or to write a
 * string (vs. a number) for `ep`.
 */
export function newestUploadFor(lines: QueueLine[], episode_no: number, since: string): QueueLine | undefined {
  const wantEp = String(episode_no).padStart(2, "0");
  const sinceMs = Date.parse(since);
  let newest: QueueLine | undefined;
  let newestMs = -Infinity;
  for (const line of lines) {
    if (line.removed) continue;
    if (!line.videoId) continue;
    if (String(line.ep).padStart(2, "0") !== wantEp) continue;
    const addedMs = Date.parse(line.addedAt);
    if (!Number.isFinite(addedMs) || addedMs < sinceMs) continue;
    if (addedMs >= newestMs) {
      newest = line;
      newestMs = addedMs;
    }
  }
  return newest;
}

export const EXIT_REFUSED = 3;
export const EXIT_BUSY = 4;
