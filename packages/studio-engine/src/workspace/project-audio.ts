/**
 * A project's narration voice and background music (spec 2026-10-10 agent-workspace §P6): a person picks an audio file
 * uploaded to the Inputs tab as the voice sample (saying where the voice comes from: synthetic, their own, licensed)
 * or as the music; Studio normalises it and keeps it in the bucket by content (`library:studio/projects/<id>/…`),
 * where the farm reads it. The same JSON as a production's (`ProductionVoiceSchema`, `ProductionMusicSchema`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProductionMusicSchema, ProductionVoiceSchema, studioMusicOf, type AudioSource, type ProductionMusic, type ProductionVoice, type StudioMusic,
  type VoiceOrigin,
} from "@harness/contracts";
import { AudioImportError, MUSIC_DEFAULTS, prepareMusic, prepareVoice, sha256Of, type AudioImportDeps, type AudioKind } from "../audio-import.js";
import type { StudioDb } from "../studio-db.js";
import { productionVoice, type NarrationVoice } from "../voice.js";
import { requireProject } from "./project-db.js";

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
  const music = m ? `nhạc riêng của dự án${m.duration_s ? ` (${Math.round(m.duration_s)} s)` : ""}, ${m.gain_db} dB${m.ducking ? ", nhỏ lại khi có lời" : ""}`
    : "chưa chọn (Studio chọn nhạc trong thư viện theo tâm trạng trong kế hoạch dựng hoặc branding)";
  return { voice, music };
}
