#!/usr/bin/env node
// Fake Codex CLI for tests (`codexImager({ argv: [node, this file] })`): never touches the network.
//   --version             prints a version
//   login status          says how $CODEX_HOME is logged in: its `fake-login` file ("chatgpt" | "api_key"),
//                         nothing there = not logged in (printed on stderr, as Codex does)
//   exec --json … -       reads the prompt on stdin and acts like `$imagegen`: a 1×1 PNG saved at
//                         $CODEX_HOME/generated_images/<thread id>/exec-<n>.png, JSON events on stdout
// The prompt picks a case: "FAKE:rate" usage limit (turn.failed), "FAKE:refuse" the agent refuses in words,
// "FAKE:noimage" answers without a picture, "FAKE:crash" exits 1 with stderr, "FAKE:slow" waits 30 s, "FAKE:twice"
// saves two pictures (the second is the one kept). Every exec writes its argv and env keys to
// $CODEX_HOME/last-exec.json so tests can check what Codex was given.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME ?? "";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  const f = join(home, "fake-login");
  const how = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
  if (how === "chatgpt") process.stdout.write("Logged in using ChatGPT\n");
  else if (how === "api_key") process.stdout.write("Logged in using an API key - sk-fake***0000\n");
  else { process.stderr.write("Not logged in\n"); process.exit(1); }
  process.exit(0);
}

if (args[0] !== "exec") {
  process.stderr.write(`fake codex: unknown command ${args.join(" ")}\n`);
  process.exit(2);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString("utf8");
writeFileSync(join(home, "last-exec.json"), JSON.stringify({ args, envKeys: Object.keys(process.env).sort(), prompt, cwd: process.cwd() }));

if (prompt.includes("FAKE:crash")) {
  process.stderr.write("Error: fake codex crashed\n");
  process.exit(1);
}

const thread = randomUUID();
out({ type: "thread.started", thread_id: thread });
out({ type: "turn.started" });

if (prompt.includes("FAKE:slow")) await new Promise((r) => setTimeout(r, 30_000));

if (prompt.includes("FAKE:rate")) {
  out({ type: "error", message: "You've hit your usage limit. Try again later." });
  out({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } });
  process.exit(1);
}
if (prompt.includes("FAKE:refuse")) {
  out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "I can't create that image because it violates the content policy." } });
} else if (prompt.includes("FAKE:noimage")) {
  out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Here is a description instead." } });
} else {
  const dir = join(home, "generated_images", thread);
  mkdirSync(dir, { recursive: true });
  const n = prompt.includes("FAKE:twice") ? 2 : 1;
  for (let i = 1; i <= n; i++) {
    writeFileSync(join(dir, `exec-${i}.png`), Buffer.concat([PNG, Buffer.from(`#${i}`)]));
    if (i < n) await new Promise((r) => setTimeout(r, 20));
  }
  out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "DONE" } });
}
out({ type: "turn.completed", usage: { input_tokens: 65553, cached_input_tokens: 52992, output_tokens: 718, reasoning_output_tokens: 288 } });
