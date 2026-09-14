import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError } from "@harness/contracts";
import type { LookupOutcome, Publisher, PublisherChannel, ScheduleOutcome, UploadOutcome } from "@harness/contracts";
import { EXIT_BUSY, EXIT_REFUSED, newestUploadFor, readQueue } from "./queue.js";

/** `<package root>/scripts/lookup.mjs`; same relative depth from `src/` (dev) and `dist/` (built). */
const DEFAULT_LOOKUP_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lookup.mjs");

export interface PlaywrightPublisherOptions {
  /** Node executable used to spawn the legacy scripts. Default: `process.execPath`. */
  node?: string;
  /** Applied to every stdout/stderr line before it reaches `log`/`log_tail`. Default: identity. */
  redact?: (s: string) => string;
  /** Used for the oEmbed lookup request. Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Test-only: path to a JSON file `{ [video_id | "title:<title>"]: LookupOutcome }`. When set (directly or
   * via `HARNESS_PUBLISHER_LOOKUP_FILE`), `lookup()` never touches the network or Studio.
   */
  lookupFile?: string;
  /** Default: `<package>/scripts/lookup.mjs`. */
  lookupScript?: string;
}

interface RunResult {
  code: number | null;
  timedOut: boolean;
  /** Redacted stdout+stderr, last 40 lines. */
  tail: string[];
}

function identity(s: string): string {
  return s;
}

function lastLine(lines: string[]): string | undefined {
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

/** spawn()s `node script args...`, forwarding each redacted stdout/stderr line to `log` and keeping the last 40 as a tail; kills the child once `timeoutMs` elapses. Mirrors `ScriptExecutor`'s spawn/timeout/line-buffering pattern. */
function runScript(
  node: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  redact: (s: string) => string,
  log?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(node, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    const tail: string[] = [];
    let buf = "";
    let timedOut = false;

    const emit = (line: string) => {
      if (!line) return;
      const redacted = redact(line);
      tail.push(redacted);
      if (tail.length > 40) tail.shift();
      log?.(redacted);
    };
    const onData = (chunk: Buffer | string) => {
      buf += String(chunk);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) emit(line);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on("close", (code) => {
      emit(buf);
      clearTimeout(timer);
      resolvePromise({ code, timedOut, tail });
    });
  });
}

export class PlaywrightPublisher implements Publisher {
  readonly name = "youtube-playwright";
  private readonly node: string;
  private readonly redact: (s: string) => string;
  private readonly fetchImpl: typeof fetch;
  private readonly lookupFile: string | undefined;
  private readonly lookupScript: string;

  constructor(opts: PlaywrightPublisherOptions = {}) {
    this.node = opts.node ?? process.execPath;
    this.redact = opts.redact ?? identity;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.lookupFile = opts.lookupFile ?? process.env.HARNESS_PUBLISHER_LOOKUP_FILE;
    this.lookupScript = opts.lookupScript ?? DEFAULT_LOOKUP_SCRIPT;
  }

  async upload(p: { channel: PublisherChannel; episode_no: number; episode_dir: string; intent_at: string; timeout_seconds: number; log?: (line: string) => void }): Promise<UploadOutcome> {
    const nn = String(p.episode_no).padStart(2, "0");
    const { code, timedOut, tail } = await runScript(
      this.node,
      ["scripts/upload-youtube-playwright.mjs", `episode-${nn}`],
      p.channel.repo_dir,
      process.env,
      p.timeout_seconds * 1000,
      this.redact,
      p.log,
    );

    if (code === EXIT_REFUSED) return { kind: "refused", reason: lastLine(tail) ?? `upload refused (exit ${code})` };
    if (code === EXIT_BUSY) return { kind: "busy", reason: lastLine(tail) ?? `upload busy (exit ${code})` };

    if (code === 0) {
      const queuePath = join(p.channel.repo_dir, "outputs", p.channel.legacy_project_id, "publish-queue.json");
      const line = newestUploadFor(readQueue(queuePath), p.episode_no, p.intent_at);
      if (line) {
        return {
          kind: "uploaded",
          video_id: line.videoId,
          receipt: { exit_code: code, url: line.url, added_at: line.addedAt, log_tail: tail },
        };
      }
      return { kind: "unknown", reason: "upload script exited 0 but the queue has no matching line" };
    }

    // Non-zero and not a recognized refused/busy code (e.g. the legacy script died after the video was
    // already created), or the deadline was hit: outcome is unknown even if the queue *does* have a line by
    // now — a reconciliation pass looks for it later, this call just can't vouch for it.
    return { kind: "unknown", reason: timedOut ? "upload script exceeded the deadline" : `upload script exited with code ${code}` };
  }

  async schedule(p: { channel: PublisherChannel; video_id: string; at: string; timeout_seconds: number; log?: (line: string) => void }): Promise<ScheduleOutcome> {
    const { code, timedOut, tail } = await runScript(
      this.node,
      ["scripts/publish-video-playwright.mjs", p.video_id, "--schedule", p.at],
      p.channel.repo_dir,
      process.env,
      p.timeout_seconds * 1000,
      this.redact,
      p.log,
    );

    if (code === 0) return { kind: "scheduled" };
    if (code === EXIT_REFUSED) return { kind: "refused", reason: lastLine(tail) ?? `schedule refused (exit ${code})` };
    if (code === EXIT_BUSY) return { kind: "busy", reason: lastLine(tail) ?? `schedule busy (exit ${code})` };

    // Anything else (a crash, or the deadline being hit) is treated as transient: the caller retries the
    // stage rather than the adapter guessing whether the schedule actually took effect.
    throw new HarnessError("EXECUTOR_FAILED", timedOut ? "schedule script exceeded the deadline" : `schedule script exited with code ${code}`, {
      exit_code: code,
      timed_out: timedOut,
      log_tail: tail,
    });
  }

  async lookup(p: { channel: PublisherChannel; video_id?: string; title?: string; since?: string }): Promise<LookupOutcome> {
    if (this.lookupFile) return this.lookupFromFile(this.lookupFile, p.video_id, p.title);
    if (p.video_id) return this.lookupByOembed(p);
    return this.lookupViaScript(p);
  }

  private lookupFromFile(path: string, video_id: string | undefined, title: string | undefined): LookupOutcome {
    let data: Record<string, LookupOutcome>;
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as Record<string, LookupOutcome>;
    } catch {
      return { found: false };
    }
    if (video_id) {
      const byId = data[video_id];
      if (byId) return byId;
    }
    if (title) {
      const byTitle = data[`title:${title}`];
      if (byTitle) return byTitle;
    }
    return { found: false };
  }

  private async lookupByOembed(p: { channel: PublisherChannel; video_id?: string; title?: string; since?: string }): Promise<LookupOutcome> {
    const video_id = p.video_id!;
    try {
      const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${video_id}`)}&format=json`;
      const res = await this.fetchImpl(url);
      if (res.status === 200) {
        const body = (await res.json()) as { title?: string };
        return { found: true, video_id, visibility: "public", ...(body.title !== undefined ? { title: body.title } : {}) };
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) return this.lookupViaScript(p);
      return { found: false, reason: `oembed returned ${res.status}` };
    } catch (e) {
      return this.lookupViaScript(p, e instanceof Error ? e.message : String(e));
    }
  }

  private lookupViaScript(p: { channel: PublisherChannel; video_id?: string; title?: string; since?: string }, oembedError?: string): LookupOutcome {
    if (!existsSync(this.lookupScript)) {
      return { found: false, reason: oembedError ? `oembed failed (${oembedError}) and lookup script not found: ${this.lookupScript}` : `lookup script not found: ${this.lookupScript}` };
    }
    const args = ["--profile", join(p.channel.repo_dir, ".upload-profile"), "--channel", p.channel.expected_channel_id];
    if (p.video_id) args.push("--video", p.video_id);
    if (p.title) args.push("--title", p.title);
    if (p.since) args.push("--since", p.since);

    const result = spawnSync(this.node, [this.lookupScript, ...args], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      const reason = result.error ? result.error.message : (result.stdout || result.stderr || `lookup script exited with code ${result.status}`).trim();
      return { found: false, reason };
    }
    try {
      const line = result.stdout.trim().split(/\r?\n/).pop() ?? "";
      return JSON.parse(line) as LookupOutcome;
    } catch {
      return { found: false, reason: "lookup script produced invalid JSON" };
    }
  }
}
