import { start } from "@harness/script-sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg } from "./_media.mjs";

const ctx = await start();

if (!ctx.hasResource("gpu")) {
  await ctx.fail("contract", "tts needs the gpu slot");
  process.exit(0);
}

const sleepMs = Number(process.env.FAKE_TTS_SLEEP_MS ?? 0);
if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);

const narrationPath = ctx.input("narration");
const narration = readFileSync(narrationPath, "utf8");
const lines = narration.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
const words = narration.split(/\s+/).filter((w) => w.length > 0).length;
const seconds = Math.max(1, Math.ceil(words / 3));

const wavPath = join(ctx.workspace, "output", "narration.wav");
ffmpeg(["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "pcm_s16le", wavPath]);

const perLine = seconds / lines.length;
const captions = lines.map((text, i) => ({ start: Number((i * perLine).toFixed(3)), end: Number(((i + 1) * perLine).toFixed(3)), text }));
writeFileSync(join(ctx.workspace, "output", "captions.json"), JSON.stringify(captions, null, 2));

await ctx.out.file("output/narration.wav", { type: "voice_track" });
await ctx.out.file("output/captions.json", { type: "captions" });
ctx.log.info("tts done", { seconds, lines: lines.length });
await ctx.done({ cost_usd: 0.05 });
