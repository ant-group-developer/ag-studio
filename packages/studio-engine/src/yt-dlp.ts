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
/**
 * Every call. YouTube needs a JavaScript runtime to give the formats (yt-dlp 2025.11 on; without one a download finds
 * no ≤480p video): the worker's own Node is always there, so yt-dlp is pointed at it.
 */
export const YTDLP_COMMON_ARGS = ["--ignore-config", "--no-cookies", "--no-warnings", "--no-progress", "--js-runtimes", `node:${process.execPath}`];
const COMMON = YTDLP_COMMON_ARGS;

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
  /** YouTube's search for videos (`ytsearchN:`, `ytsearchdateN:` newest first): ids only, in YouTube's order. */
  search(query: string, limit: number, order: "relevance" | "date", signal?: AbortSignal): Promise<string[]>;
  /** One video at ≤480p into `dir`, as `<id>.<ext>`; throws a `YtDlpError` saying why when it cannot. */
  download(videoId: string, dir: string, signal?: AbortSignal): Promise<string>;
}

export interface YtDlpOptions {
  /** The program and its first arguments, e.g. `["yt-dlp"]` (tests: node and a fake script). */
  argv: readonly string[];
  /** ffmpeg yt-dlp merges video and sound with. */
  ffmpeg?: string;
}

/**
 * Why yt-dlp could not read or download a video, as a code people and the agent can act on. `youtube_blocked` is
 * YouTube refusing the machine itself (the bot check, "sign in", HTTP 429): every other video fails the same way, so
 * callers stop at the first one. ADR-0001 item 175 holds: no cookies, no login, no working around it.
 */
export type YtFailureCode =
  | "youtube_blocked" | "private" | "unavailable" | "age_restricted" | "members_only" | "live" | "too_long" | "too_big" | "no_480p"
  | "network" | "timeout" | "other";

/** What each code says, in the words the chat and the README show. */
export const YT_FAILURE_REASON: Record<Exclude<YtFailureCode, "other">, string> = {
  youtube_blocked: "YouTube đang chặn tải từ máy chủ Studio (đòi đăng nhập để xác nhận không phải bot)",
  private: "video riêng tư",
  unavailable: "không còn trên YouTube (đã xoá, bị gỡ hoặc không tồn tại)",
  age_restricted: "video giới hạn tuổi (phải đăng nhập mới xem được)",
  members_only: "video chỉ dành cho hội viên của kênh",
  live: "video đang phát trực tiếp hoặc chưa công chiếu",
  too_long: "video dài quá 30 phút (hoặc đang phát trực tiếp)",
  too_big: "video lớn quá 300 MB ở ≤480p",
  no_480p: "video không có bản ≤480p",
  network: "lỗi mạng khi nối YouTube",
  timeout: "yt-dlp hết giờ",
};

export interface YtFailure {
  code: YtFailureCode;
  /** The short reason people read. */
  reason: string;
  /** The start of yt-dlp's own words (its ERROR line, prefixes dropped). */
  detail: string;
}

/** A yt-dlp failure with its code; `message` is the short reason (after what was being done, when given). */
export class YtDlpError extends Error {
  readonly code: YtFailureCode;
  readonly reason: string;
  readonly detail: string;
  constructor(f: YtFailure, doing?: string) {
    super(doing ? `${doing}: ${f.reason}` : f.reason);
    this.name = "YtDlpError";
    this.code = f.code;
    this.reason = f.reason;
    this.detail = f.detail;
  }
}

const DETAIL_MAX = 200;

/** The start of an ERROR line without its prefixes ("ERROR: [youtube] <id>: "), trimmed to a readable length. */
function errorStart(line: string): string {
  const s = line.replace(/^ERROR:\s*/, "").replace(/^\[[\w:-]+\]\s*/, "").replace(/^[\w-]{11}:\s*/, "").replace(/\s+/g, " ").trim();
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s;
}

/** One line of yt-dlp output, by what it says (most specific first: an age check also asks for cookies). */
function codeOf(line: string): YtFailureCode | null {
  const l = line.toLowerCase().replace(/’/g, "'");
  if (/confirm your age|age[- ]restricted|inappropriate for some users/.test(l)) return "age_restricted";
  if (/members[- ]only|join this channel|available to this channel's members/.test(l)) return "members_only";
  if (/private video|video is private/.test(l)) return "private";
  if (/does not pass filter/.test(l)) return "too_long";
  if (/live event will begin|premieres in|this live event|is live now|currently live/.test(l)) return "live";
  if (/not a bot|sign in to confirm|--cookies|http error 429|too many requests|rate[- ]limit/.test(l)) return "youtube_blocked";
  if (/larger than max-filesize/.test(l)) return "too_big";
  if (/requested format is not available|no video formats found/.test(l)) return "no_480p";
  if (/video unavailable|has been removed|no longer available|been terminated|does not exist|is not available|http error 404/.test(l)) return "unavailable";
  if (/unable to download|getaddrinfo|name resolution|connection (refused|reset|aborted)|network is unreachable|timed out|urlopen error|econnreset/.test(l)) return "network";
  return null;
}

/**
 * yt-dlp's words (stderr, and stdout for the skips it prints there) -> a code and a short reason. A bot check on any
 * line wins (the machine is refused, not the video); otherwise the first ERROR line says why, its start kept.
 */
export function classifyYtDlp(output: string): YtFailure {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const blocked = lines.find((l) => codeOf(l) === "youtube_blocked");
  const line = blocked ?? lines.find((l) => l.startsWith("ERROR")) ?? lines.find((l) => codeOf(l) !== null) ?? lines.at(-1) ?? "";
  const code = codeOf(line) ?? "other";
  const detail = errorStart(line);
  return { code, reason: code === "other" ? (detail ? `yt-dlp: ${detail}` : "yt-dlp lỗi, không rõ lý do") : YT_FAILURE_REASON[code], detail };
}

/** What a failure was, when it is a yt-dlp one (else null). */
export const ytFailureOf = (e: unknown): YtFailure | null => (e instanceof YtDlpError ? { code: e.code, reason: e.reason, detail: e.detail } : null);

const timedOut = (what: string) => new YtDlpError({ code: "timeout", reason: `${YT_FAILURE_REASON.timeout} ${what}`, detail: "" });

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
      if (r.timedOut) throw timedOut("khi đọc thông tin video");
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = line.trim() ? ytVideoMeta(line) : null;
        if (m) out.set(m.video_id, m);
      }
      if (!out.size && r.code !== 0) throw new YtDlpError(classifyYtDlp(r.stderr), "yt-dlp không đọc được video nào");
      return out;
    },

    async listChannel(ref, limit, signal) {
      const page = youtubeChannelUrl(ref);
      if (!page) throw new Error("không phải link kênh YouTube");
      const r = await run([...COMMON, "--flat-playlist", "-J", "--playlist-end", String(limit), "--", `${page}/videos`], META_TIMEOUT_MS, signal);
      if (r.timedOut) throw timedOut("khi đọc danh sách video của kênh");
      if (r.code !== 0) throw new YtDlpError(classifyYtDlp(r.stderr), "yt-dlp không đọc được kênh");
      const j = JSON.parse(r.stdout) as { channel_id?: string; channel?: string; uploader?: string; title?: string; entries?: { id?: string }[] };
      return {
        channel_id: typeof j.channel_id === "string" ? j.channel_id : null,
        title: j.channel ?? j.uploader ?? j.title ?? null,
        video_ids: (j.entries ?? []).map((e) => e.id ?? "").filter((id) => VIDEO_ID.test(id)).slice(0, limit),
      };
    },

    async search(query, limit, order, signal) {
      const q = query.replace(/\s+/g, " ").trim();
      if (!q) return [];
      const n = Math.max(1, Math.min(200, Math.round(limit)));
      const r = await run([...COMMON, "--flat-playlist", "-J", "--", `${order === "date" ? "ytsearchdate" : "ytsearch"}${n}:${q}`], META_TIMEOUT_MS, signal);
      if (r.timedOut) throw timedOut("khi tìm video");
      if (r.code !== 0) throw new YtDlpError(classifyYtDlp(r.stderr), "yt-dlp không tìm được");
      const j = JSON.parse(r.stdout) as { entries?: { id?: string }[] };
      return [...new Set((j.entries ?? []).map((e) => e.id ?? "").filter((id) => VIDEO_ID.test(id)))].slice(0, n);
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
      if (r.timedOut) throw timedOut("khi tải video");
      if (r.code !== 0) throw new YtDlpError(classifyYtDlp(r.stderr.trim() ? r.stderr : `yt-dlp exit ${String(r.code)}`));
      const file = readdirSync(dir).find((f) => f.startsWith(`${videoId}.`) && !f.endsWith(".part") && !f.endsWith(".json"));
      if (!file) {
        // a skip is not an error to yt-dlp: the duration filter and the size limit are said on stdout, exit 0
        const said = classifyYtDlp(`${r.stdout}\n${r.stderr}`);
        throw new YtDlpError(said.code === "other" ? { code: "no_480p", reason: YT_FAILURE_REASON.no_480p, detail: said.detail } : said);
      }
      return join(dir, file);
    },
  };
}
