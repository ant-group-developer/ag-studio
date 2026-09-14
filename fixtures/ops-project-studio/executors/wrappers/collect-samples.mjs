// style-study stage 1: turn a plain-text list of reference videos into a directory of still frames the
// `analyze-style` gate can look at. Fake in the same sense as the footage wrappers -- real frames, no
// analysis. The `_media.mjs` helpers are shared with the footage fixture next door rather than duplicated.
import { start } from "@harness/script-sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg, fileUrlToPath, probeDuration } from "../../../ops-project-footage/executors/wrappers/_media.mjs";

const ctx = await start();

const list = ctx.sources.find((s) => s.mime_type === "text/plain");
if (!list) {
  await ctx.fail("contract", "collect-samples needs a text/plain source listing one video path per line", {
    sources: ctx.sources.map((s) => `${s.source_id}:${s.mime_type}`),
  });
  process.exit(0);
}

const videoPaths = readFileSync(fileUrlToPath(list.uri), "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"));
if (videoPaths.length === 0) {
  await ctx.fail("contract", `sample list ${list.source_id} is empty`, { source_id: list.source_id });
  process.exit(0);
}

const samplesDir = join(ctx.workspace, "output", "samples");
mkdirSync(samplesDir, { recursive: true });

const samples = [];
for (const [index, path] of videoPaths.entries()) {
  const duration = probeDuration(path);
  // start / middle / end, nudged inside the clip so the last seek never lands past the final frame
  const marks = { start: 0.5, mid: duration / 2, end: Math.max(0.5, duration - 0.5) };
  const frames = [];
  for (const [mark, at] of Object.entries(marks)) {
    const name = `${index}-${mark}.png`;
    ffmpeg(["-y", "-ss", String(at), "-i", path, "-frames:v", "1", join(samplesDir, name)]);
    frames.push(name);
  }
  samples.push({ index, path, frames });
}

writeFileSync(join(samplesDir, "samples.json"), JSON.stringify(samples, null, 2) + "\n");

await ctx.out.dir("output/samples", { type: "sample_set" });
ctx.log.info("samples collected", { videos: samples.length, frames: samples.length * 3 });
await ctx.done({ cost_usd: 0 });
