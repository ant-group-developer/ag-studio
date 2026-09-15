// style-study stage 1: turn a plain-text list of reference videos into a directory of still frames the
// `analyze-style` gate can look at. Each line of the list is either a local path or an `http(s)://` URL;
// a URL is downloaded with yt-dlp (or, under FAKE_YTDLP=1, a fake clip made with ffmpeg testsrc, so tests
// never need real network access or a real yt-dlp binary). Fake in the same sense as the footage wrappers
// otherwise -- real frames, no analysis. The `_media.mjs` helpers are shared with the footage fixture
// next door rather than duplicated.
import { start } from "@harness/script-sdk";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg, fileUrlToPath, probeDuration } from "../../../ops-project-footage/executors/wrappers/_media.mjs";

const ctx = await start();

const list = ctx.sources.find((s) => s.mime_type === "text/plain");
if (!list) {
  await ctx.fail("contract", "collect-samples needs a text/plain source listing one video path or URL per line", {
    sources: ctx.sources.map((s) => `${s.source_id}:${s.mime_type}`),
  });
  process.exit(0);
}

const lines = readFileSync(fileUrlToPath(list.uri), "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"));
if (lines.length === 0) {
  await ctx.fail("contract", `sample list ${list.source_id} is empty`, { source_id: list.source_id });
  process.exit(0);
}

const samplesDir = join(ctx.workspace, "output", "samples");
mkdirSync(samplesDir, { recursive: true });

const URL_RE = /^https?:\/\//;

/** FAKE_YTDLP=1: stand in for a real download with a tiny synthetic clip -- 6s testsrc + silent audio. */
function downloadFake(index) {
  const out = join(samplesDir, `dl-${index}.mp4`);
  ffmpeg([
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=25",
    "-f", "lavfi", "-i", "anullsrc",
    "-shortest",
    out,
  ]);
  return out;
}

/** Real download via yt-dlp (`YTDLP_PATH` env, default "yt-dlp"). Throws on a non-zero exit so the caller
 * can report it as a transient stage failure -- the harness core never calls yt-dlp itself, only this
 * wrapper does. */
function downloadReal(url, index) {
  const bin = process.env.YTDLP_PATH ?? "yt-dlp";
  const outTemplate = join(samplesDir, `dl-${index}.%(ext)s`);
  const r = spawnSync(bin, ["-f", "bv*[height<=480]+ba/b", "-o", outTemplate, url], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${bin} download ${url} failed (status ${String(r.status)}): ${r.stderr ?? r.error?.message ?? "unknown error"}`);
  const prefix = `dl-${index}.`;
  const written = readdirSync(samplesDir).find((f) => f.startsWith(prefix));
  if (!written) throw new Error(`${bin} reported success but wrote no ${prefix}* file`);
  return join(samplesDir, written);
}

const samples = [];
for (const [index, line] of lines.entries()) {
  const label = `s${index}`;
  const isUrl = URL_RE.test(line);
  let path;
  if (isUrl) {
    if (process.env.FAKE_YTDLP === "1") {
      path = downloadFake(index);
    } else {
      try {
        path = downloadReal(line, index);
      } catch (e) {
        await ctx.fail("transient", e instanceof Error ? e.message : String(e), { url: line, index });
        process.exit(0);
      }
    }
  } else {
    path = line;
  }

  const duration = probeDuration(path);
  // start / middle / end, nudged inside the clip so the last seek never lands past the final frame
  const marks = { start: 0.5, mid: duration / 2, end: Math.max(0.5, duration - 0.5) };
  const frames = [];
  for (const [mark, at] of Object.entries(marks)) {
    const name = `${index}-${mark}.png`;
    ffmpeg(["-y", "-ss", String(at), "-i", path, "-frames:v", "1", join(samplesDir, name)]);
    frames.push(name);
  }
  samples.push({ index, label, path, ...(isUrl ? { url: line } : {}), frames });
}

writeFileSync(join(samplesDir, "samples.json"), JSON.stringify(samples, null, 2) + "\n");

await ctx.out.dir("output/samples", { type: "sample_set" });
ctx.log.info("samples collected", { videos: samples.length, frames: samples.length * 3 });
await ctx.done({ cost_usd: 0 });
