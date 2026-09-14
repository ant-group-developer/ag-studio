import { describe, expect, it } from "vitest";
import { newId, type ContentRequest, type EditStyle, type LibraryItem } from "@harness/contracts";
import { openTempStore } from "../helpers.js";

const now = "2026-09-14T00:00:00.000Z";
const later = "2026-09-14T01:00:00.000Z";
const sha = (c: string) => "sha256:" + c.repeat(64);

const editStyle = (overrides: Partial<EditStyle> = {}): EditStyle => ({
  schema_version: "harness.edit-style/v1",
  style_id: newId("edit_style"),
  revision: 1,
  name: "vlog-fast",
  status: "draft",
  learned_from: [],
  params: {
    cut_rhythm: "fast", shot_seconds: [2, 6], transitions: [],
    text_overlay: { style: "bold-center", density: "medium" },
    subtitles: "burn-in", music: { mood: "upbeat", ducking: true },
    opening: { seconds: 5, structure: "hook-then-title" }, aspect_ratio: "16:9", pace_notes: "",
  },
  evidence: [],
  created_at: now, updated_at: now,
  ...overrides,
});

const contentRequest = (overrides: Partial<ContentRequest> = {}): ContentRequest => ({
  schema_version: "harness.content-request/v1",
  request_id: newId("content_request"),
  requested_by: { portfolio_id: "pf" },
  topic: "chợ nổi",
  voice: "none", language: "vi", count: 1,
  status: "open",
  item_ids: [], notes: "",
  created_at: now, updated_at: now,
  ...overrides,
});

const libraryItem = (overrides: Partial<LibraryItem> = {}): LibraryItem => ({
  schema_version: "harness.library-item/v1",
  item_id: newId("library_item"),
  status: "pending_review",
  title_hint: "", summary: "",
  style: { style_id: newId("edit_style"), revision: 1 },
  duration_seconds: 12.5,
  media: null,
  files: [{ path: "episode.mp4", checksum: sha("a"), size_bytes: 1, mime_type: "video/mp4" }],
  lineage: { project_id: "studio", run_id: newId("run"), content_id: newId("content_item"), source_ids: [] },
  review: { note: "" },
  created_at: now, updated_at: now,
  ...overrides,
});

describe("library tables", () => {
  it("migration 0003 adds the three library-mirror tables", () => {
    const { store } = openTempStore();
    expect(store.tableNames()).toEqual(expect.arrayContaining(["edit_style", "content_request", "library_item"]));
  });

  it("upserts edit styles, keeping the latest revision and filtering by status", () => {
    const { store } = openTempStore();
    const id = newId("edit_style");
    store.upsertEditStyle(editStyle({ style_id: id, revision: 1, status: "draft" }));
    store.upsertEditStyle(editStyle({ style_id: id, revision: 2, status: "active", updated_at: later }));
    expect(store.getEditStyle(id)?.revision).toBe(2);
    const other = editStyle({ status: "retired" });
    store.upsertEditStyle(other);
    expect(store.listEditStyles({ status: "active" })).toEqual([store.getEditStyle(id)]);
    expect(store.listEditStyles()).toHaveLength(2);
    expect(store.getEditStyle(newId("edit_style"))).toBeUndefined();
  });

  it("upserts content requests, keeping the latest write and filtering by status", () => {
    const { store } = openTempStore();
    const id = newId("content_request");
    store.upsertContentRequest(contentRequest({ request_id: id, status: "open" }));
    store.upsertContentRequest(contentRequest({ request_id: id, status: "claimed", updated_at: later }));
    expect(store.getContentRequest(id)?.status).toBe("claimed");
    const other = contentRequest({ status: "fulfilled" });
    store.upsertContentRequest(other);
    expect(store.listContentRequests({ status: "claimed" })).toEqual([store.getContentRequest(id)]);
    expect(store.listContentRequests()).toHaveLength(2);
    expect(store.getContentRequest(newId("content_request"))).toBeUndefined();
  });

  it("upserts library items, keeping the latest write and filtering by status", () => {
    const { store } = openTempStore();
    const id = newId("library_item");
    store.upsertLibraryItem(libraryItem({ item_id: id, status: "pending_review" }));
    store.upsertLibraryItem(libraryItem({ item_id: id, status: "approved", updated_at: later }));
    expect(store.getLibraryItem(id)?.status).toBe("approved");
    const other = libraryItem({ status: "rejected" });
    store.upsertLibraryItem(other);
    expect(store.listLibraryItems({ status: "approved" })).toEqual([store.getLibraryItem(id)]);
    expect(store.listLibraryItems()).toHaveLength(2);
    expect(store.getLibraryItem(newId("library_item"))).toBeUndefined();
  });
});
