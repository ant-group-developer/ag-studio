#!/usr/bin/env node
// Template wrapper. Copy to executors/wrappers/<script-name>.mjs (one per executors/scripts.yaml entry),
// point LEGACY_SCRIPT_PATH at that stage's real .mjs on this machine, and adjust the input type / output
// name below to match the stage. See docs/runbooks/wrap-a-channel.md.
import { start } from "@harness/script-sdk";
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";

const ctx = await start();
const legacyScript = process.env.LEGACY_SCRIPT_PATH ?? "C:/legacy-channel-repo/render.mjs"; // CHANGE ME
const input = ctx.input("script"); // the input type this stage actually consumes

const r = spawnSync("node", [legacyScript, "--in", input, "--out-dir", join(ctx.workspace, "legacy-out")]);
if (r.status !== 0) {
  await ctx.fail("transient", "legacy script failed", { exit_code: r.status });
  process.exit(0);
}

copyFileSync(join(ctx.workspace, "legacy-out", "result.mp4"), join(ctx.workspace, "output", "result.mp4"));
await ctx.out.file("output/result.mp4", { type: "episode_video" });
ctx.log.info("legacy script done");
await ctx.done({ cost_usd: 0 });
