/**
 * Audio a person gives a project: a voice sample to read the narration in, background music. It is checked and
 * normalised by ffmpeg (`prepareVoice`, `prepareMusic`) and kept in the Studio bucket by content: a `library:` input the
 * render worker already signs (`workspace/project-audio.ts`). A pasted link is fetched by `fetchAudioUrl`.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StudioBucket } from "./bucket.js";
import { probeMedia, runTool } from "./cut-ffmpeg.js";
import type { StudioDb } from "./studio-db.js";

export { VOICE_ORIGINS, type AudioSource, type VoiceOrigin } from "@harness/contracts";

export type AudioKind = "voice" | "music";

/** Music up to 300 MB: a 10-minute WAV track is ~110 MB (prod 23/10: three refused at the old 100 MB). */
export const AUDIO_MAX_BYTES: Record<AudioKind, number> = { voice: 20 * 1024 * 1024, music: 300 * 1024 * 1024 };
/** OmniVoice clones from a few seconds; a longer sample only slows every line down. */
export const VOICE_MIN_SECONDS = 3;
export const VOICE_MAX_SECONDS = 20;
export const MUSIC_MIN_SECONDS = 5;
export const MUSIC_DEFAULTS = { gain_db: -18, ducking: true } as const;

const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;
const TRANSCODE_TIMEOUT_MS = 5 * 60_000;

export type AudioImportCode = "url_not_allowed" | "url_fetch_failed" | "audio_too_large" | "audio_invalid";

export class AudioImportError extends Error {
  constructor(readonly code: AudioImportCode, message: string) {
    super(message);
    this.name = "AudioImportError";
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** The URL to fetch for a link the person pasted: http(s) only; a Google Drive share link becomes its download link. */
export function downloadUrlFor(link: string): string {
  let u: URL;
  try { u = new URL(link.trim()); } catch { throw new AudioImportError("url_not_allowed", "link không hợp lệ"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new AudioImportError("url_not_allowed", "chỉ nhận link http(s)");
  if (u.hostname === "drive.google.com") {
    const id = u.pathname.match(/^\/file\/d\/([^/]+)/)?.[1] ?? u.searchParams.get("id");
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  return u.toString();
}

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Loopback, private, link-local, CGNAT, unique-local, multicast: an address a fetched link must not reach. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return ipv4Private(ip);
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return ipv4Private(mapped);
  return /^(fc|fd|fe[89ab]|ff)/.test(v);
}

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

async function assertPublic(url: URL, lookup: Lookup): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host)).map((a) => a.address);
  } catch {
    throw new AudioImportError("url_fetch_failed", `không tìm thấy máy chủ ${host}`);
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new AudioImportError("url_not_allowed", "link trỏ vào mạng nội bộ");
}

/**
 * Fetches a pasted link to `dest`: every hop (redirects followed by hand, at most three) must resolve to public
 * addresses unless `allowPrivate` (the local stack); stops past `maxBytes`. A failure removes the partial file.
 */
export async function fetchAudioUrl(link: string, dest: string, o: {
  maxBytes: number; allowPrivate?: boolean; signal?: AbortSignal; lookup?: Lookup; fetchImpl?: typeof fetch;
}): Promise<void> {
  const lookup = o.lookup ?? ((h: string) => dnsLookup(h, { all: true }));
  const fetchImpl = o.fetchImpl ?? fetch;
  const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let url = new URL(downloadUrlFor(link));
  let res: Response | undefined;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new AudioImportError("url_not_allowed", "chỉ nhận link http(s)");
    if (!o.allowPrivate) await assertPublic(url, lookup);
    try {
      res = await fetchImpl(url, { redirect: "manual", signal });
    } catch (e) {
      throw new AudioImportError("url_fetch_failed", `không tải được link: ${(e as Error).message}`);
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    if (hop >= MAX_REDIRECTS) throw new AudioImportError("url_fetch_failed", "link chuyển hướng quá nhiều lần");
    url = new URL(location, url);
  }
  if (!res.ok || !res.body) throw new AudioImportError("url_fetch_failed", `không tải được link: HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > o.maxBytes) throw new AudioImportError("audio_too_large", `file lớn hơn ${mb(o.maxBytes)}`);
  let seen = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      cb(seen > o.maxBytes ? new AudioImportError("audio_too_large", `file lớn hơn ${mb(o.maxBytes)}`) : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), cap, createWriteStream(dest));
  } catch (e) {
    rmSync(dest, { force: true });
    if (e instanceof AudioImportError) throw e;
    throw new AudioImportError("url_fetch_failed", `tải link bị ngắt: ${(e as Error).message}`);
  }
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** ffmpeg and ffprobe (not always side by side: `STUDIO_FFMPEG_PATH`, `STUDIO_FFPROBE_PATH`). */
export interface AudioTools { ffmpeg: string; ffprobe: string }

async function probeAudio(ffprobe: string, src: string, minSeconds: number): Promise<number> {
  const facts = await probeMedia(ffprobe, src);
  if (!facts || !facts.has_audio) throw new AudioImportError("audio_invalid", "file không có tiếng hoặc không đọc được");
  if (!facts.duration_s || facts.duration_s < minSeconds) throw new AudioImportError("audio_invalid", `file ngắn hơn ${minSeconds} giây`);
  return facts.duration_s;
}

async function transcode(ffmpeg: string, args: string[], what: string, timeoutMs = TRANSCODE_TIMEOUT_MS): Promise<void> {
  const r = await runTool(ffmpeg, ["-y", "-hide_banner", "-nostats", ...args], { timeoutMs });
  if (r.timedOut || r.code !== 0) throw new AudioImportError("audio_invalid", `không chuyển được ${what}: ${r.stderr.slice(-200)}`);
}

/** A voice sample as OmniVoice takes it: mono 24 kHz 16-bit WAV, its first `VOICE_MAX_SECONDS`. */
export async function prepareVoice(t: AudioTools, src: string, dest: string): Promise<{ duration_s: number }> {
  const duration = await probeAudio(t.ffprobe, src, VOICE_MIN_SECONDS);
  await transcode(t.ffmpeg, ["-i", src, "-vn", "-map", "0:a:0", "-t", String(VOICE_MAX_SECONDS), "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", dest], "giọng mẫu");
  return { duration_s: Math.min(duration, VOICE_MAX_SECONDS) };
}

/** Background music as AAC (one format for every source; the render reads it as any other `library:` track). */
export async function prepareMusic(t: AudioTools, src: string, dest: string): Promise<{ duration_s: number }> {
  const duration = await probeAudio(t.ffprobe, src, MUSIC_MIN_SECONDS);
  await transcode(t.ffmpeg, ["-i", src, "-vn", "-map", "0:a:0", "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", dest], "nhạc nền");
  return { duration_s: duration };
}

/** At most this many files are joined into one track. */
export const MUSIC_MIX_MAX_PARTS = 20;
/** The longest fade from one joined file into the next. */
export const MUSIC_CROSSFADE_MAX_SECONDS = 10;
/** The longest track joined files make. */
export const MUSIC_MIX_MAX_SECONDS = 3 * 3600;

/**
 * Several files as one background track, in their order: each made 48 kHz stereo, then joined one right after the
 * other (`crossfadeS` 0) or each fading into the next over `crossfadeS` seconds. The fade must be shorter than half of
 * the shortest file. Answers the track's length and each file's.
 */
export async function prepareMusicMix(t: AudioTools, srcs: { path: string; filename: string }[], dest: string, o: { crossfadeS: number }): Promise<{ duration_s: number; parts: number[] }> {
  if (srcs.length < 2 || srcs.length > MUSIC_MIX_MAX_PARTS) throw new AudioImportError("audio_invalid", `ghép từ 2 đến ${MUSIC_MIX_MAX_PARTS} file`);
  const x = o.crossfadeS;
  if (!(x >= 0 && x <= MUSIC_CROSSFADE_MAX_SECONDS)) throw new AudioImportError("audio_invalid", `chuyển mờ từ 0 đến ${MUSIC_CROSSFADE_MAX_SECONDS} giây`);
  const parts: number[] = [];
  for (const s of srcs) {
    try {
      parts.push(await probeAudio(t.ffprobe, s.path, MUSIC_MIN_SECONDS));
    } catch (e) {
      if (e instanceof AudioImportError) throw new AudioImportError(e.code, `${s.filename}: ${e.message}`);
      throw e;
    }
  }
  const shortest = Math.min(...parts);
  if (x > 0 && x * 2 >= shortest) throw new AudioImportError("audio_invalid", `chuyển mờ phải ngắn hơn nửa bài ngắn nhất (${Math.round(shortest)} giây)`);
  const duration = parts.reduce((a, b) => a + b, 0) - (srcs.length - 1) * x;
  if (duration > MUSIC_MIX_MAX_SECONDS) throw new AudioImportError("audio_invalid", `ghép lại dài hơn ${MUSIC_MIX_MAX_SECONDS / 3600} giờ`);
  const each = srcs.map((_, i) => `[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  const link = x === 0
    ? [`${srcs.map((_, i) => `[a${i}]`).join("")}concat=n=${srcs.length}:v=0:a=1[out]`]
    : srcs.slice(1).map((_, k) => `${k === 0 ? "[a0]" : `[x${k}]`}[a${k + 1}]acrossfade=d=${x}:c1=tri:c2=tri${k === srcs.length - 2 ? "[out]" : `[x${k + 1}]`}`);
  await transcode(t.ffmpeg, [
    ...srcs.flatMap((s) => ["-i", s.path]), "-filter_complex", [...each, ...link].join(";"), "-map", "[out]", "-vn",
    "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", dest,
  ], "nhạc ghép", TRANSCODE_TIMEOUT_MS + srcs.length * 60_000);
  return { duration_s: duration, parts };
}

export async function sha256Of(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

export interface AudioImportDeps extends AudioTools { db: StudioDb; bucket: StudioBucket }
