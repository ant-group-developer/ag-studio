import { describe, expect, it } from "vitest";
import { ContentRequestSchema, EditStyleSchema, LibraryClaimSchema, LibraryItemSchema, ContentItemSchema, ProjectConfigSchema, newId } from "../src/index.js";

const NOW = "2026-09-14T00:00:00.000Z";
const SHA = "sha256:" + "a".repeat(64);
export const style = () => ({ schema_version: "harness.edit-style/v1", style_id: newId("edit_style"), revision: 1, name: "vlog-fast", status: "active", params: { cut_rhythm: "fast", shot_seconds: [2, 6], text_overlay: { style: "bold-center", density: "medium" }, subtitles: "burn-in", music: { mood: "upbeat", ducking: true }, opening: { seconds: 5, structure: "hook-then-title" }, aspect_ratio: "16:9" }, created_at: NOW, updated_at: NOW });
describe("library contracts", () => {
  it("edit style defaults and rejects a bad aspect ratio", () => {
    const s = EditStyleSchema.parse(style());
    expect(s).toMatchObject({ learned_from: [], evidence: [], params: { transitions: [], pace_notes: "" } });
    expect(EditStyleSchema.safeParse({ ...style(), params: { ...style().params, aspect_ratio: "wide" } }).success).toBe(false);
  });
  it("content request defaults voice/language/count/item_ids", () => {
    const r = ContentRequestSchema.parse({ schema_version: "harness.content-request/v1", request_id: newId("content_request"), requested_by: { portfolio_id: "pf" }, topic: "chợ nổi", status: "open", created_at: NOW, updated_at: NOW });
    expect(r).toMatchObject({ voice: "none", language: "vi", count: 1, item_ids: [], notes: "" });
    // count is pinned to 1 until a re-claim mechanism exists: one request, one item, one run
    expect(ContentRequestSchema.safeParse({ ...r, count: 2 }).success).toBe(false);
  });
  it("library item needs at least one file and a style snapshot; claim is strict", () => {
    const base = { schema_version: "harness.library-item/v1", item_id: newId("library_item"), status: "pending_review", style: { style_id: newId("edit_style"), revision: 1 }, duration_seconds: 12.5, media: null, lineage: { project_id: "studio", run_id: newId("run"), content_id: newId("content_item"), source_ids: [] }, created_at: NOW, updated_at: NOW };
    expect(LibraryItemSchema.safeParse({ ...base, files: [] }).success).toBe(false);
    expect(LibraryItemSchema.parse({ ...base, files: [{ path: "episode.mp4", checksum: SHA, size_bytes: 1, mime_type: "video/mp4" }] }).review).toEqual({ note: "" });
    expect(LibraryClaimSchema.safeParse({ schema_version: "harness.library-claim/v1", item_id: base.item_id, channel_id: "c1", portfolio_id: "pf", claimed_at: NOW, extra: 1 }).success).toBe(false);
  });
  it("content item carries an optional brief; project config validates library", () => {
    const c = ContentItemSchema.parse({ schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [], revision: 1, title: "t", created_at: NOW, library_brief: { topic: "x", style_id: newId("edit_style"), style_revision: 1 } });
    expect(c.library_brief).toMatchObject({ voice: "none", language: "vi" });
    const picked = ContentItemSchema.parse({ schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [], revision: 1, title: "t", created_at: NOW, library_item_id: newId("library_item"), library_channel_id: "channel-one" });
    expect(picked.library_channel_id).toBe("channel-one");
    const p = ProjectConfigSchema.parse({ schema_version: "harness.project-config/v1", project_id: "p", template_release: "0.1.0", runtime: "claude", data_root: "./data", portfolios: [{ portfolio_id: "pf", display_name: "x" }], library: { root: "E:/lib", role: "studio" } });
    expect(p.library).toEqual({ root: "E:/lib", role: "studio", sync_seconds: 300 });
    expect(ProjectConfigSchema.safeParse({ ...p, library: { root: "x", role: "viewer" } }).success).toBe(false);
  });
});
