/**
 * Audio a person gives a production: a voice sample to read the narration in, background music (ADR-0001 item 168).
 * It comes as a link (fetched here) or an uploaded file, is checked and normalised by ffmpeg, and kept in the Studio
 * bucket by content under `library/studio/<production>/<voice|music>/<sha256>.<ext>`: a `library:` input the render
 * worker already signs. Then the production row points at it, and episodes waiting for a voice run on.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ProductionMusicSchema, ProductionVoiceSchema, type AudioSource, type ProductionMusic, type ProductionVoice, type VoiceOrigin,
} from "@harness/contracts";
import { isTerminal } from "@harness/core";
import type { StudioBucket } from "./bucket.js";
import type { StudioEngineCore } from "./core.js";
import { probeMedia, runTool } from "./cut-ffmpeg.js";
import { retryStage, StudioRunError } from "./run-control.js";
import { getEpisode, listEpisodes, type ProductionRecord, type StudioDb } from "./studio-db.js";

export { VOICE_ORIGINS, type AudioSource, type VoiceOrigin } from "@harness/contracts";

export type AudioKind = "voice" | "music";

export const AUDIO_MAX_BYTES: Record<AudioKind, number> = { voice: 20 * 1024 * 1024, music: 100 * 1024 * 1024 };
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

async function transcode(ffmpeg: string, args: string[], what: string): Promise<void> {
  const r = await runTool(ffmpeg, ["-y", "-hide_banner", "-nostats", ...args], { timeoutMs: TRANSCODE_TIMEOUT_MS });
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

async function sha256Of(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

export interface AudioImportDeps extends AudioTools { db: StudioDb; bucket: StudioBucket }

/**
 * Checks and normalises `file`, keeps it in the bucket by content and points the production at it. A voice needs its
 * origin (ADR-0001 item 105: synthetic, the person's own, or licensed): a claim the person makes, not verified.
 */
export async function importProductionAudio(d: AudioImportDeps, o: {
  productionId: string; kind: AudioKind; file: string; source: AudioSource; userId: string;
  origin?: VoiceOrigin; referenceText?: string | null; gainDb?: number; ducking?: boolean;
}): Promise<ProductionVoice | ProductionMusic> {
  const work = mkdtempSync(join(tmpdir(), "studio-audio-"));
  try {
    const now = new Date().toISOString();
    if (o.kind === "voice") {
      if (!o.origin) throw new AudioImportError("audio_invalid", "chọn nguồn gốc của giọng");
      const out = join(work, "voice.wav");
      const { duration_s } = await prepareVoice(d, o.file, out);
      const sha = await sha256Of(out);
      const key = `library/studio/${o.productionId}/voice/${sha}.wav`;
      await d.bucket.putFile(key, out, "audio/wav");
      const voice = ProductionVoiceSchema.parse({
        mode: "clone", reference: `library:${key.slice("library/".length)}`, reference_text: o.referenceText?.trim() || null, speed: 1,
        origin: o.origin, source: o.source, sha256: sha, duration_s, confirmed_by: o.userId, confirmed_at: now,
      });
      d.db.run("UPDATE productions SET voice = ?, updated_at = ? WHERE id = ?", [JSON.stringify(voice), now, o.productionId]);
      return voice;
    }
    const out = join(work, "music.m4a");
    const { duration_s } = await prepareMusic(d, o.file, out);
    const sha = await sha256Of(out);
    const key = `library/studio/${o.productionId}/music/${sha}.m4a`;
    await d.bucket.putFile(key, out, "audio/mp4");
    const music = ProductionMusicSchema.parse({
      track: `library:${key.slice("library/".length)}`, gain_db: o.gainDb ?? MUSIC_DEFAULTS.gain_db, ducking: o.ducking ?? MUSIC_DEFAULTS.ducking,
      source: o.source, sha256: sha, duration_s,
    });
    d.db.run("UPDATE productions SET music = ?, updated_at = ? WHERE id = ?", [JSON.stringify(music), now, o.productionId]);
    return music;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The person declined narration for the whole production: narrated episodes are cut without lines. */
export function declineNarration(db: StudioDb, productionId: string, userId: string): ProductionVoice {
  const now = new Date().toISOString();
  const voice = ProductionVoiceSchema.parse({ mode: "none", decided_by: userId, decided_at: now });
  db.run("UPDATE productions SET voice = ?, updated_at = ? WHERE id = ?", [JSON.stringify(voice), now, productionId]);
  return voice;
}

/**
 * Narration declined (`none`) or wanted again (null) for one episode, whatever the production has; an episode waiting
 * for a voice runs on at once (its `tts` again). Returns whether it was resumed.
 */
export function setEpisodeNarration(core: StudioEngineCore, db: StudioDb, episodeId: string, o: { declined: boolean }): { resumed: boolean } {
  const ep = getEpisode(db, episodeId);
  if (!ep) throw new StudioRunError("not_found", `episode ${episodeId} not found`);
  if (ep.edit_style !== "cut") throw new StudioRunError("invalid", "chỉ tập cắt theo shot có lời dẫn", { code: "no_narration_here" });
  db.run("UPDATE episodes SET narration_override = ?, updated_at = ? WHERE id = ?", [o.declined ? "none" : null, new Date().toISOString(), episodeId]);
  return { resumed: o.declined && resumeEpisodeTts(core, ep.run_id) };
}

/** Back to "not asked": a voice the person removed. */
export function clearProductionAudio(db: StudioDb, productionId: string, kind: AudioKind): void {
  db.run(`UPDATE productions SET ${kind === "voice" ? "voice" : "music"} = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), productionId]);
}

/** Runs `tts` again in every episode of the production stopped there (waiting for a voice); returns those episodes. */
export function resumeVoiceWaiting(core: StudioEngineCore, db: StudioDb, productionId: string): string[] {
  return listEpisodes(db, productionId).filter((ep) => resumeEpisodeTts(core, ep.run_id)).map((ep) => ep.id);
}

/** `tts` again in a run stopped there; false when the run is not stopped at `tts`. */
function resumeEpisodeTts(core: StudioEngineCore, runId: string | null): boolean {
  if (!runId) return false;
  const run = core.store.getRun(runId);
  if (!run || isTerminal("run", run.state) || run.state === "CANCEL_REQUESTED") return false;
  const tts = core.store.listStageRuns(runId)
    .find((s) => s.executor.type === "farm" && s.executor.job === "studio.tts" && (s.state === "WAITING_HUMAN" || s.state === "FAILED"));
  if (!tts) return false;
  retryStage(core, runId, tts.stage_key);
  return true;
}

/** What a production has, for a screen: its voice (or narration declined) and its music, with the inputs to listen to. */
export interface ProductionAudioView {
  voice:
    | { mode: "none"; decided_at: string }
    | { mode: "clone"; origin: VoiceOrigin | null; source: AudioSource | null; duration_s: number | null; reference_text: string | null; reference: string }
    | null;
  music: { track: string; gain_db: number; ducking: boolean; source: AudioSource | null; duration_s: number | null } | null;
}

export function productionAudio(p: Pick<ProductionRecord, "voice" | "music">): ProductionAudioView {
  let voice: ProductionAudioView["voice"] = null;
  if (p.voice) {
    const v = ProductionVoiceSchema.parse(JSON.parse(p.voice));
    if ("mode" in v && v.mode === "none") voice = { mode: "none", decided_at: v.decided_at };
    else if ("mode" in v) voice = { mode: "clone", origin: v.origin, source: v.source, duration_s: v.duration_s, reference_text: v.reference_text, reference: v.reference };
    else if (v.reference) voice = { mode: "clone", origin: null, source: null, duration_s: null, reference_text: v.reference_text, reference: v.reference };
  }
  let music: ProductionAudioView["music"] = null;
  if (p.music) {
    const m = ProductionMusicSchema.parse(JSON.parse(p.music));
    music = { track: m.track, gain_db: m.gain_db, ducking: m.ducking, source: m.source ?? null, duration_s: m.duration_s ?? null };
  }
  return { voice, music };
}
