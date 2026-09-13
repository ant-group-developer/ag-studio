import { start } from "@harness/script-sdk";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg } from "./_media.mjs";

const ctx = await start();
const key = process.env.HEYGEN_API_KEY ?? "";
console.log(`avatar: using api key ${key}`); // deliberate: the secret e2e proves this line is redacted in the log
ctx.log.info("calling heygen", { key }); // both a plain line and a JSON line

// The payload must stay stable across a retry's fresh workspace (a new attempt gets a new absolute path for
// the same input), so identify the script by its content checksum rather than by `ctx.input("script")`'s
// path: that keeps `ctx.op.intent`'s idempotency key the same across attempts, so a retry after a lost
// connection reuses the same key the first attempt recorded (found CONFIRMED via `findConfirmedByKey`, or
// superseded in place if it was left FAILED) instead of minting an unrelated one.
const scriptChecksum = ctx.request.inputs.find((i) => i.type === "script")?.checksum ?? null;
const intent = await ctx.op.intent({ provider: "heygen", kind: "render", target: ctx.request.stage_run_id, payload: { script_checksum: scriptChecksum } });
if (intent.status === "CONFIRMED") {
  ctx.log.info("reusing confirmed render", { operation_id: intent.operation_id });
} else if (process.env.FAKE_HEYGEN_LOSE === "1") {
  await ctx.op.lost(intent.operation_id, "socket closed after dispatch");
  await ctx.unknown("heygen connection lost", [intent.operation_id]);
  process.exit(0);
} else {
  await ctx.op.confirm(intent.operation_id, { provider_ref: "fake-heygen-" + intent.operation_id.slice(-6), receipt: { rendered: true }, cost_usd: 0.5 });
}

mkdirSync(join(ctx.workspace, "output", "avatar-clips"), { recursive: true });
ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=25", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(ctx.workspace, "output", "avatar-clips", "000.mp4")]);
await ctx.out.dir("output/avatar-clips", { type: "avatar_clips" });
await ctx.done({ cost_usd: 0.5, external_operations: [intent.operation_id] });
