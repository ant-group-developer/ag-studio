import { readFileSync } from "node:fs";
import type { PublisherChannel, StatsCollector, StatsOutcome } from "@harness/contracts";

export interface FakeStatsCollectorOptions {
  outcomes?: Record<string, StatsOutcome>;
  /** Path to a JSON file `{ [video_id]: StatsOutcome }`, re-read on every `collect()` call (also settable
   * via the `HARNESS_FAKE_STATS_FILE` env var — see `PlaywrightStatsCollector`'s `statsFile`, the same test
   * hook shape). */
  file?: string;
  default?: StatsOutcome;
}

const DEFAULT_OUTCOME: StatsOutcome = { kind: "ok", views: 100, impressions: 500, ctr_pct: 5, avg_view_sec: 60 };

/**
 * In-process stand-in for `PlaywrightStatsCollector`: no browser, no spawned script. Precedence per
 * `collect()` call: `outcomes[video_id]` (set once at construction) -> `file`'s `[video_id]` entry (read
 * fresh every call, so a test can change the scenario mid-run) -> `default`.
 */
export class FakeStatsCollector implements StatsCollector {
  readonly name = "fake-stats";
  calls: string[] = [];
  private readonly outcomes: Record<string, StatsOutcome>;
  private readonly file: string | undefined;
  private readonly defaultOutcome: StatsOutcome;

  constructor(opts: FakeStatsCollectorOptions = {}) {
    this.outcomes = opts.outcomes ?? {};
    this.file = opts.file;
    this.defaultOutcome = opts.default ?? DEFAULT_OUTCOME;
  }

  async collect(p: { channel: PublisherChannel; video_id: string; timeout_seconds: number; log?: (line: string) => void }): Promise<StatsOutcome> {
    this.calls.push(p.video_id);
    const fromOutcomes = this.outcomes[p.video_id];
    if (fromOutcomes) return fromOutcomes;
    if (this.file) {
      const fromFile = this.readFile(this.file)[p.video_id];
      if (fromFile) return fromFile;
    }
    return this.defaultOutcome;
  }

  /** A missing/corrupt file reads as no entries, not a throw -- same tolerance as `FakePublisher`'s queue read. */
  private readFile(path: string): Record<string, StatsOutcome> {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, StatsOutcome>;
    } catch {
      return {};
    }
  }
}
