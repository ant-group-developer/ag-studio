/**
 * The voice store of the shot-cut episodes (migration 0024, ADR-0001 item 156): every narration line is read once, keyed
 * by what is read and how (text, language, reference voice, speed, engine). A changed sentence is read again alone;
 * the same sentence in another episode or a re-run is not read at all (like harness `ttsCacheKey`, ADR item 108).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StudioTtsPayload } from "@ag-farm/protocol";
import type { StudioDb } from "./studio-db.js";

/** What reads a line: the farm's `studio.tts` (OmniVoice), word timings aligned with WhisperX. */
export const VOICE_ENGINE = "farm:studio.tts@omnivoice+align";

export interface VoiceLine { key: string; duration_s: number; words: { word: string; start: number; end: number }[]; language: string; path: string }

export function voiceKey(p: { text: string; language: string; voice: StudioTtsPayload["voice"] }): string {
  const canonical = JSON.stringify({
    text: p.text, language: p.language, reference: p.voice.reference, reference_text: p.voice.reference_text, speed: p.voice.speed, engine: VOICE_ENGINE,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function voicePath(dir: string, key: string): string {
  return join(dir, `${key}.wav`);
}

/** A read line, or `null` when it was never read here (or its WAV is gone). Marks it used. */
export function getVoiceLine(db: StudioDb, dir: string, key: string, now?: string): VoiceLine | null {
  const row = db.get<{ duration_s: number; words: string; language: string }>("SELECT duration_s, words, language FROM studio_voice_lines WHERE key = ?", [key]);
  const path = voicePath(dir, key);
  if (!row || !existsSync(path)) return null;
  if (now) db.run("UPDATE studio_voice_lines SET last_used_at = ? WHERE key = ?", [now, key]);
  return { key, duration_s: row.duration_s, words: JSON.parse(row.words) as VoiceLine["words"], language: row.language, path };
}

/** Keeps a line the farm read: its WAV copied into the store, its length and word timings in the table. */
export function putVoiceLine(
  db: StudioDb, dir: string, key: string, wav: string, meta: { duration_s: number; words: VoiceLine["words"]; language: string }, now: string,
): void {
  mkdirSync(dir, { recursive: true });
  copyFileSync(wav, voicePath(dir, key));
  db.run(
    `INSERT INTO studio_voice_lines (key, duration_s, words, language, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET duration_s = excluded.duration_s, words = excluded.words, language = excluded.language, last_used_at = excluded.last_used_at`,
    [key, meta.duration_s, JSON.stringify(meta.words), meta.language, now, now],
  );
}
