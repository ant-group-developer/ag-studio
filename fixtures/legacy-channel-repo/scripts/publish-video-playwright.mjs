#!/usr/bin/env node
// Fake stand-in for the real (Playwright-driven) legacy schedule script: same argv/exit-code/file contract.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(readFileSync(join(repoRoot, "channel.config.json"), "utf8"));
const pid = cfg.projectId;

const videoId = process.argv[2];
const scheduleIdx = process.argv.indexOf("--schedule");
const at = scheduleIdx >= 0 ? process.argv[scheduleIdx + 1] : undefined;
if (!videoId || !at) {
  console.error("usage: publish-video-playwright.mjs <videoId> --schedule <ISO>");
  process.exit(1);
}

const mode = process.env.FAKE_SCHEDULE_MODE ?? "ok";
if (mode === "refused") {
  console.log("✋ DỪNG — sai tài khoản");
  process.exit(3);
} else if (mode === "busy") {
  console.error("[schedule] busy");
  process.exit(4);
} else if (mode === "crash") {
  console.error("[schedule] crash");
  process.exit(1);
} else {
  const schedulesDir = join(repoRoot, "outputs", pid, "schedules");
  mkdirSync(schedulesDir, { recursive: true });
  writeFileSync(join(schedulesDir, `${videoId}.json`), JSON.stringify({ videoId, at }, null, 2));
  console.log(`[schedule] ${videoId} at ${at}`);
  process.exit(0);
}
