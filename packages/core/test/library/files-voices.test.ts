import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError } from "@harness/contracts";
import { LibraryFs, libraryPaths } from "../../src/index.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "library-voices-"));
}

describe("libraryPaths voices", () => {
  it("builds voicesDir/voiceDir/voiceFile/voiceRef", () => {
    const root = tempRoot();
    const p = libraryPaths(root);
    expect(p.voicesDir).toBe(join(root, "voices"));
    expect(p.voiceDir("voice_x")).toBe(join(root, "voices", "voice_x"));
    expect(p.voiceFile("voice_x")).toBe(join(root, "voices", "voice_x", "voice.json"));
    expect(p.voiceRef("voice_x")).toBe(join(root, "voices", "voice_x", "ref.wav"));
  });
});

describe("LibraryFs voices write guard", () => {
  it("channel may write both voice.json and ref.wav under voices/<id>/", () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    expect(() => channel.writeJsonAtomic(channel.paths.voiceFile("voice_a"), { ok: true })).not.toThrow();
    expect(() => channel.writeJsonAtomic(channel.paths.voiceRef("voice_a"), { ok: true })).not.toThrow();
    expect(JSON.parse(readFileSync(channel.paths.voiceFile("voice_a"), "utf8"))).toEqual({ ok: true });
  });

  it("studio may not write anything under voices/", () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    let caught: unknown;
    try {
      studio.writeJsonAtomic(studio.paths.voiceFile("voice_a"), { ok: true });
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
      channel.writeJsonAtomic(join(channel.paths.voiceDir("voice_a"), "nested", "extra.json"), { ok: true });
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
    channel.writeJsonAtomic(channel.paths.voiceFile("voice_a"), { ok: true });
    channel.writeJsonAtomic(channel.paths.voiceRef("voice_a"), { ok: true });

    expect(channel.listVoiceIds()).toEqual(["voice_a"]);
  });

  it("returns empty array when voices/ does not exist yet", () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    expect(fs.listVoiceIds()).toEqual([]);
  });
});
