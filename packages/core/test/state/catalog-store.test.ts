import { describe, expect, it } from "vitest";
import { newId, type ContentItem, type ContentVariant, type SourceItem } from "@harness/contracts";
import { openTempStore } from "../helpers.js";

const now = "2026-09-12T00:00:00.000Z";
const sha = (c: string) => "sha256:" + c.repeat(64);
const src = (checksum: string): SourceItem => ({ schema_version: "harness.source-item/v1", source_id: newId("source_item"), uri: "file:///n/a.mp4", original_uri: "file:///r/a.mp4", checksum, collection: "main", mime_type: "video/mp4", size_bytes: 1, media: null, rights_status: "unknown", language: null, duration_seconds: null, ingested_at: now });

describe("catalog tables", () => {
  it("migration 0002 adds the three catalog tables", () => {
    const { store } = openTempStore();
    expect(store.tableNames()).toEqual(expect.arrayContaining(["source_item", "content_item", "content_variant"]));
  });
  it("stores sources and finds them by checksum", () => {
    const { store } = openTempStore();
    const a = src(sha("a")); store.insertSourceItem(a);
    expect(store.getSourceItem(a.source_id)).toEqual(a);
    expect(store.findSourceItemByChecksum(sha("a"))?.source_id).toBe(a.source_id);
    expect(store.findSourceItemByChecksum(sha("b"))).toBeUndefined();
    store.insertSourceItem({ ...src(sha("c")), collection: "archive" });
    expect(store.listSourceItems({ collection: "main" })).toHaveLength(1);
    expect(store.listSourceItems()).toHaveLength(2);
  });
  it("stores content and variants keyed by content/profile/revision/options", () => {
    const { store } = openTempStore();
    const content: ContentItem = { schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [newId("source_item")], revision: 1, title: "t", created_at: now };
    store.insertContentItem(content);
    store.updateContentItem({ ...content, revision: 2, title: "t2" });
    expect(store.getContentItem(content.content_id)?.revision).toBe(2);
    expect(store.listContentItems()).toHaveLength(1);
    const v: ContentVariant = { schema_version: "harness.content-variant/v1", variant_id: newId("content_variant"), content_id: content.content_id, profile_id: "footage", profile_revision: 1, options: { voice: "tts" }, options_digest: sha("d"), created_at: now };
    store.insertContentVariant(v);
    expect(store.findContentVariant({ content_id: content.content_id, profile_id: "footage", profile_revision: 1, options_digest: sha("d") })?.variant_id).toBe(v.variant_id);
    expect(store.findContentVariant({ content_id: content.content_id, profile_id: "footage", profile_revision: 2, options_digest: sha("d") })).toBeUndefined();
    expect(() => store.insertContentVariant({ ...v, variant_id: newId("content_variant") })).toThrow(/UNIQUE/);
    expect(store.listContentVariants(content.content_id)).toHaveLength(1);
  });
});
