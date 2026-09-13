import { start } from "@harness/script-sdk";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg, fileUrlToPath, probeDuration } from "./_media.mjs";

const ctx = await start();
const src = ctx.source(0);
const path = fileUrlToPath(src.uri);
const duration = src.duration_seconds ?? probeDuration(path);
writeFileSync(
  join(ctx.workspace, "output", "shots.json"),
  JSON.stringify(
    {
      source_id: src.source_id,
      duration_seconds: duration,
      shots: [
        { in: 0, out: duration / 2 },
        { in: duration / 2, out: duration },
      ],
      transcript: null,
    },
    null,
    2,
  ),
);
ffmpeg(["-y", "-i", path, "-vf", "scale=320:-2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", join(ctx.workspace, "output", "proxy.mp4")]);
await ctx.out.file("output/shots.json", { type: "shots" });
await ctx.out.file("output/proxy.mp4", { type: "proxy_video" });
ctx.log.info("indexed", { duration });
await ctx.done({ cost_usd: 0 });
