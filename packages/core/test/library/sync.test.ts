import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, newId } from "@harness/contracts";
import type { ContentRequest, EditStyle, LibraryItem, VoiceProfile } from "@harness/contracts";
import { LibraryFs, sha256File, syncLibrary, writeIndex } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "library-sync-"));
}

function makeStyle(id: string, overrides: Partial<EditStyle> = {}): EditStyle {
  return {
    schema_version: "harness.edit-style/v1",
    style_id: id,
    revision: 1,
    name: "Fast cuts",
    status: "active",
    learned_from: [],
    params: {
      cut_rhythm: "fast",
      shot_seconds: [1, 3],
      transitions: [],
      text_overlay: { style: "bold", density: "medium" },
      subtitles: "burn-in",
      music: { mood: "upbeat", ducking: true },
      opening: { seconds: 3, structure: "hook" },
      aspect_ratio: "16:9",
      pace_notes: "",
    },
    evidence: [],
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function makeRequest(id: string, overrides: Partial<ContentRequest> = {}): ContentRequest {
  return {
    schema_version: "harness.content-request/v1",
    request_id: id,
    requested_by: { portfolio_id: "portfolio-main" },
    topic: "5 ancient ruins",
    voice: "none",
    language: "vi",
    count: 1,
    status: "open",
    item_ids: [],
    notes: "",
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function makeItem(id: string, styleId: string, overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    schema_version: "harness.library-item/v1",
    item_id: id,
    status: "pending_review",
    title_hint: "Ancient ruins ep. 1",
    summary: "",
    style: { style_id: styleId, revision: 1 },
    duration_seconds: 120,
    media: null,
    files: [],
    lineage: { project_id: "project-studio", run_id: newId("run"), content_id: newId("content_item"), source_ids: [] },
    review: { note: "" },
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function makeVoice(id: string, overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    schema_version: "harness.voice/v1", voice_id: id, display_name: "Narrator", language: "vi",
    origin: "own", origin_note: "", ref_audio: { path: "ref.wav", checksum: `sha256:${"a".repeat(64)}`, duration_seconds: 5 },
    ref_text: "hi", params: { speed: 1, num_step: 32 }, revision: 1, status: "active",
    created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

async function writeItem(fs: LibraryFs, id: string, styleId: string, dataBytes: string): Promise<LibraryItem> {
  const dataPath = join(fs.paths.itemDir(id), "episode.mp4");
  mkdirSync(fs.paths.itemDir(id), { recursive: true });
  writeFileSync(dataPath, dataBytes);
  const { checksum, size_bytes } = await sha256File(dataPath);
  const item = makeItem(id, styleId, { files: [{ path: "episode.mp4", checksum, size_bytes, mime_type: "video/mp4" }] });
  fs.writeJsonAtomic(fs.paths.manifest(id), item);
  return item;
}

describe("syncLibrary", () => {
  it("imports valid entities, flags corrupt ones without importing them, and skips .tmp- files", async () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    const channel = new LibraryFs({ root, role: "channel" });
    const { store, clock } = openTempStore();

    const styleId = newId("edit_style");
    studio.writeJsonAtomic(studio.paths.styleFile(styleId), makeStyle(styleId));

    // Requests are the channel's to create; studio may only overwrite one that already exists.
    const req1Id = newId("content_request");
    const req2Id = newId("content_request");
    channel.writeJsonAtomic(channel.paths.requestFile(req1Id), makeRequest(req1Id));
    mkdirSync(channel.paths.requests, { recursive: true });
    writeFileSync(channel.paths.requestFile(req2Id), "{not valid json");

    const item1Id = newId("library_item");
    const item2Id = newId("library_item");
    await writeItem(studio, item1Id, styleId, "episode one bytes");
    await writeItem(studio, item2Id, styleId, "episode two bytes");
    // Tamper with item 2's data file after the manifest (and its checksum) were written.
    writeFileSync(join(studio.paths.itemDir(item2Id), "episode.mp4"), "tampered bytes");

    // A stray .tmp- artifact left by an interrupted write; sync must ignore it entirely.
    mkdirSync(join(studio.paths.items, ".tmp-abandoned"), { recursive: true });
    writeFileSync(join(studio.paths.items, ".tmp-abandoned", "manifest.json"), "{not json either");

    const report = await syncLibrary({ store, fs: studio, role: "studio", clock });

    expect(report.imported.styles).toEqual([styleId]);
    expect(report.imported.requests).toEqual([req1Id]);
    expect(report.imported.items).toEqual([item1Id]);
    expect(report.updated).toEqual({ styles: [], requests: [], items: [], voices: [], brands: [], tracks: [] });
    expect(report.missing).toEqual([]);

    expect(report.corrupt).toHaveLength(2);
    const corruptPaths = report.corrupt.map((c) => c.path);
    expect(corruptPaths).toContain(studio.paths.requestFile(req2Id));
    expect(corruptPaths).toContain(join(studio.paths.itemDir(item2Id), "episode.mp4"));
    for (const c of report.corrupt) expect(c.reason.length).toBeGreaterThan(0);

    expect(store.getEditStyle(styleId)).toBeDefined();
    expect(store.getContentRequest(req1Id)).toBeDefined();
    expect(store.getContentRequest(req2Id)).toBeUndefined();
    expect(store.getLibraryItem(item1Id)).toBeDefined();
    expect(store.getLibraryItem(item2Id)).toBeUndefined();

    // studio's role writes index.json; channel's role never does.
    expect(existsSync(studio.paths.index)).toBe(true);
    const index = JSON.parse(readFileSync(studio.paths.index, "utf8")) as {
      generated_at: string;
      styles: { id: string; revision: number; status: string; name: string }[];
      requests: { id: string; status: string; topic: string }[];
      items: { id: string; status: string; title_hint: string; duration_seconds: number; style: { style_id: string; revision: number } }[];
    };
    expect(index.styles).toEqual([{ id: styleId, revision: 1, status: "active", name: "Fast cuts" }]);
    expect(index.requests).toEqual([{ id: req1Id, status: "open", topic: "5 ancient ruins" }]);
    expect(index.items).toEqual([{ id: item1Id, status: "pending_review", title_hint: "Ancient ruins ep. 1", duration_seconds: 120, style: { style_id: styleId, revision: 1 } }]);
  });

  it("treats a data file deleted after the manifest was written as 'missing file', not 'checksum mismatch', and imports the other items", async () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    const { store, clock } = openTempStore();

    const styleId = newId("edit_style");
    const item1Id = newId("library_item");
    const item2Id = newId("library_item");
    await writeItem(studio, item1Id, styleId, "episode one bytes");
    await writeItem(studio, item2Id, styleId, "episode two bytes");
    const missingPath = join(studio.paths.itemDir(item2Id), "episode.mp4");
    rmSync(missingPath);

    const report = await syncLibrary({ store, fs: studio, role: "studio", clock });

    expect(report.imported.items).toEqual([item1Id]);
    expect(report.corrupt).toEqual([{ path: missingPath, reason: `missing file: ${missingPath}` }]);
    expect(store.getLibraryItem(item1Id)).toBeDefined();
    expect(store.getLibraryItem(item2Id)).toBeUndefined();
  });

  it("catches a read error during data-file verification (a files[] path that names a directory) without aborting the rest of sync", async () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    const { store, clock } = openTempStore();

    const styleId = newId("edit_style");
    const item1Id = newId("library_item");
    await writeItem(studio, item1Id, styleId, "episode one bytes");

    // item2's manifest claims a data file whose path on disk is actually a directory: sha256File's
    // createReadStream rejects with EISDIR instead of the file simply not matching a checksum.
    const item2Id = newId("library_item");
    const badPath = join(studio.paths.itemDir(item2Id), "episode.mp4");
    mkdirSync(badPath, { recursive: true });
    const item2 = makeItem(item2Id, styleId, {
      files: [{ path: "episode.mp4", checksum: `sha256:${"0".repeat(64)}`, size_bytes: 0, mime_type: "video/mp4" }],
    });
    studio.writeJsonAtomic(studio.paths.manifest(item2Id), item2);

    const report = await syncLibrary({ store, fs: studio, role: "studio", clock });

    expect(report.imported.items).toEqual([item1Id]);
    expect(report.corrupt).toHaveLength(1);
    expect(report.corrupt[0].path).toBe(badPath);
    expect(report.corrupt[0].reason.length).toBeGreaterThan(0);
    expect(report.corrupt[0].reason).not.toMatch(/^missing file:/);
    expect(report.corrupt[0].reason).not.toMatch(/^checksum mismatch:/);
    expect(store.getLibraryItem(item2Id)).toBeUndefined();

    // The rest of sync still ran to completion: missing-bookkeeping and index.json both happened.
    expect(report.missing).toEqual([]);
    expect(existsSync(studio.paths.index)).toBe(true);
  });

  it("classifies a re-synced entity as updated when updated_at moves forward or content changes, and unchanged otherwise", async () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    const channel = new LibraryFs({ root, role: "channel" });
    const { store, clock } = openTempStore();

    const req1Id = newId("content_request");
    channel.writeJsonAtomic(channel.paths.requestFile(req1Id), makeRequest(req1Id));
    const first = await syncLibrary({ store, fs: studio, role: "studio", clock });
    expect(first.imported.requests).toEqual([req1Id]);

    // Re-sync with no file changes at all: nothing imported or updated.
    const unchanged = await syncLibrary({ store, fs: studio, role: "studio", clock });
    expect(unchanged.imported.requests).toEqual([]);
    expect(unchanged.updated.requests).toEqual([]);

    // Rewrite the same request with a newer updated_at (content otherwise identical); the request
    // already exists on disk, so studio is allowed to overwrite it (e.g. after claiming it).
    clock.advance(60);
    studio.writeJsonAtomic(studio.paths.requestFile(req1Id), makeRequest(req1Id, { updated_at: clock.now(), notes: "still the same topic" }));
    const updatedReport = await syncLibrary({ store, fs: studio, role: "studio", clock });
    expect(updatedReport.updated.requests).toEqual([req1Id]);
    expect(store.getContentRequest(req1Id)?.notes).toBe("still the same topic");
  });

  it("reports a DB row whose file has disappeared from the library as missing, without deleting it from the store", async () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    const { store, clock } = openTempStore();

    const styleId = newId("edit_style");
    studio.writeJsonAtomic(studio.paths.styleFile(styleId), makeStyle(styleId));
    await syncLibrary({ store, fs: studio, role: "studio", clock });
    expect(store.getEditStyle(styleId)).toBeDefined();

    // The style directory disappears from the shared library (e.g. a stale mount).
    rmSync(studio.paths.styleDir(styleId), { recursive: true, force: true });

    const report = await syncLibrary({ store, fs: studio, role: "studio", clock });
    expect(report.missing).toEqual([{ kind: "style", id: styleId }]);
    expect(store.getEditStyle(styleId)).toBeDefined();
  });

  it("throws IO_ERROR instead of reporting everything missing when the kho root is not mounted", async () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    const { store, clock } = openTempStore();

    const styleId = newId("edit_style");
    studio.writeJsonAtomic(studio.paths.styleFile(styleId), makeStyle(styleId));
    await syncLibrary({ store, fs: studio, role: "studio", clock });

    rmSync(root, { recursive: true, force: true });

    let caught: unknown;
    try {
      await syncLibrary({ store, fs: studio, role: "studio", clock });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "IO_ERROR")).toBe(true);
    expect((caught as { message: string }).message).toContain(root);
    // the mirror is untouched: an unmounted kho says nothing about what the kho holds
    expect(store.getEditStyle(styleId)).toBeDefined();
  });

  it("verifies data files only for new or changed items, unless verify: true", async () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    const { store, clock } = openTempStore();

    const styleId = newId("edit_style");
    const itemId = newId("library_item");
    await writeItem(studio, itemId, styleId, "episode one bytes");

    const spy = vi.spyOn(studio, "verifyFile");
    const first = await syncLibrary({ store, fs: studio, role: "studio", clock });
    expect(first.imported.items).toEqual([itemId]);
    expect(spy).toHaveBeenCalledTimes(1); // a new item is always verified

    // unchanged on a second sync: the expensive re-hash is skipped entirely
    spy.mockClear();
    const second = await syncLibrary({ store, fs: studio, role: "studio", clock });
    expect(second.updated.items).toEqual([]);
    expect(spy).not.toHaveBeenCalled();

    // ... unless the caller asks for a full audit
    spy.mockClear();
    const audited = await syncLibrary({ store, fs: studio, role: "studio", clock }, { verify: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(audited.corrupt).toEqual([]);
    spy.mockRestore();
  });

  it("reports a tampered data file of an otherwise-unchanged item only under verify: true", async () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    const { store, clock } = openTempStore();

    const styleId = newId("edit_style");
    const itemId = newId("library_item");
    await writeItem(studio, itemId, styleId, "episode one bytes");
    expect((await syncLibrary({ store, fs: studio, role: "studio", clock })).imported.items).toEqual([itemId]);

    // the manifest is untouched, so the item classifies as unchanged; only its bytes moved
    const dataPath = join(studio.paths.itemDir(itemId), "episode.mp4");
    writeFileSync(dataPath, "tampered bytes");

    const cheap = await syncLibrary({ store, fs: studio, role: "studio", clock });
    expect(cheap.corrupt).toEqual([]);

    const audit = await syncLibrary({ store, fs: studio, role: "studio", clock }, { verify: true });
    expect(audit.corrupt).toHaveLength(1);
    expect(audit.corrupt[0].path).toBe(dataPath);
    expect(audit.corrupt[0].reason).toMatch(/^checksum mismatch:/);
  });

  it("only writes index.json for the studio role; the channel role never writes it", async () => {
    const root = tempRoot();
    const { store, clock } = openTempStore();

    const styleId = newId("edit_style");
    const studioFs = new LibraryFs({ root, role: "studio" });
    studioFs.writeJsonAtomic(studioFs.paths.styleFile(styleId), makeStyle(styleId));

    const channelFs = new LibraryFs({ root, role: "channel" });
    await syncLibrary({ store, fs: channelFs, role: "channel", clock });
    expect(existsSync(join(root, "index.json"))).toBe(false);

    await syncLibrary({ store, fs: studioFs, role: "studio", clock });
    expect(existsSync(join(root, "index.json"))).toBe(true);
  });
});

describe("syncLibrary voices", () => {
  it("mirrors a hand-written voice.json for both the studio and channel role", async () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    const voiceId = newId("voice_profile");
    channel.writeJsonAtomic(channel.paths.voiceFile(voiceId), makeVoice(voiceId));

    const studio = new LibraryFs({ root, role: "studio" });
    const { store: studioStore, clock: studioClock } = openTempStore();
    const studioReport = await syncLibrary({ store: studioStore, fs: studio, role: "studio", clock: studioClock });
    expect(studioReport.imported.voices).toEqual([voiceId]);
    expect(studioStore.getVoiceProfile(voiceId)?.voice_id).toBe(voiceId);

    const { store: channelStore, clock: channelClock } = openTempStore();
    const channelReport = await syncLibrary({ store: channelStore, fs: channel, role: "channel", clock: channelClock });
    expect(channelReport.imported.voices).toEqual([voiceId]);
    expect(channelStore.getVoiceProfile(voiceId)?.voice_id).toBe(voiceId);
  });

  it("flags a corrupt voice.json without importing it", async () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    const voiceId = newId("voice_profile");
    mkdirSync(channel.paths.voiceDir(voiceId), { recursive: true });
    writeFileSync(join(channel.paths.voiceDir(voiceId), "voice.json"), "{not valid json");
    const { store, clock } = openTempStore();

    const report = await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(report.imported.voices).toEqual([]);
    expect(report.corrupt).toHaveLength(1);
    expect(report.corrupt[0].path).toBe(join(channel.paths.voiceDir(voiceId), "voice.json"));
  });

  // Review finding (Task 4 fix round 1, Important #1): `voiceDir`/`voiceFile` now throw CONFIG_INVALID for an
  // id that isn't a valid `voice_<ULID>` -- `listVoiceIds` itself does not check that (only that a `voice.json`
  // sits inside the directory), so a malformed directory name must isolate to one `corrupt` entry the same as
  // any other bad file, not crash the whole sync. Written with plain node:fs (not `channel.paths.voiceDir`,
  // which would itself now refuse the bad name) to stand in for a directory an operator created by hand.
  it("isolates a voices/ directory whose name is not a valid voice_id to one corrupt entry, without aborting the rest of sync", async () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    const badDir = join(channel.paths.voicesDir, "voice-broken");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "voice.json"), JSON.stringify({ hello: "not a real voice profile" }));

    const styleId = newId("edit_style");
    const studio = new LibraryFs({ root, role: "studio" });
    studio.writeJsonAtomic(studio.paths.styleFile(styleId), makeStyle(styleId));

    const { store, clock } = openTempStore();
    const report = await syncLibrary({ store, fs: channel, role: "channel", clock });

    expect(report.imported.voices).toEqual([]);
    expect(report.corrupt).toHaveLength(1);
    expect(report.corrupt[0].path).toBe(join(badDir, "voice.json"));
    // and the rest of sync still ran to completion (a style import, unrelated to voices, still happened)
    expect(report.imported.styles).toEqual([styleId]);
  });

  it("reports a mirrored voice whose kho entry disappeared as missing, without dropping it from the store", async () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    const voiceId = newId("voice_profile");
    channel.writeJsonAtomic(channel.paths.voiceFile(voiceId), makeVoice(voiceId));
    const { store, clock } = openTempStore();
    await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(store.getVoiceProfile(voiceId)).toBeDefined();

    rmSync(channel.paths.voiceDir(voiceId), { recursive: true, force: true });
    const report = await syncLibrary({ store, fs: channel, role: "channel", clock });
    expect(report.missing).toEqual([{ kind: "voice", id: voiceId }]);
    expect(store.getVoiceProfile(voiceId)).toBeDefined();
  });
});

describe("writeIndex", () => {
  it("writes generated_at plus the current DB mirrors, independent of syncLibrary", () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    const { store, clock } = openTempStore();

    const styleId = newId("edit_style");
    store.upsertEditStyle(makeStyle(styleId));

    writeIndex({ fs, store, clock });

    const raw = JSON.parse(readFileSync(fs.paths.index, "utf8"));
    expect(raw.generated_at).toBe(clock.now());
    expect(raw.styles).toEqual([{ id: styleId, revision: 1, status: "active", name: "Fast cuts" }]);
    expect(raw.requests).toEqual([]);
    expect(raw.items).toEqual([]);
  });
});
