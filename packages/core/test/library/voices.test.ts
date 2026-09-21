import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, newId } from "@harness/contracts";
import { addVoice, LibraryFs, requireActiveVoice, retireVoice, sha256File } from "../../src/index.js";
import { openTempStore } from "../helpers.js";
import { hasFfmpeg, makeWav } from "../../../../tests/media.js";

function ffmpegPath(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}
function ffprobePath(): string {
  return process.env.FFPROBE_PATH ?? "ffprobe";
}

/** Minimal local duration probe -- `addVoice`'s `probeDuration` is caller-injected (core never imports an
 * adapter), so the test supplies its own instead of pulling in `@harness/adapter-ffprobe`. */
function probeDuration(path: string): number | null {
  const r = spawnSync(ffprobePath(), ["-v", "error", "-print_format", "json", "-show_format", path], { encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as { format?: { duration?: string } };
    const d = Number(parsed.format?.duration);
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function world() {
  const root = tempRoot("library-voices-kho-");
  const fs = new LibraryFs({ root, role: "channel" });
  const { store, clock } = openTempStore();
  return { root, fs, store, clock, d: { fs, store, clock, ffmpeg: ffmpegPath(), probeDuration } };
}

function makeClip(seconds: number): string {
  const dir = tempRoot("library-voices-src-");
  const path = join(dir, "ref.src.wav");
  makeWav(path, seconds);
  return path;
}

describe.skipIf(!hasFfmpeg())("addVoice", () => {
  it("converts a valid clip into a mono 24kHz ref.wav, revision 1, checksum matching the file on disk", async () => {
    const { d, fs } = world();
    const clip = makeClip(5);

    const profile = await addVoice(d, {
      display_name: "Narrator A", ref_path: clip, ref_text: "hello there", language: "vi", origin: "own",
    });

    expect(profile.voice_id).toMatch(/^voice_/);
    expect(profile.revision).toBe(1);
    expect(profile.status).toBe("active");
    expect(profile.ref_audio.path).toBe("ref.wav");
    expect(profile.ref_audio.duration_seconds).toBeGreaterThanOrEqual(4);
    expect(profile.ref_audio.duration_seconds).toBeLessThanOrEqual(6);

    const refPath = fs.paths.voiceRef(profile.voice_id);
    const onDisk = await sha256File(refPath);
    expect(onDisk.checksum).toBe(profile.ref_audio.checksum);

    // mono 24kHz pcm_s16le, verified via ffprobe directly
    const r = spawnSync(ffprobePath(), ["-v", "error", "-print_format", "json", "-show_streams", refPath], { encoding: "utf8" });
    const streams = JSON.parse(r.stdout).streams as { channels: number; sample_rate: string }[];
    expect(streams[0].channels).toBe(1);
    expect(streams[0].sample_rate).toBe("24000");

    expect(d.store.getVoiceProfile(profile.voice_id)).toEqual(profile);
  });

  it("bumps revision and keeps created_at when the same voice_id is added again", async () => {
    const { d } = world();
    const first = await addVoice(d, { display_name: "Narrator A", ref_path: makeClip(5), ref_text: "hello there", language: "vi", origin: "own" });

    d.clock.advance(60);
    const second = await addVoice(d, { voice_id: first.voice_id, display_name: "Narrator A v2", ref_path: makeClip(5), ref_text: "hello again", language: "vi", origin: "own" });

    expect(second.voice_id).toBe(first.voice_id);
    expect(second.revision).toBe(2);
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).not.toBe(first.updated_at);
    expect(second.display_name).toBe("Narrator A v2");
  });

  it("rejects a clip outside [3, 30] seconds without touching the kho", async () => {
    const { d, fs } = world();
    const clip = makeClip(2);

    let caught: unknown;
    try {
      await addVoice(d, { display_name: "Too short", ref_path: clip, ref_text: "hi", language: "vi", origin: "own" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
    expect(fs.listVoiceIds()).toEqual([]);
  });
});

describe.skipIf(!hasFfmpeg())("retireVoice", () => {
  it("moves active -> retired and is idempotent", async () => {
    const { d } = world();
    const profile = await addVoice(d, { display_name: "Narrator A", ref_path: makeClip(5), ref_text: "hello there", language: "vi", origin: "own" });

    const retired = retireVoice(d, profile.voice_id);
    expect(retired.status).toBe("retired");
    expect(d.store.getVoiceProfile(profile.voice_id)?.status).toBe("retired");

    const again = retireVoice(d, profile.voice_id);
    expect(again).toEqual(retired);
  });

  it("throws NOT_FOUND for an id that was never added", () => {
    const { d } = world();
    let caught: unknown;
    try {
      retireVoice(d, newId("voice_profile"));
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "NOT_FOUND")).toBe(true);
  });
});

describe("requireActiveVoice", () => {
  it("throws CONFIG_INVALID when voiceId is undefined", () => {
    const { store } = openTempStore();
    let caught: unknown;
    try {
      requireActiveVoice(store, undefined);
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });

  it("throws CONFIG_INVALID when the voice profile is not in the store mirror", () => {
    const { store } = openTempStore();
    let caught: unknown;
    try {
      requireActiveVoice(store, newId("voice_profile"));
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });

  it("throws CONFIG_INVALID when the voice profile is retired", () => {
    const { store } = openTempStore();
    const voiceId = newId("voice_profile");
    store.upsertVoiceProfile({
      schema_version: "harness.voice/v1", voice_id: voiceId, display_name: "Old", language: "vi",
      origin: "own", origin_note: "", ref_audio: { path: "ref.wav", checksum: `sha256:${"a".repeat(64)}`, duration_seconds: 5 },
      ref_text: "hi", params: { speed: 1, num_step: 32 }, revision: 1, status: "retired",
      created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
    });
    let caught: unknown;
    try {
      requireActiveVoice(store, voiceId);
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });

  it("returns the profile when active", () => {
    const { store } = openTempStore();
    const voiceId = newId("voice_profile");
    const profile = {
      schema_version: "harness.voice/v1" as const, voice_id: voiceId, display_name: "Active", language: "vi",
      origin: "own" as const, origin_note: "", ref_audio: { path: "ref.wav" as const, checksum: `sha256:${"b".repeat(64)}`, duration_seconds: 5 },
      ref_text: "hi", params: { speed: 1, num_step: 32 }, revision: 1, status: "active" as const,
      created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
    };
    store.upsertVoiceProfile(profile);
    expect(requireActiveVoice(store, voiceId)).toEqual(profile);
  });
});
