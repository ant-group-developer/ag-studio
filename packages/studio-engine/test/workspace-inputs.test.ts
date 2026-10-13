import { describe, expect, it, vi } from "vitest";
import { addSource, assetCounts, assetState, claimJob, createProject, queuePrepare, savePrepared, sourceItems } from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-12T08:00:00.000Z";

function setup() {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW);
  return { ...w, project };
}

const prepared = (projectId: string, assetId: string, status: "ready" | "failed") => ({
  project_id: projectId, asset_id: assetId, status, name: assetId, duration_s: 10, width: 1920, height: 1080, has_audio: 1, shots: 4, transcript: 0,
  source_kind: null, watermarked: null, error: status === "failed" ? "hỏng" : null,
});

describe("the sources list for many videos", () => {
  it("is one pass however many videos and jobs there are, and counts each video once by where it stands", () => {
    const s = setup();
    const pid = s.project.id;
    const ids = Array.from({ length: 120 }, (_, i) => `a${i}`);
    for (const id of ids) addSource(s.db, { projectId: pid, kind: "ag_go_asset", ref: id, mediaType: "video", label: `clip ${id}`, addedBy: "u" }, NOW);
    // the same video picked for a video as well: counted once
    s.db.run("INSERT INTO videos (id, project_id, idx, title, status, created_by, created_at, updated_at) VALUES ('v1', ?, 1, 'Huế', 'draft', 'u', ?, ?)", [pid, NOW, NOW]);
    addSource(s.db, { projectId: pid, videoId: "v1", kind: "ag_go_asset", ref: "a0", mediaType: "video", label: "clip a0", addedBy: "u" }, NOW);
    for (let i = 0; i < 110; i += 40) queuePrepare(s.db, { projectId: pid, assetIds: ids.slice(i, Math.min(i + 40, 110)), createdBy: "u" }, NOW);
    claimJob(s.db, ["prepare_asset"], NOW);
    for (const id of ["a110", "a111", "a112", "a113", "a114"]) savePrepared(s.db, prepared(pid, id, "ready"), NOW);
    for (const id of ["a115", "a116"]) savePrepared(s.db, prepared(pid, id, "failed"), NOW);

    const all = vi.spyOn(s.db, "all");
    const get = vi.spyOn(s.db, "get");
    const items = sourceItems(s.db, pid);
    expect(all.mock.calls.length + get.mock.calls.length).toBeLessThanOrEqual(4);
    all.mockRestore();
    get.mockRestore();

    expect(items).toHaveLength(121);
    expect(assetCounts(items)).toEqual({ videos: 120, ready: 5, preparing: 110, failed: 2, notPrepared: 3 });
    expect(new Set(items.filter((x) => x.asset?.state === "preparing").map((x) => x.ref)).size).toBe(1);
    // past the first hundred jobs, a video in line is still seen as in line (not "not prepared")
    for (const id of ids.slice(0, 110)) expect(["queued", "preparing"]).toContain(assetState(s.db, pid, id).state);
    expect(items.find((x) => x.ref === "a0")!.asset).toEqual(assetState(s.db, pid, "a0"));
  });

  it("queues a video once even when asked twice in one call", () => {
    const s = setup();
    const pid = s.project.id;
    addSource(s.db, { projectId: pid, kind: "ag_go_asset", ref: "a1", mediaType: "video", label: "clip", addedBy: "u" }, NOW);
    const r = queuePrepare(s.db, { projectId: pid, assetIds: ["a1", "a1", "zz"], createdBy: "u" }, NOW);
    expect(r).toEqual({ a1: expect.objectContaining({ state: "queued" }), zz: { state: "not_an_input" } });
    expect(s.db.all("SELECT id FROM project_jobs WHERE project_id = ?", [pid])).toHaveLength(1);
  });
});
