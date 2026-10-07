#!/usr/bin/env node
// Test-only wrapper around fake-studio-claude.mjs that records how many calls run at once and in what order.
// argv: <dir> <hold ms> <fake claude script> [...claude args]
// Each call reads its prompt, drops `running-<pid>` in <dir>, appends "<start|end> <chat|stage> <running now> <ms>"
// to calls.log, holds for <hold ms>, then runs the fake CLI with the same prompt, stdout and cwd.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, holdRaw, fake, ...rest] = process.argv.slice(2);
if (rest[0] === "--version") { console.log("concurrency-claude"); process.exit(0); }
mkdirSync(dir, { recursive: true });
const prompt = await new Promise((res) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => res(s)); });
const kind = prompt.includes("\n# Góp ý\n") ? "chat" : "stage";
const mark = join(dir, `running-${process.pid}`);
writeFileSync(mark, "");
const running = () => readdirSync(dir).filter((f) => f.startsWith("running-")).length;
appendFileSync(join(dir, "calls.log"), `start ${kind} ${running()} ${Date.now()}\n`);
await new Promise((r) => setTimeout(r, Number(holdRaw)));
rmSync(mark, { force: true });
appendFileSync(join(dir, "calls.log"), `end ${kind} ${running()} ${Date.now()}\n`);

const child = spawn(process.execPath, [fake, ...rest], { stdio: ["pipe", "inherit", "inherit"] });
child.stdin.end(prompt);
child.on("close", (code) => process.exit(code ?? 1));
