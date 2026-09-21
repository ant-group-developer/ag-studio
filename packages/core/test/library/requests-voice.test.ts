import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, newId, type VoiceProfile } from "@harness/contracts";
import { createRequest, LibraryFs } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "library-requests-voice-"));
}

function world() {
  const root = tempRoot();
  const fs = new LibraryFs({ root, role: "channel" });
  const { store, clock } = openTempStore();
  return { root, fs, store, clock, d: { store, fs, clock } };
}

function activeVoice(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    schema_version: "harness.voice/v1", voice_id: newId("voice_profile"), display_name: "Narrator", language: "vi",
    origin: "own", origin_note: "", ref_audio: { path: "ref.wav", checksum: `sha256:${"a".repeat(64)}`, duration_seconds: 5 },
    ref_text: "hi", params: { speed: 1, num_step: 32 }, revision: 1, status: "active",
    created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("createRequest voice_id rules", () => {
  it("rejects voice: tts with no voice_id and no channelVoiceId", () => {
    const { d } = world();
    let caught: unknown;
    try {
      createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "t", voice: "tts" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });

  it("rejects voice: tts naming a voice_id the store mirror has never seen", () => {
    const { d } = world();
    let caught: unknown;
    try {
      createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "t", voice: "tts", voice_id: newId("voice_profile") });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });

  it("rejects voice: tts naming a retired voice_id", () => {
    const { d } = world();
    const voice = activeVoice({ status: "retired" });
    d.store.upsertVoiceProfile(voice);
    let caught: unknown;
    try {
      createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "t", voice: "tts", voice_id: voice.voice_id });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });

  it("writes voice_id onto the request when voice: tts and an explicit voice_id is active", () => {
    const { d, fs } = world();
    const voice = activeVoice();
    d.store.upsertVoiceProfile(voice);

    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "t", voice: "tts", voice_id: voice.voice_id });
    expect(request.voice_id).toBe(voice.voice_id);
    const onDisk = JSON.parse(readFileSync(fs.paths.requestFile(request.request_id), "utf8"));
    expect(onDisk.voice_id).toBe(voice.voice_id);
  });

  it("falls back to channelVoiceId when voice: tts and no explicit voice_id is given", () => {
    const { d } = world();
    const voice = activeVoice();
    d.store.upsertVoiceProfile(voice);

    const request = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "t", voice: "tts", channelVoiceId: voice.voice_id });
    expect(request.voice_id).toBe(voice.voice_id);
  });

  it("prefers an explicit voice_id over channelVoiceId", () => {
    const { d } = world();
    const explicit = activeVoice();
    const fallback = activeVoice();
    d.store.upsertVoiceProfile(explicit);
    d.store.upsertVoiceProfile(fallback);

    const request = createRequest(d, {
      requested_by: { portfolio_id: "portfolio-a" }, topic: "t", voice: "tts",
      voice_id: explicit.voice_id, channelVoiceId: fallback.voice_id,
    });
    expect(request.voice_id).toBe(explicit.voice_id);
  });

  it("never persists voice_id when voice is not tts, even if one was passed", () => {
    const { d } = world();
    const voice = activeVoice();
    d.store.upsertVoiceProfile(voice);

    const noneRequest = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "t", voice: "none", voice_id: voice.voice_id });
    expect(noneRequest.voice_id).toBeUndefined();

    const originalRequest = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "t", voice: "original", voice_id: voice.voice_id });
    expect(originalRequest.voice_id).toBeUndefined();

    const defaultRequest = createRequest(d, { requested_by: { portfolio_id: "portfolio-a" }, topic: "t", voice_id: voice.voice_id });
    expect(defaultRequest.voice_id).toBeUndefined();
    expect(defaultRequest.voice).toBe("none");
  });
});
