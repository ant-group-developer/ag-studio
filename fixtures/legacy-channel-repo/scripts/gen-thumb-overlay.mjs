#!/usr/bin/env node
// Fake stand-in for the legacy thumbnail-overlay script: copies the background image through unchanged and
// records the argv it was called with, so callers can assert on flags like --line1 without any real rendering.
import { copyFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
function argVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const bg = argVal("--bg");
const out = argVal("--out");
if (!bg || !out) {
  console.error("usage: gen-thumb-overlay.mjs --bg <in> --out <out> [...]");
  process.exit(1);
}
copyFileSync(bg, out);
writeFileSync(`${out}.args.json`, JSON.stringify(argv, null, 2));
console.log(`[gen-thumb-overlay] wrote ${out}`);
