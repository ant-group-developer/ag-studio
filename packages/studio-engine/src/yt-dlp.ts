/**
 * yt-dlp for the series plan (plan 2026-10-08 quality-fixes, ADR-0001 items 175–176): the real numbers of the YouTube
 * links Claude found when the Data API could not answer, a channel's recent uploads, and a reference video downloaded
 * at ≤480p to learn its edit style (deleted by the caller once measured).
 *
 * Run asynchronously (`runTool`, ADR-0001 item 153). Every URL is rebuilt from a checked video id or a parsed channel
 * reference, never taken as typed, and yt-dlp runs with `--ignore-config`, no cookies, no login: what YouTube does not
 * show anyone is skipped, not worked around.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { youtubeChannelUrl, youtubeVideoUrl, type ChannelRef } from "@harness/core";
import { runTool } from "./cut-ffmpeg.js";

const VIDEO_ID = /^[\w-]{11}$/;
const META_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/** A reference video is at most this long and this big (yt-dlp skips the others). */
export const REFERENCE_MAX_SECONDS = 1800;
export const REFERENCE_MAX_BYTES = "300M";
const COMMON = ["--ignore-config", "--no-cookies", "--no-warnings", "--no-progress"];

/** What yt-dlp says of one video, as research keeps it (views per day and outliers are computed by research). */
export interface YtVideoMeta {
  video_id: string;
  channel_id: string;
  channel_title: string;
  title: string;
  published_at: string;
  duration_s: number;
  views: number;
  likes: number | null;
  comments: number | null;
  tags: string[];
}

export interface YtChannelList { channel_id: string | null; title: string | null; video_ids: string[] }

export interface YtDlp {
  /** The version yt-dlp reports; null when it cannot run (not installed, wrong path). */
  version(): Promise<string | null>;
  /** The videos yt-dlp could read, by id; ids it could not (removed, private, refused) are absent. */
  metadata(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, YtVideoMeta>>;
  /** A channel's newest uploads (ids only; `metadata` reads their numbers). */
  listChannel(ref: ChannelRef, limit: number, signal?: AbortSignal): Promise<YtChannelList>;
  /** One video at ≤480p into `dir`, as `<id>.<ext>`; throws with yt-dlp's last words when it cannot. */
  download(videoId: string, dir: string, signal?: AbortSignal): Promise<string>;
}

export interface YtDlpOptions {
  /** The program and its first arguments, e.g. `["yt-dlp"]` (tests: node and a fake script). */
  argv: readonly string[];
  /** ffmpeg yt-dlp merges video and sound with. */
  ffmpeg?: string;
}

function lastWords(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
  return (lines.filter((l) => l.startsWith("ERROR")).at(-1) ?? lines.at(-1) ?? "").slice(-300);
}

/** `20260601` or a unix time -> ISO; null when neither is there. */
function publishedAt(j: { upload_date?: string; timestamp?: number; release_timestamp?: number }): string | null {
  const ts = j.timestamp ?? j.release_timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts * 1000).toISOString();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(j.upload_date ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z` : null;
}

const int = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : null);

/** One `--dump-json` line -> what research keeps; null when it is not a video yt-dlp could read. */
export function ytVideoMeta(line: string): YtVideoMeta | null {
  let j: Record<string, unknown>;
  try { j = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  const id = typeof j.id === "string" ? j.id : "";
  const published = publishedAt(j as { upload_date?: string; timestamp?: number });
  if (!VIDEO_ID.test(id) || !published || typeof j.channel_id !== "string") return null;
  return {
    video_id: id,
    channel_id: j.channel_id,
    channel_title: typeof j.channel === "string" ? j.channel : typeof j.uploader === "string" ? j.uploader : "",
    title: typeof j.title === "string" ? j.title : "",
    published_at: published,
    duration_s: int(j.duration) ?? 0,
    views: int(j.view_count) ?? 0,
    likes: int(j.like_count),
    comments: int(j.comment_count),
    tags: Array.isArray(j.tags) ? j.tags.filter((t): t is string => typeof t === "string") : [],
  };
}

export function ytDlp(o: YtDlpOptions): YtDlp {
  const [bin, ...head] = o.argv;
  if (!bin) throw new Error("yt-dlp argv is empty");
  const run = (args: string[], timeoutMs: number, signal?: AbortSignal) => runTool(bin, [...head, ...args], { timeoutMs, ...(signal ? { signal } : {}) });
  return {
    async version() {
      try {
        const r = await run(["--version"], 30_000);
        return r.code === 0 ? r.stdout.trim() || null : null;
      } catch {
        return null;
      }
    },

    async metadata(ids, signal) {
      const valid = [...new Set(ids)].filter((id) => VIDEO_ID.test(id));
      const out = new Map<string, YtVideoMeta>();
      if (!valid.length) return out;
      const r = await run([...COMMON, "--dump-json", "--skip-download", "--no-playlist", "--ignore-errors", "--", ...valid.map(youtubeVideoUrl)], META_TIMEOUT_MS, signal);
      if (r.timedOut) throw new Error("yt-dlp: hết giờ khi đọc thông tin video");
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = line.trim() ? ytVideoMeta(line) : null;
        if (m) out.set(m.video_id, m);
      }
      if (!out.size && r.code !== 0) throw new Error(`yt-dlp không đọc được video nào: ${lastWords(r.stderr)}`);
      return out;
    },

    async listChannel(ref, limit, signal) {
      const page = youtubeChannelUrl(ref);
      if (!page) throw new Error("không phải link kênh YouTube");
      const r = await run([...COMMON, "--flat-playlist", "-J", "--playlist-end", String(limit), "--", `${page}/videos`], META_TIMEOUT_MS, signal);
      if (r.timedOut) throw new Error("yt-dlp: hết giờ khi đọc danh sách video của kênh");
      if (r.code !== 0) throw new Error(`yt-dlp không đọc được kênh: ${lastWords(r.stderr)}`);
      const j = JSON.parse(r.stdout) as { channel_id?: string; channel?: string; uploader?: string; title?: string; entries?: { id?: string }[] };
      return {
        channel_id: typeof j.channel_id === "string" ? j.channel_id : null,
        title: j.channel ?? j.uploader ?? j.title ?? null,
        video_ids: (j.entries ?? []).map((e) => e.id ?? "").filter((id) => VIDEO_ID.test(id)).slice(0, limit),
      };
    },

    async download(videoId, dir, signal) {
      if (!VIDEO_ID.test(videoId)) throw new Error(`"${videoId}" không phải id video YouTube`);
      const r = await run([
        ...COMMON, "--no-playlist", "--no-part", "--restrict-filenames",
        "-f", "bv*[height<=480]+ba/b[height<=480]/bv*[height<=480]", "--merge-output-format", "mp4",
        "--max-filesize", REFERENCE_MAX_BYTES, "--match-filter", `duration<=${REFERENCE_MAX_SECONDS} & !is_live`,
        ...(o.ffmpeg ? ["--ffmpeg-location", o.ffmpeg] : []),
        "-o", join(dir, `${videoId}.%(ext)s`), "--", youtubeVideoUrl(videoId),
      ], DOWNLOAD_TIMEOUT_MS, signal);
      if (r.timedOut) throw new Error("yt-dlp: hết giờ khi tải video");
      if (r.code !== 0) throw new Error(lastWords(r.stderr) || `yt-dlp exit ${String(r.code)}`);
      const file = readdirSync(dir).find((f) => f.startsWith(`${videoId}.`) && !f.endsWith(".part") && !f.endsWith(".json"));
      if (!file) throw new Error("yt-dlp không tải video (quá dài, quá lớn, đang live, hoặc không có bản ≤480p)");
      return join(dir, file);
    },
  };
}
