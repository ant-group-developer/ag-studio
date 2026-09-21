import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, newId } from "@harness/contracts";
import { LibraryFs, libraryPaths } from "../../src/index.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "library-voices-"));
}

describe("libraryPaths voices", () => {
  it("builds voicesDir/voiceDir/voiceFile/voiceRef", () => {
    const root = tempRoot();
    const p = libraryPaths(root);
    const id = newId("voice_profile");
    expect(p.voicesDir).toBe(join(root, "voices"));
    expect(p.voiceDir(id)).toBe(join(root, "voices", id));
    expect(p.voiceFile(id)).toBe(join(root, "voices", id, "voice.json"));
    expect(p.voiceRef(id)).toBe(join(root, "voices", id, "ref.wav"));
  });

  // Review finding (Task 4 fix round 1, Important #1): voiceDir/voiceFile/voiceRef must refuse an id that
  // does not match `voice_<ULID>` -- defence in depth against a path-traversal-shaped id (e.g. "../requests")
  // ever resolving to a path outside voices/, on top of `addVoice`/`retireVoice`'s own earlier validation.
  it("voiceDir/voiceFile/voiceRef throw CONFIG_INVALID for an id that is not a valid voice_id", () => {
    const root = tempRoot();
    const p = libraryPaths(root);
    for (const bad of ["foo", "voice_short", "../requests", "", "voice_" + "0".repeat(25)]) {
      for (const fn of [() => p.voiceDir(bad), () => p.voiceFile(bad), () => p.voiceRef(bad)]) {
        let caught: unknown;
        try {
          fn();
        } catch (e) {
          caught = e;
        }
        expect(isHarnessError(caught, "CONFIG_INVALID"), `expected CONFIG_INVALID for id ${JSON.stringify(bad)}`).toBe(true);
      }
    }
  });
});

describe("LibraryFs voices write guard", () => {
  it("channel may write both voice.json and ref.wav under voices/<id>/", () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    const id = newId("voice_profile");
    expect(() => channel.writeJsonAtomic(channel.paths.voiceFile(id), { ok: true })).not.toThrow();
    expect(() => channel.writeJsonAtomic(channel.paths.voiceRef(id), { ok: true })).not.toThrow();
    expect(JSON.parse(readFileSync(channel.paths.voiceFile(id), "utf8"))).toEqual({ ok: true });
  });

  it("studio may not write anything under voices/", () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    let caught: unknown;
    try {
      studio.writeJsonAtomic(studio.paths.voiceFile(newId("voice_profile")), { ok: true });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });

  it("channel may not write deeper than voices/<id>/<file>", () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    let caught: unknown;
    try {
      channel.writeJsonAtomic(join(channel.paths.voiceDir(newId("voice_profile")), "nested", "extra.json"), { ok: true });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });
});

describe("LibraryFs.listVoiceIds", () => {
  it("requires voice.json and skips dot-names", () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    const id = newId("voice_profile");
    channel.writeJsonAtomic(channel.paths.voiceFile(id), { ok: true });
    channel.writeJsonAtomic(channel.paths.voiceRef(id), { ok: true });

    expect(channel.listVoiceIds()).toEqual([id]);
  });

  it("returns empty array when voices/ does not exist yet", () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    expect(fs.listVoiceIds()).toEqual([]);
  });
});
