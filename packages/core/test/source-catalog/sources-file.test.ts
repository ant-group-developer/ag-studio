import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSourcesRegistry, NullMediaProber, SourceCatalog, SOURCES_FILE, syncSources } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-"));
  mkdirSync(join(dir, "raw"), { recursive: true });
  writeFileSync(join(dir, "raw", "present.mp4"), "present bytes");
  mkdirSync(join(dir, "source-catalog"), { recursive: true });
  writeFileSync(
    join(dir, SOURCES_FILE),
    [
      "schema_version: harness.sources/v1",
      "sources:",
      "  - { path: raw/present.mp4, collection: main, rights_status: cleared, language: en }",
      "  - { path: raw/missing.mp4, collection: main }",
      "",
    ].join("\n"),
  );
  return dir;
}

describe("syncSources", () => {
  it("adds new sources, reports missing files, and flags DB rows the registry does not cover", async () => {
    const { store, dir, clock } = openTempStore();
    const projectDir = project();
    const catalog = new SourceCatalog({ store, dataRoot: dir, prober: new NullMediaProber(), clock, materialize: "copy" });

    // a source ingested by hand, unrelated to sources.yaml
    const otherRaw = mkdtempSync(join(tmpdir(), "other-"));
    const otherFile = join(otherRaw, "other.mp4");
    writeFileSync(otherFile, "other bytes");
    const { source: other } = await catalog.ingest({ path: otherFile });

    const registry = loadSourcesRegistry(projectDir)!;
    expect(registry.sources).toHaveLength(2);

    const first = await syncSources({ catalog, store, projectDir, registry });
    expect(first.added).toHaveLength(1);
    expect(first.added[0]?.path).toBe("raw/present.mp4");
    expect(first.already).toHaveLength(0);
    expect(first.missing_files).toEqual(["raw/missing.mp4"]);
    expect(first.unregistered).toEqual([{ source_id: other.source_id, uri: other.uri }]);

    const second = await syncSources({ catalog, store, projectDir, registry });
    expect(second.added).toHaveLength(0);
    expect(second.already).toHaveLength(1);
    expect(second.already[0]?.path).toBe("raw/present.mp4");
    expect(second.missing_files).toEqual(["raw/missing.mp4"]);
    expect(second.unregistered).toEqual([{ source_id: other.source_id, uri: other.uri }]);
  });

  it("loadSourcesRegistry returns undefined when the project has no sources.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-sources-"));
    expect(loadSourcesRegistry(dir)).toBeUndefined();
  });
});
