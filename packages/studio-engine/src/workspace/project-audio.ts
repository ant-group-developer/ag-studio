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
import { AudioImportError, MUSIC_DEFAULTS, prepareMusic, prepareVoice, sha256Of, type AudioImportDeps, type AudioKind } from "../audio-import.js";
import { listLibraryMusic } from "../music-library.js";
import type { StudioDb } from "../studio-db.js";
import { productionVoice, type NarrationVoice } from "../voice.js";
import { requireProject } from "./project-db.js";
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
export function projectAudioFiles(db: StudioDb, dir: string, projectId: string): ProjectAudioFile[] {
  const out = new Map<string, ProjectAudioFile>();
  for (const s of listSources(db, projectId)) {
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
export function projectLibraryTrack(db: StudioDb, projectId: string): MusicTrack | null {
  const m = projectAudio(db, projectId).music;
  if (!m || !m.track.startsWith("library:music/")) return null;
  return listLibraryMusic(db).find((t) => t.file === m.track) ?? null;
}

/**
 * Points the project at a track of the music library (no file is copied: the track stays where the library keeps it,
 * and the cleanup sweep never removes library tracks). A retired track cannot be picked.
 */
export function setProjectLibraryMusic(db: StudioDb, projectId: string, track: MusicTrack, o: { gainDb?: number; ducking?: boolean } = {}): ProductionMusic {
  requireProject(db, projectId);
  if (!track.active) throw new AudioImportError("audio_invalid", "bài này đã bị gỡ khỏi kho nhạc");
  const sha = track.checksum.startsWith("sha256:") ? track.checksum.slice("sha256:".length) : track.checksum;
  const music = ProductionMusicSchema.parse({
    track: track.file, gain_db: o.gainDb ?? MUSIC_DEFAULTS.gain_db, ducking: o.ducking ?? MUSIC_DEFAULTS.ducking,
    ...(sha ? { sha256: sha } : {}), ...(track.duration_seconds > 0 ? { duration_s: track.duration_seconds } : {}),
  });
  db.run("UPDATE projects SET music = ?, updated_at = ? WHERE id = ?", [JSON.stringify(music), new Date().toISOString(), projectId]);
  return music;
}

export interface ProjectAudio { voice: ProductionVoice | null; music: ProductionMusic | null }

const parse = <T>(raw: string | null, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | null => {
  if (!raw) return null;
  try { const r = schema.safeParse(JSON.parse(raw)); return r.success ? r.data : null; } catch { return null; }
};

export function projectAudio(db: StudioDb, projectId: string): ProjectAudio {
  const row = db.get<{ voice: string | null; music: string | null }>("SELECT voice, music FROM projects WHERE id = ?", [projectId]);
  if (!row) return { voice: null, music: null };
  return { voice: parse(row.voice, ProductionVoiceSchema), music: parse(row.music, ProductionMusicSchema) };
}

/** The voice narration is read in: a clone, declined (`none`), or missing (nothing chosen and no default voice). */
export function projectNarrationVoice(db: StudioDb, projectId: string): NarrationVoice {
  const row = db.get<{ voice: string | null }>("SELECT voice FROM projects WHERE id = ?", [projectId]);
  return productionVoice(row?.voice ?? null);
}

/** The project's own music as the timeline takes it, or null. */
export function projectMusic(db: StudioDb, projectId: string): StudioMusic | null {
  const m = projectAudio(db, projectId).music;
  return m ? studioMusicOf(m) : null;
}

/** Normalises `file` and points the project at it (as its voice sample or its music). */
export async function importProjectAudio(d: AudioImportDeps, o: {
  projectId: string; kind: AudioKind; file: string; source: AudioSource; userId: string;
  origin?: VoiceOrigin; referenceText?: string | null; gainDb?: number; ducking?: boolean;
}): Promise<ProductionVoice | ProductionMusic> {
  requireProject(d.db, o.projectId);
  const work = mkdtempSync(join(tmpdir(), "studio-project-audio-"));
  try {
    const now = new Date().toISOString();
    if (o.kind === "voice") {
      if (!o.origin) throw new AudioImportError("audio_invalid", "chọn nguồn gốc của giọng");
      const out = join(work, "voice.wav");
      const { duration_s } = await prepareVoice(d, o.file, out);
      const sha = await sha256Of(out);
      const key = `library/studio/projects/${o.projectId}/voice/${sha}.wav`;
      await d.bucket.putFile(key, out, "audio/wav");
      const voice = ProductionVoiceSchema.parse({
        mode: "clone", reference: `library:${key.slice("library/".length)}`, reference_text: o.referenceText?.trim() || null, speed: 1,
        origin: o.origin, source: o.source, sha256: sha, duration_s, confirmed_by: o.userId, confirmed_at: now,
      });
      d.db.run("UPDATE projects SET voice = ?, updated_at = ? WHERE id = ?", [JSON.stringify(voice), now, o.projectId]);
      return voice;
    }
    const out = join(work, "music.m4a");
    const { duration_s } = await prepareMusic(d, o.file, out);
    const sha = await sha256Of(out);
    const key = `library/studio/projects/${o.projectId}/music/${sha}.m4a`;
    await d.bucket.putFile(key, out, "audio/mp4");
    const music = ProductionMusicSchema.parse({
      track: `library:${key.slice("library/".length)}`, gain_db: o.gainDb ?? MUSIC_DEFAULTS.gain_db, ducking: o.ducking ?? MUSIC_DEFAULTS.ducking,
      source: o.source, sha256: sha, duration_s,
    });
    d.db.run("UPDATE projects SET music = ?, updated_at = ? WHERE id = ?", [JSON.stringify(music), now, o.projectId]);
    return music;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** No narration for the project's videos: their lines become subtitles. */
export function declineProjectNarration(db: StudioDb, projectId: string, userId: string): ProductionVoice {
  const now = new Date().toISOString();
  const voice = ProductionVoiceSchema.parse({ mode: "none", decided_by: userId, decided_at: now });
  db.run("UPDATE projects SET voice = ?, updated_at = ? WHERE id = ?", [JSON.stringify(voice), now, projectId]);
  return voice;
}

export function clearProjectAudio(db: StudioDb, projectId: string, kind: AudioKind): void {
  db.run(`UPDATE projects SET ${kind === "voice" ? "voice" : "music"} = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), projectId]);
}

/** What the agent and the web are told of the project's audio (no bucket keys). */
export function projectAudioSummary(db: StudioDb, projectId: string): { voice: string; music: string } {
  const a = projectAudio(db, projectId);
  const v = a.voice;
  const mode = v && "mode" in v ? v.mode : v ? "clone" : null;
  const clone = v && "mode" in v && v.mode === "clone" ? v : null;
  const voice = !mode ? "chưa chọn (lời dẫn dùng giọng mặc định của Studio nếu có, không thì chỉ là phụ đề)"
    : mode === "none" ? "không lời dẫn (lời thành phụ đề)"
      : mode === "clone" ? `giọng mẫu${clone?.duration_s ? ` ${Math.round(clone.duration_s)} s` : ""}${clone ? ` (${clone.origin === "synthetic" ? "giọng máy" : clone.origin === "own" ? "giọng của người dùng" : "có bản quyền"})` : ""}`
        : "đang tạo giọng";
  const m = a.music;
  const lib = m ? projectLibraryTrack(db, projectId) : null;
  const music = lib ? `bài "${lib.display_name}" trong kho nhạc${lib.duration_seconds ? ` (${Math.round(lib.duration_seconds)} s)` : ""}, ${m!.gain_db} dB${m!.ducking ? ", nhỏ lại khi có lời" : ""}`
    : m ? `nhạc riêng của dự án${m.duration_s ? ` (${Math.round(m.duration_s)} s)` : ""}, ${m.gain_db} dB${m.ducking ? ", nhỏ lại khi có lời" : ""}`
    : "chưa chọn (Studio chọn nhạc trong thư viện theo tâm trạng trong kế hoạch dựng hoặc branding)";
  return { voice, music };
}
