/**
 * A shot-cut episode in process, shared by the phase 5 tests: the fake Claude cutting with plan-cut, ag-go clips of
 * four solid colours made by ffmpeg (four shots each), the fake farm reading narration. Needs ffmpeg + ffprobe
 * (FFMPEG_PATH / FFPROBE_PATH may point at any build): gate the describe on `hasFfmpeg()`.
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStudioWorker, listEpisodes, startPlanRun, type CutMediaDeps,
} from "../src/index.js";
import { approvePlanGatesUntil, FAKE_CLAUDE, fakeFarm, fakeFootage, fakeThumbnails, ROOT, seedProduction, world } from "./helpers.js";
import { makeSceneClip } from "../../../tests/media.js";

export { hasFfmpeg } from "../../../tests/media.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
export const VOICE = { reference: "library:voices/mai.wav", reference_text: "Xin chào, tôi là Mai.", speed: 1 };

export function cutSetup() {
  const w = world();
  const farm = fakeFarm(w.bucket);
  const clips = mkdtempSync(join(tmpdir(), "ag-go-clips-"));
  const media: CutMediaDeps = {
    ffmpeg: FFMPEG, ffprobe: FFPROBE, voiceDir: join(w.dir, "voice"),
    // ag-go: every asset is a 20 s clip of four solid colours (four shots), with sound
    resolveAssets: async (_actAs, ids) => ({
      items: ids.map((id) => {
        const path = join(clips, `${id}.mp4`);
        makeSceneClip(path, { seconds: 20, colors: ["black", "white", "gray", "navy"] });
        return { assetId: id, url: path, sourceKind: "proxy" as const, watermarked: false };
      }),
      missing: [],
    }),
    download: async (url, dest) => { copyFileSync(url, dest); },
  };
  const claude = { skillsDir: join(ROOT, "skills"), argv: ["node", FAKE_CLAUDE], model: "fake", maxTurns: 3 };
  const worker = createStudioWorker({
    core: w.core, db: w.db, dbPath: w.dbPath, bucket: w.bucket, footage: fakeFootage(2, 20), farm: farm as never,
    claude, owner: "auth0|owner", thumbnails: fakeThumbnails(), media, farmPollMs: 5,
  });
  return { ...w, farm, worker, media, claude };
}
export type CutSetup = ReturnType<typeof cutSetup>;

export async function drain(s: CutSetup): Promise<void> {
  for (let i = 0; i < 600; i++) if ((await s.worker.runOnce()) === "idle") return;
  throw new Error("worker still busy");
}

export const waiting = (s: CutSetup, runId: string) =>
  s.core.store.listStageRuns(runId).filter((x) => x.state === "WAITING_HUMAN").map((x) => x.stage_key);

/**
 * A series of one 16 s shot-cut episode, its plan approved as Claude wrote it: the episode run is waiting at
 * `approve-survey`. Set FAKE_STUDIO_MODE=plan-cut before calling.
 */
export async function cutEpisodeAtSurvey(s: CutSetup) {
  const prod = seedProduction(s.db, { episode_target_seconds: 16, max_episodes: 1 });
  s.db.run("UPDATE productions SET keywords = ?, voice = ? WHERE id = ?", [JSON.stringify(["phố cổ"]), JSON.stringify(VOICE), prod]);
  startPlanRun(s.core, s.db, prod);
  await approvePlanGatesUntil(s, prod, () => drain(s), null);
  await drain(s);
  const ep = listEpisodes(s.db, prod)[0]!;
  return { prod, ep, runId: ep.run_id! };
}
