import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PublisherChannel, StatsCollector, StatsOutcome } from "@harness/contracts";
import { publisherChildEnv } from "./playwright-publisher.js";
import { parseStatsJson } from "./metrics-parse.js";

/** `<package root>/scripts/collect-stats.mjs`; same relative depth from `src/` (dev) and `dist/` (built). */
const DEFAULT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "collect-stats.mjs");

export interface PlaywrightStatsCollectorOptions {
  /** Node executable used to spawn the legacy script. Default: `process.execPath`. */
  node?: string;
  /** Applied to every stdout/stderr line before it reaches `log`, and to any reason string derived from
   * them. Default: identity. */
  redact?: (s: string) => string;
  /** Default: `<package>/scripts/collect-stats.mjs`. */
  script?: string;
  /**
   * Test-only: path to a JSON file `{ [video_id]: StatsOutcome }`. When set (directly or via
   * `HARNESS_FAKE_STATS_FILE`), `collect()` never spawns anything and answers from the file instead,
   * re-read on every call so a test can change the scenario mid-run.
   */
  statsFile?: string;
}

function identity(s: string): string {
  return s;
}

function lastNonEmptyLine(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

export class PlaywrightStatsCollector implements StatsCollector {
  readonly name = "youtube-playwright-stats";
  private readonly node: string;
  private readonly redact: (s: string) => string;
  private readonly script: string;
  private readonly statsFile: string | undefined;

  constructor(opts: PlaywrightStatsCollectorOptions = {}) {
    this.node = opts.node ?? process.execPath;
    this.redact = opts.redact ?? identity;
    this.script = opts.script ?? DEFAULT_SCRIPT;
    this.statsFile = opts.statsFile ?? process.env.HARNESS_FAKE_STATS_FILE;
  }

  async collect(p: { channel: PublisherChannel; video_id: string; timeout_seconds: number; log?: (line: string) => void }): Promise<StatsOutcome> {
    if (this.statsFile) return this.collectFromFile(this.statsFile, p.video_id);

    const args = [this.script, "--profile", join(p.channel.repo_dir, ".upload-profile"), "--video", p.video_id];
    const result = spawnSync(this.node, args, {
      encoding: "utf8",
      timeout: p.timeout_seconds * 1000,
      killSignal: "SIGKILL",
      env: publisherChildEnv(process.env),
    });

    this.emitLines(result.stdout, p.log);
    this.emitLines(result.stderr, p.log);

    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (errorCode === "ETIMEDOUT" || result.signal) {
      return { kind: "error", reason: "collect script timed out" };
    }
    if (result.error) {
      return { kind: "error", reason: this.redact(result.error.message) };
    }

    // Only a clean exit 0 is trusted to carry a real StatsOutcome on stdout (mirrors
    // PlaywrightPublisher.lookupViaScript): any non-zero exit is reported from the output tail instead of
    // risking a parse of stdout content the script may not have finished writing.
    if (result.status === 0) return parseStatsJson(result.stdout ?? "");

    const tailLine = lastNonEmptyLine(result.stderr) ?? lastNonEmptyLine(result.stdout);
    if (result.status === 2) {
      return { kind: "blocked", reason: this.redact(tailLine ?? `collect script blocked (exit ${result.status})`) };
    }
    return { kind: "error", reason: this.redact(tailLine ?? `collect script exited with code ${result.status}`) };
  }

  private collectFromFile(path: string, video_id: string): StatsOutcome {
    let data: Record<string, StatsOutcome>;
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as Record<string, StatsOutcome>;
    } catch (e) {
      // An unreadable/corrupt stats file is an error, not a definitive "no outcome for this video".
      return { kind: "error", reason: `stats file unreadable: ${e instanceof Error ? e.message : String(e)}` };
    }
    const outcome = data[video_id];
    if (!outcome) return { kind: "error", reason: `no fake outcome for ${video_id}` };
    return outcome;
  }

  private emitLines(text: string | null | undefined, log?: (line: string) => void): void {
    if (!log || !text) return;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      log(this.redact(line));
    }
  }
}
