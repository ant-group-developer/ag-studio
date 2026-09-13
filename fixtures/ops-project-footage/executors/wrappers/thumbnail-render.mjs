import { start } from "@harness/script-sdk";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg } from "./_media.mjs";

const ctx = await start();
const clipSetDir = ctx.input("clip_set");
const firstCut = readdirSync(clipSetDir)
  .filter((f) => f.endsWith(".mp4"))
  .sort()[0];
if (!firstCut) throw new Error("no cuts found to render a thumbnail from");

const outPath = join(ctx.workspace, "output", "thumbnail.png");
ffmpeg(["-y", "-i", join(clipSetDir, firstCut), "-frames:v", "1", outPath]);

await ctx.out.file("output/thumbnail.png", { type: "thumbnail" });
ctx.log.info("thumbnail rendered", { source: firstCut });
await ctx.done({ cost_usd: 0 });
