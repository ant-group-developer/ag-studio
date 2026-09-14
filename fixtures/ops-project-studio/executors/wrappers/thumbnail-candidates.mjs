// library-production stage 8: one candidate thumbnail per cut (at most three), so `library-export` has a
// `thumbnail_set` directory to copy into the kho next to the episode.
import { start } from "@harness/script-sdk";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg } from "../../../ops-project-footage/executors/wrappers/_media.mjs";

const ctx = await start();

const clipSetDir = ctx.input("clip_set");
const clips = readdirSync(clipSetDir)
  .filter((f) => f.endsWith(".mp4"))
  .sort()
  .slice(0, 3);
if (clips.length === 0) {
  await ctx.fail("contract", `no cuts to draw thumbnails from in ${clipSetDir}`, { clip_set: clipSetDir });
  process.exit(0);
}

const thumbnailsDir = join(ctx.workspace, "output", "thumbnails");
mkdirSync(thumbnailsDir, { recursive: true });

for (const [i, clip] of clips.entries()) {
  const name = `thumbnail-${String(i + 1).padStart(2, "0")}.png`;
  ffmpeg(["-y", "-i", join(clipSetDir, clip), "-frames:v", "1", join(thumbnailsDir, name)]);
}

await ctx.out.dir("output/thumbnails", { type: "thumbnail_set" });
ctx.log.info("thumbnail candidates rendered", { count: clips.length });
await ctx.done({ cost_usd: 0 });
