#!/usr/bin/env node
// Fake yt-dlp for tests (STUDIO_YTDLP_ARGV = [node, this file]): never touches the network.
//   --version                      prints a version
//   --dump-json … -- <urls>        one JSON line per video; an id starting with "ERR" is refused (on stderr)
//   --flat-playlist -J … -- <url>  a channel page: its first `--playlist-end` uploads (fake0000001…)
//   (otherwise) download           writes <dir>/<id>.mp4 with ffmpeg (`--ffmpeg-location`): 2 s black/white scenes, so
//                                  scene detection finds a cut every 2 s; without ffmpeg, a small dummy file
// FAKE_YTDLP_DURATION (seconds, default 600) is the duration every video reports.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const urls = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
const idOf = (url) => new URL(url).searchParams.get("v") ?? url.split("/").pop();
const duration = Number(process.env.FAKE_YTDLP_DURATION ?? 600);

if (args.includes("--version")) {
  process.stdout.write("2026.09.01-fake\n");
  process.exit(0);
}

if (args.includes("--dump-json")) {
  let ok = 0;
  for (const url of urls) {
    const id = idOf(url);
    if (id.startsWith("ERR")) { process.stderr.write(`ERROR: [youtube] ${id}: Video unavailable\n`); continue; }
    ok++;
    process.stdout.write(`${JSON.stringify({
      id, title: `Fake video ${id}`, channel_id: "UCfakechannel000000000000".slice(0, 24), channel: "Fake Channel",
      upload_date: "20260601", duration, view_count: 12345, like_count: 100, comment_count: 10, tags: ["fake", "travel"],
    })}\n`);
  }
  process.exit(ok ? 0 : 1);
}

if (args.includes("--flat-playlist")) {
  const n = Math.min(Number(after("--playlist-end") ?? 5), 5);
  const page = urls[0] ?? "";
  if (page.includes("@missing")) { process.stderr.write("ERROR: [youtube:tab] This channel does not exist\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({
    id: "UCfakechannel00000000000", channel_id: "UCfakechannel00000000000".slice(0, 24), channel: "Fake Channel", title: "Fake Channel - Videos",
    entries: Array.from({ length: n }, (_, i) => ({ id: `fake${String(i + 1).padStart(7, "0")}`, title: `Upload ${i + 1}`, duration })),
  }));
  process.exit(0);
}

// download
const id = idOf(urls[0] ?? "");
if (id.startsWith("ERR")) { process.stderr.write(`ERROR: [youtube] ${id}: Video unavailable\n`); process.exit(1); }
const out = (after("-o") ?? `${id}.%(ext)s`).replace("%(ext)s", "mp4");
const ffmpeg = after("--ffmpeg-location");
if (!ffmpeg) { writeFileSync(out, "fake-video"); process.exit(0); }
const colours = ["black", "white", "black", "white", "black"];
const inputs = colours.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=320x240:r=25:d=2`]);
const concat = `${colours.map((_, i) => `[${i}:v]`).join("")}concat=n=${colours.length}:v=1:a=0[v]`;
const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...inputs, "-filter_complex", concat, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", out], { encoding: "utf8" });
if (r.status !== 0) { process.stderr.write(`ERROR: fake ffmpeg failed: ${r.stderr}\n`); process.exit(1); }
process.exit(0);
