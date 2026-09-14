import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LookupOutcome, Publisher, PublisherChannel, ScheduleOutcome, UploadOutcome } from "@harness/contracts";

export interface FakePublisherOptions {
  upload?: "uploaded" | "unknown" | "refused" | "busy";
  schedule?: "scheduled" | "refused" | "busy";
  lookup?: LookupOutcome | ((p: { video_id?: string; title?: string }) => LookupOutcome);
  /** Whether `upload` writes a `publish-queue.json` entry (default true). Only "refused"/"busy" never write, regardless. */
  writeQueue?: boolean;
}

interface QueueEntry { ep: number; videoId: string; addedAt: string; via: "fake" }

/**
 * In-process stand-in for the real `youtube-playwright` adapter: no browser, no filesystem script — just the
 * `Publisher` contract plus enough side effects (a `publish-queue.json` line) for callers that read the queue
 * the way the legacy upload script's consumer does.
 */
export class FakePublisher implements Publisher {
  readonly name = "fake-publisher";
  uploads: { episode_no: number; video_id: string }[] = [];
  schedules: { video_id: string; at: string }[] = [];
  lookups = 0;
  private uploadCount = 0;

  constructor(private readonly opts: FakePublisherOptions = {}) {}

  async upload(p: { channel: PublisherChannel; episode_no: number; episode_dir: string; intent_at: string; timeout_seconds: number; log?: (line: string) => void }): Promise<UploadOutcome> {
    const kind = this.opts.upload ?? "uploaded";
    if (kind === "refused") return { kind: "refused", reason: "fake-publisher: upload refused" };
    if (kind === "busy") return { kind: "busy", reason: "fake-publisher: uploader busy" };

    this.uploadCount += 1;
    const video_id = `fake-${this.uploadCount}`;
    this.uploads.push({ episode_no: p.episode_no, video_id });

    // A video may exist on the platform even when the outcome is "unknown" (the script died after creating
    // it), so the queue entry is written for both "uploaded" and "unknown" — only "refused"/"busy" skip it.
    if (this.opts.writeQueue ?? true) {
      this.appendQueueEntry(p.episode_dir, { ep: p.episode_no, videoId: video_id, addedAt: p.intent_at, via: "fake" });
    }

    if (kind === "unknown") return { kind: "unknown", reason: "fake-publisher: outcome unknown after upload" };
    return { kind: "uploaded", video_id, receipt: { via: "fake" } };
  }

  async schedule(p: { channel: PublisherChannel; video_id: string; at: string; timeout_seconds: number; log?: (line: string) => void }): Promise<ScheduleOutcome> {
    const kind = this.opts.schedule ?? "scheduled";
    if (kind === "refused") return { kind: "refused", reason: "fake-publisher: schedule refused" };
    if (kind === "busy") return { kind: "busy", reason: "fake-publisher: scheduler busy" };
    this.schedules.push({ video_id: p.video_id, at: p.at });
    return { kind: "scheduled" };
  }

  async lookup(p: { channel: PublisherChannel; video_id?: string; title?: string; since?: string }): Promise<LookupOutcome> {
    this.lookups += 1;
    const outcome = this.opts.lookup;
    if (typeof outcome === "function") {
      return outcome({ ...(p.video_id !== undefined ? { video_id: p.video_id } : {}), ...(p.title !== undefined ? { title: p.title } : {}) });
    }
    return outcome ?? { found: false };
  }

  /** Appends one entry to `<episode_dir>/../../publish-queue.json` (the legacy repo's episodes-root queue file). */
  private appendQueueEntry(episodeDir: string, entry: QueueEntry): void {
    const queuePath = join(episodeDir, "..", "..", "publish-queue.json");
    let queue: unknown[] = [];
    if (existsSync(queuePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(queuePath, "utf8"));
        if (Array.isArray(parsed)) queue = parsed;
      } catch {
        queue = [];
      }
    }
    queue.push(entry);
    mkdirSync(dirname(queuePath), { recursive: true });
    writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  }
}
