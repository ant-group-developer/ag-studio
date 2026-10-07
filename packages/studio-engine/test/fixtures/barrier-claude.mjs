#!/usr/bin/env node
// Test-only wrapper around fake-studio-claude.mjs that proves calls overlap.
// argv: <barrier dir> <calls to wait for> <timeout ms> <fake claude script> [...claude args]
// Each call drops a marker in <barrier dir>, waits until <calls to wait for> markers exist (or the timeout), records
// how many it saw in seen.log, then runs the fake CLI with the same stdin, stdout and cwd.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, wantRaw, timeoutRaw, fake, ...rest] = process.argv.slice(2);
if (rest[0] === "--version" || process.argv[2] === "--version") { console.log("barrier-claude"); process.exit(0); }
const want = Number(wantRaw);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `arrived-${process.pid}`), "");
const deadline = Date.now() + Number(timeoutRaw);
let seen = 0;
while (Date.now() < deadline) {
  seen = readdirSync(dir).filter((f) => f.startsWith("arrived-")).length;
  if (seen >= want) break;
  await new Promise((r) => setTimeout(r, 50));
}
appendFileSync(join(dir, "seen.log"), `${seen}\n`);

const child = spawn(process.execPath, [fake, ...rest], { stdio: ["pipe", "inherit", "inherit"] });
process.stdin.pipe(child.stdin);
child.on("close", (code) => process.exit(code ?? 1));
