import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LibraryItemSchema,
  newId,
  type ContentItem,
  type EditStyle,
  type LibraryBrief,
  type MediaProbe,
  type MediaProber,
  type Run,
} from "@harness/contracts";
import { canonicalDigest, exportItem, exportStyle, LibraryFs, sha256File } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "library-export-"));
}

function tempSrcDir(): string {
  return mkdtempSync(join(tmpdir(), "library-export-src-"));
}

class FakeProber implements MediaProber {
  constructor(private readonly result: MediaProbe | null) {}
  async probe(_path: string): Promise<MediaProbe | null> {
    return this.result;
  }
}

function world() {
  const root = tempRoot();
  const fs = new LibraryFs({ root, role: "studio" });
  const { store, clock } = openTempStore();
  const prober = new FakeProber({ media: null, duration_seconds: 12, mime_type: "video/mp4", container: null, video: null, audio: null });
  return { root, fs, store, clock, prober, d: { store, fs, clock, prober } };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  const sha = "sha256:" + "a".repeat(64);
  return {
    schema_version: "harness.run/v1",
    run_id: newId("run"),
    project_id: "project-studio",
    portfolio_id: "portfolio-a",
    workflow_release: { id: "library-production", version: "1.0.0", digest: sha },
    profile_snapshot: { id: "studio", revision: 1 },
    options: {},
    state: "RUNNING",
    effective_config_snapshot: {},
    effective_config_digest: sha,
    total_cost_usd: 0,
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function makeContent(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    schema_version: "harness.content-item/v1",
    content_id: newId("content_item"),
    source_ids: [newId("source_item")],
    revision: 1,
    title: "5 ancient ruins",
    created_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function makeBrief(overrides: Partial<LibraryBrief> = {}): LibraryBrief {
  return {
    request_id: newId("content_request"),
    topic: "ancient ruins survey",
    style_id: newId("edit_style"),
    style_revision: 1,
    voice: "none",
    language: "vi",
    ...overrides,
  };
}

function makeSources() {
  const src = tempSrcDir();
  const episodePath = join(src, "full-episode.mp4");
  writeFileSync(episodePath, "episode-bytes");
  const thumb1 = join(src, "cand-1.png");
  writeFileSync(thumb1, "thumb-1");
  const thumb2 = join(src, "cand-2.jpg");
  writeFileSync(thumb2, "thumb-2");
  const captionsPath = join(src, "captions.json");
  writeFileSync(captionsPath, JSON.stringify({ cues: [] }));
  const editPlanPath = join(src, "plan.json");
  writeFileSync(editPlanPath, JSON.stringify({ style_id: "x" }));
  return { episodePath, thumbnailPaths: [thumb1, thumb2], captionsPath, editPlanPath };
}

describe("exportItem", () => {
  it("copies episode/thumbnails/captions/edit-plan into items/<id>/ and writes a pending_review manifest", async () => {
    const { d, fs, store } = world();
    const run = makeRun();
    const content = makeContent();
    const brief = makeBrief();
    const sources = makeSources();

    const { item, receipt } = await exportItem(d, { run, content, brief, ...sources });

    expect(item.status).toBe("pending_review");
    expect(item.title_hint).toBe(content.title);
    expect(item.summary).toBe(brief.topic);
    expect(item.style).toEqual({ style_id: brief.style_id, revision: brief.style_revision });
    expect(item.request_id).toBe(brief.request_id);
    expect(item.duration_seconds).toBe(12);
    expect(item.media).toBeNull();
    expect(item.lineage).toEqual({
      project_id: run.project_id,
      run_id: run.run_id,
      content_id: content.content_id,
      source_ids: content.source_ids,
    });
    expect(item.created_at).toBe(item.updated_at);

    const dir = fs.paths.itemDir(item.item_id);
    expect(existsSync(join(dir, "episode.mp4"))).toBe(true);
    expect(existsSync(join(dir, "thumbnail-01.png"))).toBe(true);
    expect(existsSync(join(dir, "thumbnail-02.jpg"))).toBe(true);
    expect(existsSync(join(dir, "captions.json"))).toBe(true);
    expect(existsSync(join(dir, "edit-plan.json"))).toBe(true);

    expect(item.files.map((f) => f.path)).toEqual([
      "episode.mp4",
      "thumbnail-01.png",
      "thumbnail-02.jpg",
      "captions.json",
      "edit-plan.json",
    ]);
    for (const f of item.files) {
      const actual = await sha256File(join(dir, f.path));
      expect(actual.checksum).toBe(f.checksum);
      expect(actual.size_bytes).toBe(f.size_bytes);
    }

    const onDisk = JSON.parse(readFileSync(fs.paths.manifest(item.item_id), "utf8"));
    const parsed = LibraryItemSchema.safeParse(onDisk);
    expect(parsed.success).toBe(true);
    expect(onDisk.status).toBe("pending_review");

    expect(store.getLibraryItem(item.item_id)).toEqual(item);

    expect(receipt.item_id).toBe(item.item_id);
    expect(receipt.item_dir).toBe(dir);
    expect(receipt.files).toEqual(item.files);
    expect(receipt.manifest_checksum).toBe(canonicalDigest(item));
  });

  it("omits captions.json when no captionsPath is given", async () => {
    const { d } = world();
    const sources = makeSources();
    const { item } = await exportItem(d, {
      run: makeRun(),
      content: makeContent(),
      brief: makeBrief(),
      episodePath: sources.episodePath,
      thumbnailPaths: sources.thumbnailPaths,
      editPlanPath: sources.editPlanPath,
    });
    expect(item.files.map((f) => f.path)).toEqual(["episode.mp4", "thumbnail-01.png", "thumbnail-02.jpg", "edit-plan.json"]);
  });

  it("falls back to duration_seconds 0 when the prober returns null", async () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    const { store, clock } = openTempStore();
    const prober = new FakeProber(null);
    const sources = makeSources();
    const { item } = await exportItem({ store, fs, clock, prober }, { run: makeRun(), content: makeContent(), brief: makeBrief(), ...sources });
    expect(item.duration_seconds).toBe(0);
    expect(item.media).toBeNull();
  });

  it("is idempotent for existingItemId: same directory, same id, created_at preserved, updated_at refreshed", async () => {
    const { d, fs, store, clock } = world();
    const sources = makeSources();
    const run = makeRun();
    const content = makeContent();
    const brief = makeBrief();

    const first = await exportItem(d, { run, content, brief, ...sources });
    clock.advance(60);
    const second = await exportItem(d, { run, content, brief: { ...brief, topic: "revised topic" }, existingItemId: first.item.item_id, ...sources });

    expect(second.item.item_id).toBe(first.item.item_id);
    expect(second.receipt.item_dir).toBe(first.receipt.item_dir);
    expect(second.item.created_at).toBe(first.item.created_at);
    expect(second.item.updated_at).not.toBe(first.item.updated_at);
    expect(second.item.summary).toBe("revised topic");

    // only one item directory/manifest exists, no second item minted
    expect(fs.listItemIds()).toEqual([first.item.item_id]);
    expect(store.listLibraryItems()).toHaveLength(1);
  });

  it("prunes stale files on re-export with a smaller/different file set, preserving manifest.json and claims/", async () => {
    const { d, fs, store } = world();
    const run = makeRun();
    const content = makeContent();
    const brief = makeBrief();

    const src = tempSrcDir();
    const episodePath = join(src, "full-episode.mp4");
    writeFileSync(episodePath, "episode-bytes");
    const editPlanPath = join(src, "plan.json");
    writeFileSync(editPlanPath, JSON.stringify({ style_id: "x" }));

    const firstThumb1 = join(src, "first-1.png");
    writeFileSync(firstThumb1, "first-thumb-1");
    const firstThumb2 = join(src, "first-2.jpg");
    writeFileSync(firstThumb2, "first-thumb-2");
    const firstThumb3 = join(src, "first-3.png");
    writeFileSync(firstThumb3, "first-thumb-3");

    const first = await exportItem(d, {
      run, content, brief, episodePath, editPlanPath,
      thumbnailPaths: [firstThumb1, firstThumb2, firstThumb3],
    });
    const dir = first.receipt.item_dir;

    // A claim file, as a channel would write it — must never be touched by a studio re-export.
    mkdirSync(join(dir, "claims"), { recursive: true });
    writeFileSync(join(dir, "claims", "c1.json"), JSON.stringify({ item_id: first.item.item_id }));

    const secondThumb1 = join(src, "second-1.png");
    writeFileSync(secondThumb1, "second-thumb-1");
    const secondThumb2 = join(src, "second-2.webp"); // same slot as firstThumb2, different extension
    writeFileSync(secondThumb2, "second-thumb-2");

    const second = await exportItem(d, {
      run, content, brief, episodePath, editPlanPath,
      thumbnailPaths: [secondThumb1, secondThumb2],
      existingItemId: first.item.item_id,
    });

    expect(second.item.item_id).toBe(first.item.item_id);
    expect(second.item.created_at).toBe(first.item.created_at);

    const topLevelFiles = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
    expect(topLevelFiles).toEqual(["edit-plan.json", "episode.mp4", "manifest.json", "thumbnail-01.png", "thumbnail-02.webp"].sort());
    expect(existsSync(join(dir, "thumbnail-02.jpg"))).toBe(false); // stale: superseded extension
    expect(existsSync(join(dir, "thumbnail-03.png"))).toBe(false); // stale: no third thumbnail this time

    expect(existsSync(join(dir, "claims", "c1.json"))).toBe(true);

    expect(second.item.files.map((f) => f.path)).toEqual(["episode.mp4", "thumbnail-01.png", "thumbnail-02.webp", "edit-plan.json"]);
    expect(store.getLibraryItem(second.item.item_id)).toEqual(second.item);
    expect(fs.listItemIds()).toEqual([first.item.item_id]);
  });

  it("treats an existingItemId with no manifest on disk yet the same as a fresh export (created_at = now)", async () => {
    const { d } = world();
    const sources = makeSources();
    const preallocatedId = newId("library_item");
    const { item } = await exportItem(d, { run: makeRun(), content: makeContent(), brief: makeBrief(), existingItemId: preallocatedId, ...sources });
    expect(item.item_id).toBe(preallocatedId);
    expect(item.created_at).toBe(item.updated_at);
  });
});

describe("exportStyle", () => {
  function makeStyle(overrides: Partial<EditStyle> = {}): EditStyle {
    return {
      schema_version: "harness.edit-style/v1",
      style_id: newId("edit_style"),
      revision: 1,
      name: "fast-cut ruins",
      status: "draft",
      learned_from: [],
      params: {
        cut_rhythm: "fast",
        shot_seconds: [1, 3],
        transitions: ["cut"],
        text_overlay: { style: "bold", density: "medium" },
        subtitles: "burn-in",
        music: { mood: "tense", ducking: true },
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

  function evidenceDir(): string {
    const dir = tempSrcDir();
    writeFileSync(join(dir, "frame-01.png"), "frame-1");
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "analysis.md"), "# notes");
    return dir;
  }

  it("copies evidence files into styles/<id>/evidence/, records them, and writes style.json", async () => {
    const { d, fs, store } = world();
    const style = makeStyle();
    const dirSrc = evidenceDir();

    const { style: saved, dir } = await exportStyle(d, { style, evidenceDir: dirSrc });

    expect(dir).toBe(fs.paths.styleDir(style.style_id));
    expect(existsSync(join(dir, "evidence", "frame-01.png"))).toBe(true);
    expect(existsSync(join(dir, "evidence", "notes", "analysis.md"))).toBe(true);

    const paths = saved.evidence.map((e) => e.path).sort();
    expect(paths).toEqual(["evidence/frame-01.png", "evidence/notes/analysis.md"]);
    expect(saved.updated_at).not.toBe(style.updated_at);

    const onDisk = JSON.parse(readFileSync(fs.paths.styleFile(style.style_id), "utf8"));
    expect(onDisk.style_id).toBe(style.style_id);
    expect(store.getEditStyle(style.style_id)).toEqual(saved);
  });

  it("keeps existing evidence entries and does not duplicate a path already listed", async () => {
    const { d } = world();
    const style = makeStyle({ evidence: [{ path: "evidence/frame-01.png", note: "hand-picked" }] });
    const dirSrc = evidenceDir();

    const { style: saved } = await exportStyle(d, { style, evidenceDir: dirSrc });

    const frame1Entries = saved.evidence.filter((e) => e.path === "evidence/frame-01.png");
    expect(frame1Entries).toHaveLength(1);
    expect(frame1Entries[0].note).toBe("hand-picked");
    expect(saved.evidence.map((e) => e.path).sort()).toEqual(["evidence/frame-01.png", "evidence/notes/analysis.md"]);
  });

  it("writes style.json with no evidence copy when evidenceDir is omitted", async () => {
    const { d, fs } = world();
    const style = makeStyle();
    const { style: saved, dir } = await exportStyle(d, { style });
    expect(saved.evidence).toEqual([]);
    expect(existsSync(fs.paths.styleFile(style.style_id))).toBe(true);
    expect(existsSync(join(dir, "evidence"))).toBe(false);
  });
});
