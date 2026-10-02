import { Injectable, Logger } from '@nestjs/common';

/**
 * ffmpeg work the API does for thumbnails (draw words, capture, upload, cut frames) shares the box with the API
 * itself: at most two at a time, the rest wait their turn. Cutting the frames of an old episode runs in the
 * background (one per episode), and the list says it is under way.
 */
@Injectable()
export class ThumbnailWorkService {
  private readonly logger = new Logger(ThumbnailWorkService.name);
  private running = 0;
  private readonly queue: (() => void)[] = [];
  private readonly cutting = new Set<string>();
  private readonly cutErrors = new Map<string, string>();
  private readonly limit = 2;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  /** Starts cutting an episode's frames unless it is already under way; false when it was. */
  startCut(episodeId: string, fn: () => Promise<number>): boolean {
    if (this.cutting.has(episodeId)) return false;
    this.cutting.add(episodeId);
    this.cutErrors.delete(episodeId);
    void this.run(fn)
      .then((n) => this.logger.log(`cut ${n} frames for episode ${episodeId}`))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        this.cutErrors.set(episodeId, message);
        this.logger.warn(`cutting the frames of ${episodeId} failed: ${message}`);
      })
      .finally(() => this.cutting.delete(episodeId));
    return true;
  }

  cutState(episodeId: string): { pending: boolean; error: string | null } {
    return { pending: this.cutting.has(episodeId), error: this.cutErrors.get(episodeId) ?? null };
  }
}
