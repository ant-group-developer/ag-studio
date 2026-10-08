import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDraftProduction, createStudioWorker, startPlanRun, studioOverview } from "../src/index.js";
import { FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

describe("studioOverview", () => {
  let w: ReturnType<typeof world> | undefined;
  afterEach(() => w?.core.close());

  it("groups each video a person can see by what it needs from them", async () => {
    w = world();
    const worker = createStudioWorker({
      core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(4, 30), farm: fakeFarm(w.bucket) as never,
      claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 }, owner: "auth0|owner", thumbnails: fakeThumbnails(),
    });
    const running = seedProduction(w.db, { id: "11111111-1111-4111-8111-111111111111" });
    w.db.run("UPDATE productions SET keywords = '[\"phở\"]'");
    const draft = createDraftProduction(w.db, "team-1", "auth0|owner", "2026-10-06T10:00:00.000Z");
    const now = new Date().toISOString();
    w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-2', 'Khác', ?, ?)", [now, now]);
    createDraftProduction(w.db, "team-2", "auth0|other", now);

    startPlanRun(w.core, w.db, running);
    expect(studioOverview(w.core, w.db, { userId: "auth0|owner", isAdmin: false }).map((p) => [p.id, p.group, p.step])).toEqual([
      [draft, "waiting_you", "intake"], [running, "running", "intake"],
    ]);
    for (let i = 0; i < 100; i++) if ((await worker.runOnce()) === "idle") break;
    const mine = studioOverview(w.core, w.db, { userId: "auth0|owner", isAdmin: false });
    expect(mine.find((p) => p.id === running)).toMatchObject({ group: "waiting_you", step: "approve-trend-report", episodes: [] });
    expect(studioOverview(w.core, w.db, { userId: "auth0|admin", isAdmin: true })).toHaveLength(3);
    expect(studioOverview(w.core, w.db, { userId: "auth0|nobody", isAdmin: false })).toEqual([]);
  }, 60_000);
});
