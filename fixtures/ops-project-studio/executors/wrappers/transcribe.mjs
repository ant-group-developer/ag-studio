#!/usr/bin/env node
// Optional `transcribe` hook the built-in `watch` stage spawns directly (not through @harness/script-sdk --
// this is a plain CLI, invoked as `argv --in <media> --out <json>`; see docs/superpowers/specs/
// 2026-09-15-sub-project-4-studio-autopilot-design.md §2.2). A real studio machine would shell out to
// faster-whisper here; this fixture fakes it by reading a sibling `<media>.txt` transcript file when one
// exists (one segment per non-empty line, 5 seconds each), so tests can control the outcome without needing
// real audio or a real whisper install. The harness core never calls whisper -- only this wrapper does.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.env.FAKE_TRANSCRIBE === "crash") process.exit(1);

const inPath = argValue("--in");
const outPath = argValue("--out");
if (!inPath || !outPath) {
  process.stderr.write("transcribe.mjs needs --in <media> --out <json>\n");
  process.exit(1);
}

const txtPath = `${inPath}.txt`;
let segments = [];
if (existsSync(txtPath)) {
  const lines = readFileSync(txtPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  segments = lines.map((text, i) => ({ start: 5 * i, end: 5 * (i + 1), text }));
}

writeFileSync(outPath, JSON.stringify({ segments }, null, 2));
