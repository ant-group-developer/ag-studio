/**
 * A project's narration voice and background music (spec 2026-10-10 agent-workspace §P6): a person picks an audio file
 * uploaded to the Inputs tab as the voice sample (saying where the voice comes from: synthetic, their own, licensed)
 * or as the music; Studio normalises it and keeps it in the bucket by content (`library:studio/projects/<id>/…`),
 * where the farm reads it. The same JSON as a production's (`ProductionVoiceSchema`, `ProductionMusicSchema`).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProductionMusicSchema, ProductionVoiceSchema, studioMusicOf, type AudioSource, type MusicTrack, type ProductionMusic, type ProductionVoice,
  type StudioMusic, type VoiceOrigin,
} from "@harness/contracts";
import { AudioImportError, MUSIC_DEFAULTS, prepareMusic, prepareMusicMix, prepareVoice, sha256Of, type AudioImportDeps, type AudioKind } from "../audio-import.js";
import { listLibraryMusic } from "../music-library.js";
import type { StudioDb } from "../studio-db.js";
import { productionVoice, type NarrationVoice } from "../voice.js";
import { requireProject, requireVideo } from "./project-db.js";
import { listSources } from "./sources-db.js";

/** Audio files a person uploads (Inputs tab or Files tab), by extension. */
export const AUDIO_FILE_EXTS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"] as const;
/** Where uploaded audio goes. */
export const PROJECT_AUDIO_DIR = "context/audio";

/** An audio file of the workspace a person may use as the voice sample or the music. */
export interface ProjectAudioFile {
  path: string;
  name: string;
  bytes: number;
  /** The Inputs tab's row for it; null for a file put in `context/audio/` through the Files tab. */
  sourceId: string | null;
  addedAt: string;
}

const isAudioName = (name: string) => (AUDIO_FILE_EXTS as readonly string[]).some((ext) => name.toLowerCase().endsWith(ext));

/**
 * Audio files usable as the voice sample or the music: uploaded audio listed in the Inputs tab whose file is still
 * there, and any audio file under `context/audio/` (also those put there through the Files tab, which have no row).
 * Newest first. Only names and sizes: nothing is probed.
 */
export async function projectAudioFiles(db: StudioDb, dir: string, projectId: string): Promise<ProjectAudioFile[]> {
  const out = new Map<string, ProjectAudioFile>();
  for (const s of await listSources(db, projectId)) {
    if (s.kind !== "upload" || s.media_type !== "audio" || out.has(s.ref)) continue;
    const abs = join(dir, ...s.ref.split("/"));
    if (!existsSync(abs)) continue;
    out.set(s.ref, { path: s.ref, name: s.label, bytes: statSync(abs).size, sourceId: s.id, addedAt: s.added_at });
  }
  const walk = (rel: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(join(dir, ...rel.split("/"))); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const childRel = `${rel}/${name}`;
      let st;
      try { st = statSync(join(dir, ...childRel.split("/"))); } catch { continue; }
      if (st.isDirectory()) { if (depth < 3) walk(childRel, depth + 1); continue; }
      if (!st.isFile() || !isAudioName(name) || out.has(childRel)) continue;
      out.set(childRel, { path: childRel, name, bytes: st.size, sourceId: null, addedAt: st.mtime.toISOString() });
    }
  };
  walk(PROJECT_AUDIO_DIR, 0);
  return [...out.values()].sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.path.localeCompare(b.path));
}

/** The library track the project's music is, if it is one (`library:music/…`). */
export async function projectLibraryTrack(db: StudioDb, projectId: string): Promise<MusicTrack | null> {
  return libraryTrackOf(db, (await projectAudio(db, projectId)).music);
}

/**
 * Points the project at a track of the music library (no file is copied: the track stays where the library keeps it,
 * and the cleanup sweep never removes library tracks). A retired track cannot be picked.
 */
export async function setProjectLibraryMusic(db: StudioDb, projectId: string, track: MusicTrack, o: { gainDb?: number; ducking?: boolean } = {}): Promise<ProductionMusic> {
  await requireProject(db, projectId);
  const music = libraryMusic(track, o);
  await db.run("UPDATE projects SET music = ?, updated_at = ? WHERE id = ?", [JSON.stringify(music), new Date().toISOString(), projectId]);
  return music;
}

/** A library track as music (a retired one cannot be picked). */
function libraryMusic(track: MusicTrack, o: { gainDb?: number; ducking?: boolean }): ProductionMusic {
  if (!track.active) throw new AudioImportError("audio_invalid", "bài này đã bị gỡ khỏi kho nhạc");
  const sha = track.checksum.startsWith("sha256:") ? track.checksum.slice("sha256:".length) : track.checksum;
  return ProductionMusicSchema.parse({
    track: track.file, gain_db: o.gainDb ?? MUSIC_DEFAULTS.gain_db, ducking: o.ducking ?? MUSIC_DEFAULTS.ducking,
    ...(sha ? { sha256: sha } : {}), ...(track.duration_seconds > 0 ? { duration_s: track.duration_seconds } : {}),
  });
}

const libraryTrackOf = async (db: StudioDb, m: ProductionMusic | null): Promise<MusicTrack | null> =>
  (m && m.track.startsWith("library:music/") ? (await listLibraryMusic(db)).find((t) => t.file === m.track) ?? null : null);

// ---------------------------------------------------------------------------
// A video's own music: overrides the project's (video → project → Studio's pick by mood when the timeline is built)
// ---------------------------------------------------------------------------

/** A video's own music, or null (it takes the project's). */
export async function videoOwnMusic(db: StudioDb, videoId: string): Promise<ProductionMusic | null> {
  return parse((await db.get<{ music: unknown }>("SELECT music FROM videos WHERE id = ?", [videoId]))?.music ?? null, ProductionMusicSchema);
}

/** The library track a video's own music is, if it is one. */
export async function videoLibraryTrack(db: StudioDb, videoId: string): Promise<MusicTrack | null> {
  return libraryTrackOf(db, await videoOwnMusic(db, videoId));
}

/** The music a video's timeline takes, and whose: its own, else the project's; null when Studio picks by mood. */
export async function musicForVideo(db: StudioDb, projectId: string, videoId: string): Promise<{ music: StudioMusic; from: "video" | "project" } | null> {
  const own = await videoOwnMusic(db, videoId);
  if (own) return { music: studioMusicOf(own), from: "video" };
  const project = await projectMusic(db, projectId);
  return project ? { music: project, from: "project" } : null;
}

async function setVideoMusic(db: StudioDb, videoId: string, music: ProductionMusic | null): Promise<void> {
  await db.run("UPDATE videos SET music = ?, updated_at = ? WHERE id = ?", [music ? JSON.stringify(music) : null, new Date().toISOString(), videoId]);
}

/** One file or several joined (`importMusic`) become a video's own music. */
export async function importVideoMusic(d: AudioImportDeps, o: MusicFiles & { videoId: string }): Promise<ProductionMusic> {
  const v = await requireVideo(d.db, o.videoId);
  const music = await importMusic(d, v.project_id, o);
  await setVideoMusic(d.db, v.id, music);
  return music;
}

/** A library track becomes a video's own music. */
export async function setVideoLibraryMusic(db: StudioDb, videoId: string, track: MusicTrack, o: { gainDb?: number; ducking?: boolean } = {}): Promise<ProductionMusic> {
  await requireVideo(db, videoId);
  const music = libraryMusic(track, o);
  await setVideoMusic(db, videoId, music);
  return music;
}

/** The video takes the project's music again. */
export async function clearVideoMusic(db: StudioDb, videoId: string): Promise<void> {
  await requireVideo(db, videoId);
  await setVideoMusic(db, videoId, null);
}

/** What the agent and the web are told of a video's music. */
export async function videoMusicSummary(db: StudioDb, projectId: string, videoId: string): Promise<string> {
  const own = await videoOwnMusic(db, videoId);
  if (!own) return `nhạc của dự án: ${(await projectAudioSummary(db, projectId)).music}`;
  const lib = await libraryTrackOf(db, own);
  return lib ? `nhạc riêng của video: bài "${lib.display_name}" trong kho nhạc, ${own.gain_db} dB${own.ducking ? ", nhỏ lại khi có lời" : ""}`
    : ownMusicWords(own, "của video");
}

export interface ProjectAudio { voice: ProductionVoice | null; music: ProductionMusic | null }

const parse = <T>(raw: unknown, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | null => {
  if (!raw) return null;
  const r = schema.safeParse(raw);
  return r.success ? r.data : null;
};

export async function projectAudio(db: StudioDb, projectId: string): Promise<ProjectAudio> {
  const row = await db.get<{ voice: unknown; music: unknown }>("SELECT voice, music FROM projects WHERE id = ?", [projectId]);
  if (!row) return { voice: null, music: null };
  return { voice: parse(row.voice, ProductionVoiceSchema), music: parse(row.music, ProductionMusicSchema) };
}

/** The voice narration is read in: a clone, declined (`none`), or missing (nothing chosen and no default voice). */
export async function projectNarrationVoice(db: StudioDb, projectId: string): Promise<NarrationVoice> {
  const row = await db.get<{ voice: unknown }>("SELECT voice FROM projects WHERE id = ?", [projectId]);
  return productionVoice(row?.voice ? JSON.stringify(row.voice) : null);
}

/** The project's own music as the timeline takes it, or null. */
export async function projectMusic(db: StudioDb, projectId: string): Promise<StudioMusic | null> {
  const m = (await projectAudio(db, projectId)).music;
  return m ? studioMusicOf(m) : null;
}

/** Normalises `file` and points the project at it (as its voice sample or its music). */
export async function importProjectAudio(d: AudioImportDeps, o: {
  projectId: string; kind: AudioKind; file: string; source: AudioSource; userId: string;
  origin?: VoiceOrigin; referenceText?: string | null; gainDb?: number; ducking?: boolean;
}): Promise<ProductionVoice | ProductionMusic> {
  await requireProject(d.db, o.projectId);
  if (o.kind === "music") {
    return importProjectMusic(d, {
      projectId: o.projectId, files: [{ path: o.file, filename: o.source.kind === "upload" ? o.source.filename : "music" }], source: o.source,
      ...(o.gainDb !== undefined ? { gainDb: o.gainDb } : {}), ...(o.ducking !== undefined ? { ducking: o.ducking } : {}),
    });
  }
  if (!o.origin) throw new AudioImportError("audio_invalid", "chọn nguồn gốc của giọng");
  const work = mkdtempSync(join(tmpdir(), "studio-project-audio-"));
  try {
    const now = new Date().toISOString();
    const out = join(work, "voice.wav");
    const { duration_s } = await prepareVoice(d, o.file, out);
    const sha = await sha256Of(out);
    const key = `library/studio/projects/${o.projectId}/voice/${sha}.wav`;
    await d.bucket.putFile(key, out, "audio/wav");
    const voice = ProductionVoiceSchema.parse({
      mode: "clone", reference: `library:${key.slice("library/".length)}`, reference_text: o.referenceText?.trim() || null, speed: 1,
      origin: o.origin, source: o.source, sha256: sha, duration_s, confirmed_by: o.userId, confirmed_at: now,
    });
    await d.db.run("UPDATE projects SET voice = ?, updated_at = ? WHERE id = ?", [JSON.stringify(voice), now, o.projectId]);
    return voice;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Files to make one background track of, in order. */
export interface MusicFiles {
  files: { path: string; filename: string }[];
  /** Seconds each file fades into the next when there are several (default 0: one right after the other). */
  crossfadeS?: number;
  gainDb?: number;
  ducking?: boolean;
  /** Where a single file came from (default: an upload under its name). */
  source?: AudioSource;
}

/**
 * Background music made of one file or several joined in order (`prepareMusicMix`), kept in the bucket by content
 * under the project (`library:studio/projects/<id>/music/<sha>.m4a`, which the cleanup sweep keeps while anything
 * points at it). Nothing is set: the caller says whose music it is.
 */
export async function importMusic(d: AudioImportDeps, projectId: string, o: MusicFiles): Promise<ProductionMusic> {
  if (!o.files.length) throw new AudioImportError("audio_invalid", "chọn ít nhất một file nhạc");
  const work = mkdtempSync(join(tmpdir(), "studio-project-music-"));
  try {
    const out = join(work, "music.m4a");
    const several = o.files.length > 1;
    const crossfade = o.crossfadeS ?? 0;
    const made: { duration_s: number; parts?: number[] } = several
      ? await prepareMusicMix(d, o.files, out, { crossfadeS: crossfade })
      : await prepareMusic(d, o.files[0]!.path, out);
    const sha = await sha256Of(out);
    const key = `library/studio/projects/${projectId}/music/${sha}.m4a`;
    await d.bucket.putFile(key, out, "audio/mp4");
    return ProductionMusicSchema.parse({
      track: `library:${key.slice("library/".length)}`, gain_db: o.gainDb ?? MUSIC_DEFAULTS.gain_db, ducking: o.ducking ?? MUSIC_DEFAULTS.ducking,
      sha256: sha, duration_s: made.duration_s,
      ...(made.parts
        ? { parts: o.files.map((f, i) => ({ filename: f.filename.slice(0, 255), duration_s: made.parts![i]! })), crossfade_s: crossfade }
        : { source: o.source ?? { kind: "upload", filename: o.files[0]!.filename.slice(0, 255) } }),
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** One file or several joined (`importMusic`) become the project's music. */
export async function importProjectMusic(d: AudioImportDeps, o: MusicFiles & { projectId: string }): Promise<ProductionMusic> {
  await requireProject(d.db, o.projectId);
  const music = await importMusic(d, o.projectId, o);
  await d.db.run("UPDATE projects SET music = ?, updated_at = ? WHERE id = ?", [JSON.stringify(music), new Date().toISOString(), o.projectId]);
  return music;
}

/** No narration for the project's videos: their lines become subtitles. */
export async function declineProjectNarration(db: StudioDb, projectId: string, userId: string): Promise<ProductionVoice> {
  const now = new Date().toISOString();
  const voice = ProductionVoiceSchema.parse({ mode: "none", decided_by: userId, decided_at: now });
  await db.run("UPDATE projects SET voice = ?, updated_at = ? WHERE id = ?", [JSON.stringify(voice), now, projectId]);
  return voice;
}

export async function clearProjectAudio(db: StudioDb, projectId: string, kind: AudioKind): Promise<void> {
  await db.run(`UPDATE projects SET ${kind === "voice" ? "voice" : "music"} = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), projectId]);
}

/** Own music in words: "nhạc riêng của dự án (3 bài ghép, chuyển mờ 2 s; 412 s), -18 dB, nhỏ lại khi có lời". */
export function ownMusicWords(m: ProductionMusic, whose: string): string {
  const made = m.parts ? `${m.parts.length} bài ghép, ${m.crossfade_s ? `chuyển mờ ${m.crossfade_s} s` : "nối thẳng"}` : null;
  const length = m.duration_s ? `${Math.round(m.duration_s)} s` : null;
  const detail = [made, length].filter(Boolean).join("; ");
  return `nhạc riêng ${whose}${detail ? ` (${detail})` : ""}, ${m.gain_db} dB${m.ducking ? ", nhỏ lại khi có lời" : ""}`;
}

/** What the agent and the web are told of the project's audio (no bucket keys). */
export async function projectAudioSummary(db: StudioDb, projectId: string): Promise<{ voice: string; music: string }> {
  const a = await projectAudio(db, projectId);
  const v = a.voice;
  const mode = v && "mode" in v ? v.mode : v ? "clone" : null;
  const clone = v && "mode" in v && v.mode === "clone" ? v : null;
  const voice = !mode ? "chưa chọn (lời dẫn dùng giọng mặc định của Studio nếu có, không thì chỉ là phụ đề)"
    : mode === "none" ? "không lời dẫn (lời thành phụ đề)"
      : mode === "clone" ? `giọng mẫu${clone?.duration_s ? ` ${Math.round(clone.duration_s)} s` : ""}${clone ? ` (${clone.origin === "synthetic" ? "giọng máy" : clone.origin === "own" ? "giọng của người dùng" : "có bản quyền"})` : ""}`
        : "đang tạo giọng";
  const m = a.music;
  const lib = m ? await libraryTrackOf(db, m) : null;
  const music = lib ? `bài "${lib.display_name}" trong kho nhạc${lib.duration_seconds ? ` (${Math.round(lib.duration_seconds)} s)` : ""}, ${m!.gain_db} dB${m!.ducking ? ", nhỏ lại khi có lời" : ""}`
    : m ? ownMusicWords(m, "của dự án")
    : "chưa chọn (Studio chọn nhạc trong thư viện theo tâm trạng trong kế hoạch dựng hoặc branding)";
  return { voice, music };
}
