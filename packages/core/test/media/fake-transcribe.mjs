#!/usr/bin/env node
// Stand-in for a real transcription CLI in watch.ts's transcribe-hook tests.
// Plain Node ESM, no dependencies (mirrors the fake-adapter scripts elsewhere in the repo).
//
// Behavior:
//   default            -> writes { segments: [{ start: 0, end: 1, text: "xin chào" }] } to the --out path
//   FAKE_TRANSCRIBE=crash -> exits 1 without writing anything
//   FAKE_TRANSCRIBE=hang  -> sleeps 30s (for timeout tests with a short timeout_seconds; long enough that
//                            finishing before it can only mean the child was killed, even under load)
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_TRANSCRIBE;

if (mode === "crash") {
  process.stderr.write("fake-transcribe: FAKE_TRANSCRIBE=crash\n");
  process.exit(1);
}

if (mode === "hang") {
  setTimeout(() => {}, 30_000);
} else {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 ? args[outIdx + 1] : undefined;
  if (!outPath) {
    process.stderr.write("fake-transcribe: missing --out <path>\n");
    process.exit(1);
  }
  writeFileSync(outPath, JSON.stringify({ segments: [{ start: 0, end: 1, text: "xin chào" }] }));
}
