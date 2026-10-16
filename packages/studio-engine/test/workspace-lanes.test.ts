/**
 * How many project jobs run at once: the worker's own lanes plus one per idle farm machine (capped), read again each
 * tick of the job loop; and the decode turns prepare jobs share on the worker.
 */
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createJob, createJobRunner, createProject, farmLanes, idleFarmNodes, seedWorkspace, studioLogger, type JobHandler, type ProjectFarm,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";
type Node = Awaited<ReturnType<NonNullable<ProjectFarm["listNodes"]>>>["nodes"][number];
const node = (over: Partial<Node>): Node => ({
  id: "00000000-0000-4000-8000-000000000001", name: "may-1", online: true, kinds: ["studio.transcribe"], gpus: [], running_jobs: 0, last_seen_at: NOW, ...over,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); };

describe("idle farm machines", () => {
  it("counts machines online, running nothing, that take a Studio job type", () => {
    expect(idleFarmNodes([
      node({}), node({ running_jobs: 1 }), node({ online: false }), node({ kinds: ["harness.render" as never] }), node({ kinds: ["studio.render_final"] }),
    ])).toBe(2);
  });
});

describe("job lanes from the farm", () => {
  it("adds one lane per idle machine up to the cap, and falls back to its own lanes when the farm does not answer", async () => {
    let clock = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      let nodes: Node[] = [node({}), node({}), node({})];
      let fail = false;
      const errors: unknown[] = [];
      const farm = { listNodes: async () => { if (fail) throw new Error("farm down"); return { nodes }; } } as unknown as ProjectFarm;
      const lanes = farmLanes({ farm, base: 2, max: 4, everyMs: 1000, onError: (e) => errors.push(e) });
      // the farm is read in the background: the tick does not wait for it, the next one sees it
      const after = async () => { clock += 1000; lanes(); await flush(); return lanes(); };
      expect(lanes()).toBe(2);
      await flush();
      expect(lanes()).toBe(4); // 2 + 3 idle, capped at 4
      nodes = [node({}), node({ running_jobs: 2 })];
      expect(await after()).toBe(3);
      fail = true;
      expect(await after()).toBe(2);
      expect(errors).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not ask the farm again before everyMs", async () => {
    let reads = 0;
    const farm = { listNodes: async () => { reads++; return { nodes: [node({})] }; } } as unknown as ProjectFarm;
    const lanes = farmLanes({ farm, base: 1, max: 8, everyMs: 60_000 });
    lanes();
    await flush();
    expect(lanes()).toBe(2);
    lanes();
    expect(reads).toBe(1);
  });
});

describe("job runner with lanes that change", () => {
  it("starts more jobs when more lanes open, and none while running ones fill them", async () => {
    const w = await world();
    await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?) ON CONFLICT DO NOTHING", [NOW, NOW]);
    const project = await createProject(w.db, "team-1", { name: "Kênh", description: "", language: "vi", aspect: "16:9" }, "auth0|u", NOW);
    const workspacesRoot = join(w.dir, "workspaces");
    seedWorkspace(workspacesRoot, project);
    for (let i = 0; i < 5; i++) await createJob(w.db, { projectId: project.id, kind: "prepare_asset", title: `Chuẩn bị ${i}`, request: { asset_id: `a${i}` }, createdBy: "u" }, NOW);
    const release: (() => void)[] = [];
    const handler: JobHandler = () => new Promise((res) => release.push(() => res({ result: null })));
    let lanes = 2;
    const runner = createJobRunner({
      db: w.db, logger: studioLogger({ test: "lanes" }), workspacesRoot, dataRoot: join(w.dir, "data"), handlers: { prepare_asset: handler }, lanes: () => lanes,
    });
    expect(await runner.tick()).toHaveLength(2);
    expect(await runner.tick()).toHaveLength(0);
    lanes = 4;
    expect(await runner.tick()).toHaveLength(2);
    expect(runner.running()).toHaveLength(4);
    lanes = 1;
    expect(await runner.tick()).toHaveLength(0);
    await until(() => release.length === 4);
    while (release.length) release.shift()!();
    await runner.idle();
    expect(await runner.tick()).toHaveLength(1);
    await until(() => release.length === 1);
    while (release.length) release.shift()!();
    await runner.idle();
    await w.db.close();
  });
});
