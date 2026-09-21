import { start } from "@harness/script-sdk";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { ffmpeg, hasAudioStream } from "./_media.mjs";

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

// Sub-project 5A task 8: with a `timeline` input (library-production@1.2.0's media-fit-edl output), audio
// handling follows `timeline.voice` instead of the plain `voice_track`/none split below. Behaviour with NO
// `timeline` input (workflow 1.1.0, and the footage pipeline, which never has one) is byte-for-byte the
// original code path -- see the `else` branch.
if (ctx.hasInput("timeline")) {
  const timeline = JSON.parse(readFileSync(ctx.input("timeline"), "utf8"));
  const clipHasAudio = clips.length > 0 && hasAudioStream(clips[0]);
  const totalSeconds = Math.max(0.1, Number(timeline.total_seconds) || 0.1);

  const args = ["-y", "-f", "concat", "-safe", "0", "-i", concatPath]; // input 0: concatenated clip video(+audio)
  // A guaranteed-silent track the length of the whole programme: mixed into every branch below so the
  // output always has an audio stream, even when the source clips have none or `voice: tts` has no lines.
  args.push("-f", "lavfi", "-i", `anullsrc=r=44100:cl=stereo:d=${totalSeconds.toFixed(3)}`);
  const SILENCE_INDEX = 1;
  let nextInputIndex = 2;

  const filterParts = [];
  const mixLabels = [`[${SILENCE_INDEX}:a]anull[sil]`];
  const mixInputs = ["[sil]"];

  if (timeline.voice === "tts" && ctx.hasInput("voice_set") && Array.isArray(timeline.narration) && timeline.narration.length > 0) {
    const voiceParentDir = dirname(ctx.input("voice_set"));
    for (const n of timeline.narration) {
      const idx = nextInputIndex++;
      args.push("-i", join(voiceParentDir, n.wav));
      const delayMs = Math.max(0, Math.round(Number(n.start) * 1000));
      const label = `n${idx}`;
      mixLabels.push(`[${idx}:a]adelay=${delayMs}|${delayMs}[${label}]`);
      mixInputs.push(`[${label}]`);
    }
  } else if (timeline.voice === "original" && clipHasAudio) {
    mixLabels.push(`[0:a]anull[orig]`);
    mixInputs.push("[orig]");
  } else if (timeline.voice === "none" && clipHasAudio) {
    mixLabels.push(`[0:a]volume=-12dB[atten]`);
    mixInputs.push("[atten]");
  }
  // `voice: "original"`/`"none"` with no clip audio, or `voice: "tts"` with an empty script, falls through
  // to the silent track alone -- still a real, mixable audio stream.

  filterParts.push(...mixLabels, `${mixInputs.join("")}amix=inputs=${mixInputs.length}:normalize=0,apad[aout]`);
  args.push("-filter_complex", filterParts.join(";"), "-map", "0:v", "-map", "[aout]", "-shortest");
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", outPath);
  ffmpeg(args);
} else {
  const args = ["-y", "-f", "concat", "-safe", "0", "-i", concatPath];
  if (ctx.hasInput("voice_track")) {
    args.push("-i", ctx.input("voice_track"), "-map", "0:v", "-map", "1:a", "-shortest");
  } else {
    args.push("-map", "0:v", "-map", "0:a?");
  }
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", outPath);
  ffmpeg(args);
}

await ctx.out.file("output/full-episode.mp4", { type: "episode_video" });
ctx.log.info("assemble done", { clips: clips.length });
await ctx.done({ cost_usd: 0 });
