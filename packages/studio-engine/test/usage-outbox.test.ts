/**
 * Footage usage told to ag-go (plan 2026-10-13 P4): migration 0040 fills the outbox from what Studio already has, and
 * adding / removing an ag-go source writes its event once.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, SqliteStateStore, SystemClock } from "@harness/core";
import { addSource, createProject, createVideo, enqueueUsage, removeSource, StudioDb, type UsageEvent } from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const A1 = "0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11";
const A2 = "1c9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d22";
const AGP = "2d9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d33";

type Row = { event_key: string; payload: string; sent_at: string | null; attempts: number; next_at: string };
const outbox = (db: StudioDb) => db.all<Row>("SELECT * FROM ag_go_usage_outbox ORDER BY event_key");
const payloads = (db: StudioDb) => outbox(db).map((r) => JSON.parse(r.payload) as UsageEvent);

describe("migration 0040 fills the outbox from what Studio has", () => {
  it("one event per ag-go source, and per ag-go video of each finished final render or Premiere export", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-migration-"));
    const before = join(dir, "migrations");
    mkdirSync(before);
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f < "0040")) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
    const dbPath = join(dir, "studio.db");
    const store = new SqliteStateStore(dbPath, new SystemClock());
    store.migrate(before);
    const db = new StudioDb(dbPath);
    db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
    const p = createProject(db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "auth0|owner", NOW);
    const v = createVideo(db, p.id, { title: "Tràng An", createdBy: "auth0|owner" }, NOW);
    const src = (id: string, kind: string, ref: string, videoId: string | null, meta: string) => db.run(
      "INSERT INTO project_sources (id, project_id, video_id, kind, ref, media_type, label, meta, added_by, added_at) VALUES (?, ?, ?, ?, ?, 'video', 'x', ?, 'auth0|ed', ?)",
      [id, p.id, videoId, kind, ref, meta, "2026-10-01T00:00:00.000Z"],
    );
    src("s1", "ag_go_asset", A1, v.id, JSON.stringify({ agGoProjectId: AGP }));
    src("s2", "ag_go_project", AGP, null, "{}");
    src("s3", "upload", "context/a.pdf", null, "{}");
    src("s4", "ag_go_asset", A2, null, "not json");
    const clip = (asset: string) => ({ clip_id: "C", asset_id: asset, in: 0, out: 1 });
    db.run("INSERT INTO video_revisions (id, video_id, revision, base_revision, data, author_id, created_at) VALUES ('r1', ?, 1, 0, ?, 'u', ?)",
      [v.id, JSON.stringify({ clips: [clip(A1), clip(A2), clip(A1)] }), NOW]);
    db.run("INSERT INTO video_revisions (id, video_id, revision, base_revision, data, author_id, created_at) VALUES ('r2', ?, 2, 1, ?, 'u', ?)",
      [v.id, JSON.stringify({ clips: [clip(A2)] }), NOW]);
    const job = (id: string, kind: string, status: string, request: unknown, result: unknown) => db.run(
      `INSERT INTO project_jobs (id, project_id, video_id, kind, status, title, request, result, created_by, created_at, finished_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 't', ?, ?, 'auth0|fin', ?, ?, ?)`,
      [id, p.id, v.id, kind, status, JSON.stringify(request), result === null ? null : JSON.stringify(result), NOW, "2026-10-02T00:00:00.000Z", NOW],
    );
    job("j1", "render_final", "done", { video_id: v.id, revision: 2 }, { revision: 1 }); // the result's revision wins
    job("j2", "export_premiere", "done", { video_id: v.id, revision: 2 }, null);
    job("j3", "render_final", "failed", { video_id: v.id, revision: 1 }, null);
    job("j4", "render_preview", "done", { video_id: v.id, revision: 1 }, { revision: 1 });

    store.migrate(MIGRATIONS_DIR);
    expect(outbox(db).map((r) => [r.event_key, r.sent_at, r.attempts])).toEqual([
      [`job:j1:${A1}`, null, 0], [`job:j1:${A2}`, null, 0], [`job:j2:${A2}`, null, 0],
      ["src:s1:added", null, 0], ["src:s2:added", null, 0], ["src:s4:added", null, 0],
    ]);
    const byKey = new Map(payloads(db).map((e) => [e.eventKey, e]));
    expect(byKey.get("src:s1:added")).toEqual({
      eventKey: "src:s1:added", kind: "source_added", occurredAt: "2026-10-01T00:00:00.000Z", assetId: A1, agGoProjectId: AGP,
      studioProjectId: p.id, studioProjectName: "Du lịch chậm", studioVideoId: v.id, studioVideoTitle: "Tràng An", studioUserId: "auth0|ed",
    });
    expect(byKey.get("src:s2:added")).toMatchObject({ assetId: null, agGoProjectId: AGP, studioVideoId: null, studioVideoTitle: null });
    expect(byKey.get("src:s4:added")).toMatchObject({ assetId: A2, agGoProjectId: null });
    expect(byKey.get(`job:j1:${A1}`)).toEqual({
      eventKey: `job:j1:${A1}`, kind: "final_render", occurredAt: "2026-10-02T00:00:00.000Z", assetId: A1, agGoProjectId: null,
      studioProjectId: p.id, studioProjectName: "Du lịch chậm", studioVideoId: v.id, studioVideoTitle: "Tràng An", studioUserId: "auth0|fin",
    });
    expect(byKey.get(`job:j2:${A2}`)).toMatchObject({ kind: "premiere_export" });
    store.close();
  });
});

describe("ag-go sources write their usage", () => {
  function setup() {
    const w = world();
    w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
    const p = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "auth0|owner", NOW);
    const v = createVideo(w.db, p.id, { title: "Tràng An", createdBy: "u" }, NOW);
    return { ...w, p, v };
  }

  it("an ag-go video or project added once is one event; a file upload is none", () => {
    const { db, p, v } = setup();
    const s = addSource(db, { projectId: p.id, videoId: v.id, kind: "ag_go_asset", ref: A1, mediaType: "video", label: "A", meta: { agGoProjectId: AGP }, addedBy: "auth0|ed" }, NOW);
    addSource(db, { projectId: p.id, videoId: v.id, kind: "ag_go_asset", ref: A1, mediaType: "video", label: "A", addedBy: "auth0|other" }, "2026-10-11T00:00:00.000Z");
    const proj = addSource(db, { projectId: p.id, kind: "ag_go_project", ref: AGP, mediaType: "mixed", label: "Ninh Bình", addedBy: "auth0|ed" }, NOW);
    addSource(db, { projectId: p.id, kind: "upload", ref: "context/a.pdf", mediaType: "document", label: "a.pdf", addedBy: "auth0|ed" }, NOW);
    const events = new Map(payloads(db).map((e) => [e.eventKey, e]));
    expect([...events.keys()].sort()).toEqual([`src:${s.id}:added`, `src:${proj.id}:added`].sort());
    expect(events.get(`src:${s.id}:added`)).toEqual({
      eventKey: `src:${s.id}:added`, kind: "source_added", occurredAt: NOW, assetId: A1, agGoProjectId: AGP, studioProjectId: p.id,
      studioProjectName: "Du lịch chậm", studioVideoId: v.id, studioVideoTitle: "Tràng An", studioUserId: "auth0|ed",
    });
    expect(events.get(`src:${proj.id}:added`)).toMatchObject({ assetId: null, agGoProjectId: AGP, studioVideoId: null, studioVideoTitle: null });
    expect(outbox(db).every((r) => r.next_at === NOW && r.sent_at === null)).toBe(true);
  });

  it("removing one writes its own event, by who removed it; adding it back is a new source, a new event", () => {
    const { db, p, v } = setup();
    const s = addSource(db, { projectId: p.id, videoId: v.id, kind: "ag_go_asset", ref: A1, mediaType: "video", label: "A", addedBy: "auth0|ed" }, NOW);
    removeSource(db, s.id, "auth0|rm", "2026-10-11T00:00:00.000Z");
    removeSource(db, s.id, "auth0|rm", "2026-10-12T00:00:00.000Z"); // gone already: nothing
    const again = addSource(db, { projectId: p.id, videoId: v.id, kind: "ag_go_asset", ref: A1, mediaType: "video", label: "A", addedBy: "auth0|ed" }, NOW);
    const events = payloads(db);
    expect(events.map((e) => e.eventKey).sort()).toEqual([`src:${s.id}:added`, `src:${s.id}:removed`, `src:${again.id}:added`].sort());
    expect(events.find((e) => e.kind === "source_removed")).toMatchObject({ occurredAt: "2026-10-11T00:00:00.000Z", assetId: A1, studioUserId: "auth0|rm", studioVideoTitle: "Tràng An" });
  });

  it("an event written again is left as it was", () => {
    const { db, p } = setup();
    const e: UsageEvent = {
      eventKey: "job:j:a", kind: "final_render", occurredAt: NOW, assetId: A1, agGoProjectId: null, studioProjectId: p.id, studioProjectName: "x",
      studioVideoId: null, studioVideoTitle: null, studioUserId: null,
    };
    expect(enqueueUsage(db, [e], NOW)).toBe(1);
    expect(enqueueUsage(db, [{ ...e, studioProjectName: "y" }], "2026-10-11T00:00:00.000Z")).toBe(0);
    expect(payloads(db)).toEqual([e]);
  });
});
