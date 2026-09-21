import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessError, idSchema, newId, VoiceProfileSchema, type Clock, type StateStore, type VoiceParams, type VoiceProfile } from "@harness/contracts";
import type { LibraryFs } from "./files.js";

const VOICE_ID_SCHEMA = idSchema("voice_profile");

/** A caller-supplied `voice_id` (the `--voice-id` CLI flag, or a hand-built `p.voice_id`) must be rejected
 * *before* it ever reaches a kho path -- `LibraryFs.paths.voiceDir/voiceFile/voiceRef` now also refuse an
 * invalid id (defence in depth), but validating here first means `addVoice` never even spends the work of
 * converting/probing the reference clip for an id that was always going to be refused, and the error names
 * the bad id directly instead of surfacing however the eventual path-builder throw happens to read. Review
 * finding (Task 4 fix round 1): a bad id previously reached `copyFileWithChecksum` before any validation,
 * so e.g. `--voice-id ../requests` would resolve outside `voices/` entirely. */
function assertValidVoiceId(voiceId: string): void {
  if (!VOICE_ID_SCHEMA.safeParse(voiceId).success) {
    throw new HarnessError("CONFIG_INVALID", `invalid voice_id: ${voiceId}`, { voice_id: voiceId });
  }
}

/** Reads a voice profile straight from the kho (not the DB mirror), mirroring `readStyle`/`readRequest`/
 * `readItem`: an absent file just means "no such voice yet" here (used by `addVoice` to tell new-vs-bump
 * apart and by `retireVoice` to look one up); any other read/parse failure surfaces as its own error. */
function readVoiceOrUndefined(fs: LibraryFs, voiceId: string): VoiceProfile | undefined {
  const path = fs.paths.voiceFile(voiceId);
  if (!existsSync(path)) return undefined;
  return fs.readJson(path, VoiceProfileSchema);
}

/**
 * Adds a new channel-owned TTS voice profile, or bumps an existing one (same `voice_id` -> `revision + 1`,
 * `created_at` kept from the prior revision).
 *
 * Order matters: the reference clip is converted (mono, 24kHz, `pcm_s16le`) and duration-checked in an OS
 * temp dir *first* -- a clip outside [3, 30]s, or ffmpeg itself failing, throws before anything in the kho is
 * touched. Only once that succeeds is the converted clip copied in as `ref.wav` (`LibraryFs.copyFileWithChecksum`,
 * which is also what enforces the channel-only write rule on `voices/**` -- this function has no role check
 * of its own) and `voice.json` written atomically.
 */
export async function addVoice(
  d: { fs: LibraryFs; store: StateStore; clock: Clock; ffmpeg: string; probeDuration: (p: string) => number | null },
  p: {
    voice_id?: string;
    display_name: string;
    ref_path: string;
    ref_text: string;
    language: string;
    origin: "synthetic" | "own" | "licensed";
    origin_note?: string;
    params?: Partial<VoiceParams>;
  },
): Promise<VoiceProfile> {
  // Validated before the temp dir even exists: nothing (not ffmpeg, not the kho) is touched for a doomed id.
  if (p.voice_id !== undefined) assertValidVoiceId(p.voice_id);

  const tmpDir = mkdtempSync(join(tmpdir(), "harness-voice-"));
  try {
    const converted = join(tmpDir, "ref.wav");
    const r = spawnSync(d.ffmpeg, ["-y", "-i", p.ref_path, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", converted], { encoding: "utf8" });
    if (r.status !== 0) {
      const reason = (r.stderr || r.error?.message || "unknown error").toString().trim();
      throw new HarnessError("CONFIG_INVALID", `ffmpeg failed to convert reference clip ${p.ref_path}: ${reason}`, { ref_path: p.ref_path });
    }

    const duration = d.probeDuration(converted);
    if (duration === null) {
      throw new HarnessError("CONFIG_INVALID", `could not probe the duration of the converted reference clip (source: ${p.ref_path})`, { ref_path: p.ref_path });
    }
    if (duration < 3 || duration > 30) {
      throw new HarnessError("CONFIG_INVALID", `voice reference clip must be 3-30 seconds long, got ${duration}s`, { ref_path: p.ref_path, duration_seconds: duration });
    }

    const existing = p.voice_id ? readVoiceOrUndefined(d.fs, p.voice_id) : undefined;
    const voice_id = p.voice_id ?? newId("voice_profile");
    const now = d.clock.now();

    const ref = await d.fs.copyFileWithChecksum(converted, d.fs.paths.voiceRef(voice_id));

    const profile: VoiceProfile = VoiceProfileSchema.parse({
      schema_version: "harness.voice/v1",
      voice_id,
      display_name: p.display_name,
      language: p.language,
      origin: p.origin,
      origin_note: p.origin_note ?? "",
      ref_audio: { path: "ref.wav", checksum: ref.checksum, duration_seconds: duration },
      ref_text: p.ref_text,
      params: p.params ?? {},
      revision: existing ? existing.revision + 1 : 1,
      status: "active",
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });

    d.fs.writeJsonAtomic(d.fs.paths.voiceFile(voice_id), profile);
    d.store.upsertVoiceProfile(profile);
    return profile;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** active -> retired (studio may never call this: `writeJsonAtomic` refuses a studio role's write under
 * `voices/**` before anything is touched). Not found is NOT_FOUND; idempotent on an already-retired voice
 * (returned unchanged, no re-write), mirroring `activateStyle`'s idempotency on an already-active style. */
export function retireVoice(d: { fs: LibraryFs; store: StateStore; clock: Clock }, voiceId: string): VoiceProfile {
  assertValidVoiceId(voiceId);
  const profile = readVoiceOrUndefined(d.fs, voiceId);
  if (!profile) throw new HarnessError("NOT_FOUND", `voice profile not found: ${voiceId}`, { voice_id: voiceId });
  if (profile.status === "retired") return profile;
  const updated: VoiceProfile = { ...profile, status: "retired", updated_at: d.clock.now() };
  d.fs.writeJsonAtomic(d.fs.paths.voiceFile(voiceId), updated);
  d.store.upsertVoiceProfile(updated);
  return updated;
}

/**
 * A `voice: tts` request/brief must carry an active voice profile -- this is the one gate, called from both
 * `createRequest` (channel role) and `intake` (studio role). All three failure shapes are CONFIG_INVALID, each
 * naming exactly why (`runStage`/`library-stage.ts` maps that straight to a `contract` stage failure): no
 * `voice_id` at all, a `voice_id` this role's mirror has never seen, or one that exists but is `retired`.
 *
 * Reads the *store's* mirror, not the kho file directly: neither caller necessarily has read access to
 * `voices/<id>/voice.json` through `LibraryFs` at the point this runs (a channel process only ever wrote its
 * own voice via `addVoice`, which already upserted the mirror; the studio process relies on `syncLibrary`
 * having mirrored the channel's `voices/` beforehand) -- the mirror is the one thing both roles keep current.
 */
export function requireActiveVoice(store: StateStore, voiceId: string | undefined): VoiceProfile {
  if (!voiceId) throw new HarnessError("CONFIG_INVALID", 'voice_id is required when voice is "tts"', {});
  const profile = store.getVoiceProfile(voiceId);
  if (!profile) throw new HarnessError("CONFIG_INVALID", `voice profile not found: ${voiceId}; run library sync first`, { voice_id: voiceId });
  if (profile.status !== "active") throw new HarnessError("CONFIG_INVALID", `voice profile ${voiceId} is ${profile.status}, not active`, { voice_id: voiceId, status: profile.status });
  return profile;
}
