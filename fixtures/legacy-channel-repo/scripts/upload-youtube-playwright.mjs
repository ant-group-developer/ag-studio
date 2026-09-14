#!/usr/bin/env node
// Fake stand-in for the real (Playwright-driven) legacy upload script: same argv, exit codes and files as
// the real one, no browser involved. Used only by adapter tests via a temp copy of this fixture repo.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function randomId(n) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(readFileSync(join(repoRoot, "channel.config.json"), "utf8"));
const pid = cfg.projectId;

const arg = process.argv[2] ?? "";
const m = /^episode-(\d+)$/.exec(arg);
if (!m) {
  console.error(`usage: upload-youtube-playwright.mjs episode-NN (got "${arg}")`);
  process.exit(3);
}
const nn = m[1];
const mode = process.env.FAKE_UPLOAD_MODE ?? "ok";

const manifestPath = join(repoRoot, "outputs", pid, "episodes", `episode-${nn}`, "publish", `episode-${nn}-upload-manifest.json`);
if (!existsSync(manifestPath)) {
  console.error(`[upload] missing manifest: ${manifestPath}`);
  process.exit(3);
}

console.log(`[upload] account ${cfg.youtube.accountEmail}`);

if (mode === "hang") {
  setTimeout(() => process.exit(0), 5000);
} else if (mode === "refused") {
  console.log("✋ DỪNG — sai tài khoản");
  process.exit(3);
} else if (mode === "busy") {
  console.error("[upload] uploader busy");
  process.exit(4);
} else if (mode === "silent") {
  process.exit(0);
} else if (mode === "ok" || mode === "lost") {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const videoId = "fk" + randomId(9);
  const queuePath = join(repoRoot, "outputs", pid, "publish-queue.json");
  const queue = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, "utf8")) : [];
  queue.push({
    ep: nn,
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: manifest.title ?? `Episode ${nn}`,
    addedAt: new Date().toISOString(),
    via: "auto-upload",
  });
  mkdirSync(dirname(queuePath), { recursive: true });
  writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  console.log(`[upload] videoId ${videoId}`);
  process.exit(mode === "lost" ? 1 : 0);
} else {
  console.error(`[upload] unknown FAKE_UPLOAD_MODE: ${mode}`);
  process.exit(1);
}
