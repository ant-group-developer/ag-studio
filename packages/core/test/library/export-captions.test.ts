import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError, newId, type ContentItem, type LibraryBrief, type MediaProbe, type MediaProber, type Run } from "@harness/contracts";
import { exportItem, LibraryFs, sha256File } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

// Sub-project 5B Task 8: `media-compose` produces a captions DIRECTORY (`captions.srt` + `captions.vtt`),
// not the single `captions.json` file `library-production@1.1.0`/`@1.2.0` declared and no stage ever
// actually wrote. `exportItem` gained `captionsDir` for it; `captionsPath` keeps working unchanged.

class FakeProber implements MediaProber {
  async probe(): Promise<MediaProbe | null> {
    return { media: null, duration_seconds: 12, mime_type: "video/mp4", container: null, video: null, audio: null };
  }
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "library-export-captions-"));
  const fs = new LibraryFs({ root, role: "studio" });
  const { store, clock } = openTempStore();
  return { fs, d: { store, fs, clock, prober: new FakeProber() } };
}

function makeRun(): Run {
  const sha = "sha256:" + "a".repeat(64);
  return {
    schema_version: "harness.run/v1", run_id: newId("run"), project_id: "project-studio", portfolio_id: "portfolio-a",
    workflow_release: { id: "library-production", version: "1.3.0", digest: sha }, profile_snapshot: { id: "studio", revision: 4 },
    options: {}, state: "RUNNING", effective_config_snapshot: {}, effective_config_digest: sha, total_cost_usd: 0,
    created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  };
}

function makeContent(): ContentItem {
  return {
    schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [newId("source_item")],
    revision: 1, title: "chợ nổi", created_at: "2026-09-14T00:00:00.000Z",
  };
}

function makeBrief(): LibraryBrief {
  return { request_id: newId("content_request"), topic: "chợ nổi", style_id: newId("edit_style"), style_revision: 1, voice: "none", language: "vi" };
}

/** An episode + thumbnail + edit-plan, plus a `captions/` directory exactly as `media-compose` writes it. */
function makeSources(o: { vtt?: boolean } = {}) {
  const src = mkdtempSync(join(tmpdir(), "library-export-captions-src-"));
  const episodePath = join(src, "full-episode.mp4");
  writeFileSync(episodePath, "episode-bytes");
  const thumb = join(src, "cand-1.png");
  writeFileSync(thumb, "thumb-1");
  const editPlanPath = join(src, "edit-plan.json");
  writeFileSync(editPlanPath, JSON.stringify({ schema_version: "harness.edit-plan/v1", notes: "" }));
  const captionsDir = join(src, "captions");
  mkdirSync(captionsDir, { recursive: true });
  writeFileSync(join(captionsDir, "captions.srt"), "1\n00:00:00,000 --> 00:00:02,000\nxin chào\n\n");
  if (o.vtt !== false) writeFileSync(join(captionsDir, "captions.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nxin chào\n\n");
  return { episodePath, thumbnailPaths: [thumb], editPlanPath, captionsDir };
}

describe("exportItem captionsDir (library-production@1.3.0)", () => {
  it("copies captions.srt and captions.vtt into the item and lists both in files", async () => {
    const { d, fs } = world();
    const { captionsDir, ...rest } = makeSources();

    const { item } = await exportItem(d, { run: makeRun(), content: makeContent(), brief: makeBrief(), ...rest, captionsDir });

    const dir = fs.paths.itemDir(item.item_id);
    expect(existsSync(join(dir, "captions.srt"))).toBe(true);
    expect(existsSync(join(dir, "captions.vtt"))).toBe(true);
    // No `captions.json` is invented for the directory path.
    expect(existsSync(join(dir, "captions.json"))).toBe(false);
    expect(item.files.map((f) => f.path)).toEqual(["episode.mp4", "thumbnail-01.png", "captions.srt", "captions.vtt", "edit-plan.json"]);

    for (const name of ["captions.srt", "captions.vtt"]) {
      const listed = item.files.find((f) => f.path === name)!;
      const actual = await sha256File(join(dir, name));
      expect(listed.checksum, name).toBe(actual.checksum);
      expect(listed.size_bytes, name).toBe(actual.size_bytes);
    }
    expect(readFileSync(join(dir, "captions.vtt"), "utf8")).toContain("WEBVTT");
  });

  it("the old single-file captionsPath still produces captions.json, unchanged", async () => {
    const { d, fs } = world();
    const { captionsDir, ...rest } = makeSources();
    const legacy = join(captionsDir, "captions.json");
    writeFileSync(legacy, JSON.stringify({ cues: [] }));

    const { item } = await exportItem(d, { run: makeRun(), content: makeContent(), brief: makeBrief(), ...rest, captionsPath: legacy });

    const dir = fs.paths.itemDir(item.item_id);
    expect(existsSync(join(dir, "captions.json"))).toBe(true);
    expect(existsSync(join(dir, "captions.srt"))).toBe(false);
    expect(item.files.map((f) => f.path)).toEqual(["episode.mp4", "thumbnail-01.png", "captions.json", "edit-plan.json"]);
  });

  it("a captions directory missing captions.vtt is CONFIG_INVALID, not a half-exported item", async () => {
    const { d } = world();
    const { captionsDir, ...rest } = makeSources({ vtt: false });

    await expect(exportItem(d, { run: makeRun(), content: makeContent(), brief: makeBrief(), ...rest, captionsDir }))
      .rejects.toSatisfy((e: unknown) => isHarnessError(e, "CONFIG_INVALID") && e.message.includes("captions.vtt"));
  });
});
