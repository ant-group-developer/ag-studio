/**
 * Footage usage told to ag-go (plan 2026-10-13 P4): adding / removing an ag-go source writes its event once.
 */
import { afterEach, describe, expect, it } from "vitest";
import { addSource, createProject, createVideo, enqueueUsage, removeSource, type StudioDb, type UsageEvent } from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
const A1 = "0b9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d11";
const AGP = "2d9a7c34-5f1e-4d4c-9a51-3f2a1e0c7d33";

type Row = { event_key: string; payload: UsageEvent; sent_at: string | null; attempts: number; next_at: string };
const outbox = (db: StudioDb) => db.all<Row>("SELECT * FROM ag_go_usage_outbox ORDER BY event_key");
const payloads = async (db: StudioDb) => (await outbox(db)).map((r) => r.payload);

describe("ag-go sources write their usage", () => {
  let opened: StudioDb[] = [];
  afterEach(async () => { for (const db of opened) await db.close(); opened = []; });

  async function setup() {
    const w = await world();
    opened.push(w.db);
    await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
    const p = await createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "auth0|owner", NOW);
    const v = await createVideo(w.db, p.id, { title: "Tràng An", createdBy: "u" }, NOW);
    return { ...w, p, v };
  }

  it("an ag-go video or project added once is one event; a file upload is none", async () => {
    const { db, p, v } = await setup();
    const s = await addSource(db, { projectId: p.id, videoId: v.id, kind: "ag_go_asset", ref: A1, mediaType: "video", label: "A", meta: { agGoProjectId: AGP }, addedBy: "auth0|ed" }, NOW);
    const same = await addSource(db, { projectId: p.id, videoId: v.id, kind: "ag_go_asset", ref: A1, mediaType: "video", label: "A", addedBy: "auth0|other" }, "2026-10-11T00:00:00.000Z");
    expect(same).toEqual(s);
    expect(s.meta).toEqual({ agGoProjectId: AGP });
    const proj = await addSource(db, { projectId: p.id, kind: "ag_go_project", ref: AGP, mediaType: "mixed", label: "Ninh Bình", addedBy: "auth0|ed" }, NOW);
    await addSource(db, { projectId: p.id, kind: "upload", ref: "context/a.pdf", mediaType: "document", label: "a.pdf", addedBy: "auth0|ed" }, NOW);
    const events = new Map((await payloads(db)).map((e) => [e.eventKey, e]));
    expect([...events.keys()].sort()).toEqual([`src:${s.id}:added`, `src:${proj.id}:added`].sort());
    expect(events.get(`src:${s.id}:added`)).toEqual({
      eventKey: `src:${s.id}:added`, kind: "source_added", occurredAt: NOW, assetId: A1, agGoProjectId: AGP, studioProjectId: p.id,
      studioProjectName: "Du lịch chậm", studioVideoId: v.id, studioVideoTitle: "Tràng An", studioUserId: "auth0|ed",
    });
    expect(events.get(`src:${proj.id}:added`)).toMatchObject({ assetId: null, agGoProjectId: AGP, studioVideoId: null, studioVideoTitle: null });
    expect((await outbox(db)).every((r) => r.next_at === NOW && r.sent_at === null)).toBe(true);
  });

  it("the same source added twice at once is one source and one event", async () => {
    const { db, p, v } = await setup();
    const add = () => addSource(db, { projectId: p.id, videoId: v.id, kind: "ag_go_asset", ref: A1, mediaType: "video", label: "A", addedBy: "auth0|ed" }, NOW);
    const [a, b] = await Promise.all([add(), add()]);
    expect(a!.id).toBe(b!.id);
    expect((await payloads(db)).map((e) => e.eventKey)).toEqual([`src:${a!.id}:added`]);
  });

  it("removing one writes its own event, by who removed it; adding it back is a new source, a new event", async () => {
    const { db, p, v } = await setup();
    const s = await addSource(db, { projectId: p.id, videoId: v.id, kind: "ag_go_asset", ref: A1, mediaType: "video", label: "A", addedBy: "auth0|ed" }, NOW);
    await removeSource(db, s.id, "auth0|rm", "2026-10-11T00:00:00.000Z");
    await removeSource(db, s.id, "auth0|rm", "2026-10-12T00:00:00.000Z"); // gone already: nothing
    const again = await addSource(db, { projectId: p.id, videoId: v.id, kind: "ag_go_asset", ref: A1, mediaType: "video", label: "A", addedBy: "auth0|ed" }, NOW);
    const events = await payloads(db);
    expect(events.map((e) => e.eventKey).sort()).toEqual([`src:${s.id}:added`, `src:${s.id}:removed`, `src:${again.id}:added`].sort());
    expect(events.find((e) => e.kind === "source_removed")).toMatchObject({ occurredAt: "2026-10-11T00:00:00.000Z", assetId: A1, studioUserId: "auth0|rm", studioVideoTitle: "Tràng An" });
  });

  it("an event written again is left as it was", async () => {
    const { db, p } = await setup();
    const e: UsageEvent = {
      eventKey: "job:j:a", kind: "final_render", occurredAt: NOW, assetId: A1, agGoProjectId: null, studioProjectId: p.id, studioProjectName: "x",
      studioVideoId: null, studioVideoTitle: null, studioUserId: null,
    };
    expect(await enqueueUsage(db, [e], NOW)).toBe(1);
    expect(await enqueueUsage(db, [{ ...e, studioProjectName: "y" }], "2026-10-11T00:00:00.000Z")).toBe(0);
    expect(await payloads(db)).toEqual([e]);
  });
});
