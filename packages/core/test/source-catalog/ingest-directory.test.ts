import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isHarnessError } from "@harness/contracts";
import { hasFfmpeg, makeVideo } from "../../../../tests/media.js";
import { NullMediaProber, SourceCatalog } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

function world() {
  const t = openTempStore();
  const catalog = new SourceCatalog({ store: t.store, dataRoot: t.dir, prober: new NullMediaProber(), clock: t.clock, materialize: "copy" });
  return { ...t, catalog };
}

describe.skipIf(!hasFfmpeg())("SourceCatalog.ingestDirectory (needs ffmpeg on PATH)", () => {
  it("ingests every video file, ignores non-video and hidden files silently, and skips a file that fails to ingest without stopping the walk", async () => {
    const { catalog, store } = world();
    const dir = mkdtempSync(join(tmpdir(), "ingest-dir-"));
    makeVideo(join(dir, "clip-a.mp4"), { seconds: 1 });
    makeVideo(join(dir, "clip-b.mp4"), { seconds: 1 });
    writeFileSync(join(dir, "notes.txt"), "not a video");
    writeFileSync(join(dir, ".hidden.mp4"), "hidden, ignored even though it looks like a video");

    const original = catalog.ingest.bind(catalog);
    (catalog as unknown as { ingest: typeof catalog.ingest }).ingest = (async (p) => {
      if (p.path.endsWith("clip-b.mp4")) throw new Error("simulated ffprobe failure");
      return original(p);
    }) as typeof catalog.ingest;

    const report = await catalog.ingestDirectory({ dir, recursive: false, collection: "shoot-a", rights_status: "cleared" });

    expect(report.ingested).toHaveLength(1);
    expect(basename(report.ingested[0]!.source.original_uri)).toBe("clip-a.mp4");
    expect(report.ingested[0]!.source.collection).toBe("shoot-a");
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.path.endsWith("clip-b.mp4")).toBe(true);
    expect(report.skipped[0]!.why).toContain("simulated ffprobe failure");
    expect(store.listSourceItems({ collection: "shoot-a" })).toHaveLength(1);
  });

  it("only descends into subdirectories when --recursive is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ingest-dir-rec-"));
    // distinct sizes so the two generated clips are not byte-identical (same checksum would dedup them
    // together and defeat the "both files are actually registered" assertion below)
    makeVideo(join(dir, "top.mp4"), { seconds: 1, size: "320x180" });
    mkdirSync(join(dir, "sub"));
    makeVideo(join(dir, "sub", "nested.mp4"), { seconds: 1, size: "160x90" });

    const shallow = world();
    const shallowReport = await shallow.catalog.ingestDirectory({ dir, recursive: false });
    expect(shallowReport.ingested).toHaveLength(1);
    expect(basename(shallowReport.ingested[0]!.source.original_uri)).toBe("top.mp4");

    const deep = world();
    const deepReport = await deep.catalog.ingestDirectory({ dir, recursive: true });
    expect(deepReport.ingested).toHaveLength(2);
    expect(deepReport.ingested.map((i) => basename(i.source.original_uri)).sort()).toEqual(["nested.mp4", "top.mp4"]);
  });

  it("recognises .mov/.mkv/.m4v/.avi/.webm case-insensitively", async () => {
    const { catalog } = world();
    const dir = mkdtempSync(join(tmpdir(), "ingest-dir-ext-"));
    writeFileSync(join(dir, "a.MOV"), "mov bytes");
    writeFileSync(join(dir, "b.mkv"), "mkv bytes");
    writeFileSync(join(dir, "c.m4v"), "m4v bytes");
    writeFileSync(join(dir, "d.avi"), "avi bytes");
    writeFileSync(join(dir, "e.webm"), "webm bytes");
    writeFileSync(join(dir, "f.jpg"), "jpg bytes"); // not a video extension

    const report = await catalog.ingestDirectory({ dir, recursive: false });
    expect(report.ingested).toHaveLength(5);
    expect(report.ingested.map((i) => basename(i.source.original_uri)).sort()).toEqual(["a.MOV", "b.mkv", "c.m4v", "d.avi", "e.webm"].sort());
  });

  it("an empty directory is not an error", async () => {
    const { catalog } = world();
    const dir = mkdtempSync(join(tmpdir(), "ingest-dir-empty-"));
    const report = await catalog.ingestDirectory({ dir, recursive: false });
    expect(report).toEqual({ ingested: [], skipped: [] });
  });

  it("throws NOT_FOUND when the directory does not exist", async () => {
    const { catalog } = world();
    try {
      await catalog.ingestDirectory({ dir: join(tmpdir(), "does-not-exist-xyz-123"), recursive: false });
      throw new Error("no throw");
    } catch (e) {
      expect(isHarnessError(e, "NOT_FOUND")).toBe(true);
    }
  });
});
