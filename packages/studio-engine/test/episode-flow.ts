/** A chat-first series (plan 3.0.0) with one episode 1.3.0, driven in process with the fake Claude and farm. */
import { join } from "node:path";
import { expect } from "vitest";
import { createStudioWorker, listEpisodes, startPlanRun } from "../src/index.js";
import { approvePlanGatesUntil, FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";

export function setup() {
  const w = world();
  const farm = fakeFarm(w.bucket);
  const worker = createStudioWorker({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(4, 30), farm: farm as never,
    claude: { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 },
    owner: "auth0|owner", thumbnails: fakeThumbnails(),
  });
  return { ...w, worker, farm };
}
export type Setup = ReturnType<typeof setup>;

export async function drain(s: Setup): Promise<void> {
  for (let i = 0; i < 400; i++) if ((await s.worker.runOnce()) === "idle") return;
  throw new Error("worker still busy");
}

/** Every plan gate approved as Claude proposed it; returns the one episode, waiting at approve-timeline. */
export async function oneEpisode(s: Setup) {
  const prod = seedProduction(s.db, { episode_target_seconds: 60, max_episodes: 1 });
  s.db.run("UPDATE productions SET keywords = ? WHERE id = ?", [JSON.stringify(["phở sáng"]), prod]);
  startPlanRun(s.core, s.db, prod);
  const approved = await approvePlanGatesUntil(s, prod, () => drain(s), null);
  expect(approved.at(-1)).toBe("approve-plan");
  await drain(s);
  return listEpisodes(s.db, prod)[0]!;
}
