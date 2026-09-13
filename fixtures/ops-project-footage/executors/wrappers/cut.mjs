import { start } from "@harness/script-sdk";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg, fileUrlToPath } from "./_media.mjs";

const ctx = await start();
const edl = JSON.parse(readFileSync(ctx.input("edl"), "utf8"));

const cutsDir = join(ctx.workspace, "output", "cuts");
mkdirSync(cutsDir, { recursive: true });

for (const entry of edl.entries) {
  const source = ctx.sources.find((s) => s.source_id === entry.source_id);
  if (!source) throw new Error(`edl entry references unknown source_id ${entry.source_id}`);
  const path = fileUrlToPath(source.uri);
  const name = `${String(entry.order).padStart(3, "0")}.mp4`;
  ffmpeg(["-y", "-ss", String(entry.in), "-to", String(entry.out), "-i", path, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", join(cutsDir, name)]);
}

await ctx.out.dir("output/cuts", { type: "clip_set" });
ctx.log.info("cut done", { count: edl.entries.length });
await ctx.done({ cost_usd: 0 });
