import { start } from "@harness/script-sdk";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg } from "./_media.mjs";

const ctx = await start();
const clipSetDir = ctx.input("clip_set");
const clips = readdirSync(clipSetDir)
  .filter((f) => f.endsWith(".mp4"))
  .sort()
  .map((f) => join(clipSetDir, f));

const concatPath = join(ctx.workspace, "concat.txt");
writeFileSync(concatPath, clips.map((p) => `file '${p.split("\\").join("/")}'`).join("\n") + "\n");

if (ctx.hasInput("avatar_clips")) {
  ctx.log.info("avatar clips present; overlay not simulated by the fake assemble wrapper", { avatar_clips: ctx.input("avatar_clips") });
}

const outPath = join(ctx.workspace, "output", "full-episode.mp4");
const args = ["-y", "-f", "concat", "-safe", "0", "-i", concatPath];
if (ctx.hasInput("voice_track")) {
  args.push("-i", ctx.input("voice_track"), "-map", "0:v", "-map", "1:a", "-shortest");
} else {
  args.push("-map", "0:v", "-map", "0:a?");
}
args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", outPath);
ffmpeg(args);

await ctx.out.file("output/full-episode.mp4", { type: "episode_video" });
ctx.log.info("assemble done", { clips: clips.length });
await ctx.done({ cost_usd: 0 });
