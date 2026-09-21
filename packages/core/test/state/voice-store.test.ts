import { describe, expect, it } from "vitest";
import { newId, type VoiceProfile } from "@harness/contracts";
import { openTempStore } from "../helpers.js";

const NOW = "2026-09-21T00:00:00.000Z";
const LATER = "2026-09-21T01:00:00.000Z";
const SHA = "sha256:" + "a".repeat(64);

function voiceProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    schema_version: "harness.voice/v1", voice_id: newId("voice_profile"), display_name: "Chị Hai", language: "vi",
    origin: "own", origin_note: "", ref_audio: { path: "ref.wav", checksum: SHA, duration_seconds: 8 },
    ref_text: "xin chào các bạn", params: { speed: 1, num_step: 32 }, revision: 1, status: "active",
    created_at: NOW, updated_at: NOW, ...overrides,
  };
}

describe("migration 0006", () => {
  it("adds the voice_profile table", () => {
    const { store } = openTempStore();
    expect(store.listAppliedMigrations()).toContain("0006_media.sql");
    expect(store.tableNames()).toEqual(expect.arrayContaining(["voice_profile"]));
  });
});

describe("voice_profile store", () => {
  it("upsert inserts a new row and get returns it", () => {
    const { store } = openTempStore();
    const v = voiceProfile();
    store.upsertVoiceProfile(v);
    expect(store.getVoiceProfile(v.voice_id)).toEqual(v);
  });

  it("upsert with the same id overwrites the existing row", () => {
    const { store } = openTempStore();
    const id = newId("voice_profile");
    store.upsertVoiceProfile(voiceProfile({ voice_id: id, revision: 1 }));
    store.upsertVoiceProfile(voiceProfile({ voice_id: id, revision: 2, updated_at: LATER }));
    const got = store.getVoiceProfile(id);
    expect(got?.revision).toBe(2);
    expect(got?.updated_at).toBe(LATER);
  });

  it("returns undefined for an unknown voice_id", () => {
    const { store } = openTempStore();
    expect(store.getVoiceProfile(newId("voice_profile"))).toBeUndefined();
  });

  it("lists all voice profiles, and filters by status", () => {
    const { store } = openTempStore();
    const active = voiceProfile({ status: "active" });
    const retired = voiceProfile({ status: "retired" });
    store.upsertVoiceProfile(active);
    store.upsertVoiceProfile(retired);
    expect(store.listVoiceProfiles({}).map((v) => v.voice_id).sort()).toEqual([active.voice_id, retired.voice_id].sort());
    expect(store.listVoiceProfiles({ status: "active" }).map((v) => v.voice_id)).toEqual([active.voice_id]);
    expect(store.listVoiceProfiles({ status: "retired" }).map((v) => v.voice_id)).toEqual([retired.voice_id]);
  });
});
