import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isHarnessError, newId, ProductionProfileSchema } from "@harness/contracts";
import { SourceCatalog, NullMediaProber, normalizedDir } from "../../src/index.js";
import { sha256String } from "../../src/artifacts/checksum.js";
import { openTempStore } from "../helpers.js";

const profile = ProductionProfileSchema.parse({
  schema_version: "harness.production-profile/v1", profile_id: "footage", revision: 1, status: "active", workflow_release: "footage-production@1.0.0",
  options_schema: { voice: ["none", "tts", "original"], avatar: ["none", "heygen"] }, options_defaults: { voice: "none", avatar: "none" },
});
function world(materialize: "link" | "copy" | "reference" = "link") {
  const t = openTempStore();
  const raw = mkdtempSync(join(tmpdir(), "raw-"));
  const file = join(raw, "clip.mp4"); writeFileSync(file, "fake video bytes");
  const catalog = new SourceCatalog({ store: t.store, dataRoot: t.dir, prober: new NullMediaProber(), clock: t.clock, materialize });
  return { ...t, raw, file, catalog };
}

describe("SourceCatalog", () => {
  it("ingests a file once, normalises it and dedupes by checksum", async () => {
    const { store, dir, file, catalog } = world();
    const first = await catalog.ingest({ path: file, collection: "main", rights_status: "cleared" });
    expect(first.created).toBe(true);
    expect(first.source.checksum).toBe(sha256String("fake video bytes"));
    expect(first.source.mime_type).toBe("video/mp4");
    expect(first.source.size_bytes).toBe(16);
    expect(first.source.media).toBeNull();
    const norm = normalizedDir(dir, first.source.source_id);
    expect(existsSync(join(norm, "clip.mp4"))).toBe(true);
    expect(JSON.parse(readFileSync(join(norm, "source.json"), "utf8")).source_id).toBe(first.source.source_id);
    expect(fileURLToPath(first.source.uri)).toBe(join(norm, "clip.mp4"));
    const again = await catalog.ingest({ path: file });
    expect(again.created).toBe(false);
    expect(again.source.source_id).toBe(first.source.source_id);
    expect(store.listSourceItems()).toHaveLength(1);
  });
  it("reference mode keeps the original uri", async () => {
    const { file, catalog } = world("reference");
    const { source } = await catalog.ingest({ path: file });
    expect(fileURLToPath(source.uri)).toBe(file);
    expect(source.original_uri).toBe(source.uri);
  });
  it("verify reports sources whose bytes no longer match", async () => {
    const { file, catalog } = world("copy");
    const { source } = await catalog.ingest({ path: file });
    expect(await catalog.verify()).toEqual([{ source_id: source.source_id, ok: true, reason: null }]);
    writeFileSync(fileURLToPath(source.uri), "tampered");
    expect((await catalog.verify())[0]).toMatchObject({ ok: false, reason: expect.stringContaining("checksum") });
  });
  it("creates content and variants with validated, defaulted options", async () => {
    const { store, file, catalog } = world();
    const { source } = await catalog.ingest({ path: file });
    const content = catalog.createContent({ source_ids: [source.source_id], title: "Episode 1" });
    expect(store.getContentItem(content.content_id)?.title).toBe("Episode 1");
    const a = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: { voice: "tts" } });
    expect(a.created).toBe(true);
    expect(a.variant.options).toEqual({ voice: "tts", avatar: "none" });
    const b = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: { avatar: "none", voice: "tts" } });
    expect(b.created).toBe(false);
    expect(b.variant.variant_id).toBe(a.variant.variant_id);
    const c = catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: {} });
    expect(c.variant.variant_id).not.toBe(a.variant.variant_id);
    try { catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: { voice: "robot" } }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); }
    try { catalog.getOrCreateVariant({ content_id: content.content_id, profile, options: { colour: "red" } }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); }
    try { catalog.createContent({ source_ids: ["src_01J00000000000000000000000"], title: "x" }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "NOT_FOUND")).toBe(true); }
  });
  it("returns the existing source when a concurrent ingest already registered the same checksum", async () => {
    const { store, dir, file, catalog } = world();
    // simulate a racing ingest that landed between our hash and our insert
    const original = store.insertSourceItem.bind(store);
    let racedId = "";
    (store as { insertSourceItem: typeof store.insertSourceItem }).insertSourceItem = (s) => {
      if (!racedId) { const rival = { ...s, source_id: newId("source_item"), uri: s.original_uri }; racedId = rival.source_id; original(rival); }
      return original(s); // throws UNIQUE for the loser
    };
    const r = await catalog.ingest({ path: file });
    expect(r.created).toBe(false);
    expect(r.source.source_id).toBe(racedId);
    expect(store.listSourceItems()).toHaveLength(1);
    expect(existsSync(normalizedDir(dir, r.source.source_id))).toBe(false); // loser cleaned up its own normalized dir
    const loserDirs = readdirSync(join(dir, "sources", "normalized"));
    expect(loserDirs).toEqual([]);
  });
});
