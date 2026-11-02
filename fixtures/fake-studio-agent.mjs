// Fake `claude -p --output-format stream-json …` for the Studio agent workspace (spec 2026-10-10 agent-workspace).
// Zero dependencies.
//
// It behaves like the real CLI (shapes from fixtures/agent-stream): `system/init` (session, tools, MCP servers),
// partial text deltas, one `assistant` event per content block, `user` tool results, `result` with cost — and keeps
// sessions in $FAKE_AGENT_LOG_DIR/sessions so `--resume` remembers, and refuses an unknown session like the CLI
// ("No conversation found with session ID: …", exit 1). Every call is logged to $FAKE_AGENT_LOG_DIR/calls/<n>.json.
//
// Directives, one per line in the prompt (else it answers "Đã nhận: …"):
//   @fake say <text>                 answer text (`\n` becomes a new line)
//   @fake write <path> <text>        Write tool in cwd (refused outside cwd, under .studio/ or .claude/)
//   @fake read <path>                Read tool
//   @fake mcp <tool> <json args>     calls the MCP server of --mcp-config for real (initialize, tools/call)
//   @fake slow <ms>                  waits
//   @fake busy <ms> <every>          works <ms> long, printing a stream event every <every> ms (a CLI that is not stuck)
//   @fake hang                       writes its pid to $FAKE_AGENT_LOG_DIR/hang.pid and waits until killed
//   @fake fail                       exits 1 without a result
//   @fake lesson <text>              (structured mode, --output-format json) a lesson the thread summary proposes
// FAKE_STUDIO_MODE: agent-rate-limit-once (first call per log dir prints the plan-limit message, exits 1),
//                   agent-mcp-down (init reports the MCP server failed).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const modes = new Set((process.env.FAKE_STUDIO_MODE ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const logDir = process.env.FAKE_AGENT_LOG_DIR ?? join(process.cwd(), ".fake-agent");
mkdirSync(join(logDir, "calls"), { recursive: true });
mkdirSync(join(logDir, "sessions"), { recursive: true });
const cwd = process.cwd();

const prompt = await new Promise((res) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => res(s)); });
const n = readdirSync(join(logDir, "calls")).length;
writeFileSync(join(logDir, "calls", `${String(n).padStart(3, "0")}.json`), JSON.stringify({
  argv, prompt, cwd, append: flag("--append-system-prompt") ?? null, env: Object.keys(process.env).sort(),
  oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
}, null, 2));

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// Structured mode (--output-format json --json-schema): Studio's small jobs, e.g. summarizing a thread. Lessons are the
// "@fake lesson <text>" lines found in the prompt (the thread's transcript).
if (flag("--output-format") === "json") {
  const schema = flag("--json-schema") ?? "{}";
  const lessons = [...prompt.matchAll(/@fake lesson ([^\n]+)/g)].map((m) => m[1].trim());
  const structured = schema.includes("lessons")
    ? { summary_md: `## Mục tiêu\n\nTóm tắt giả của ${(prompt.match(/^### /gm) ?? []).length} tin.\n`, lessons }
    : {};
  out({ type: "result", subtype: "success", is_error: false, structured_output: structured, total_cost_usd: 0.0005, session_id: "structured" });
  process.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (modes.has("agent-rate-limit-once") && !existsSync(join(logDir, ".rate-limited"))) {
  writeFileSync(join(logDir, ".rate-limited"), "1");
  process.stderr.write("You've hit your 5-hour limit · resets 3pm (Asia/Ho_Chi_Minh)\n");
  process.exit(1);
}

// FAKE_STUDIO_MODE rate-limited:<token>: that CLAUDE_CODE_OAUTH_TOKEN's plan is at its limit
if (modes.has(`rate-limited:${process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ""}`)) {
  process.stderr.write("You've hit your 5-hour limit · resets 3pm (Asia/Ho_Chi_Minh)\n");
  process.exit(1);
}

const resume = flag("--resume");
const sessionId = resume ?? flag("--session-id") ?? randomUUID();
const sessionFile = join(logDir, "sessions", `${sessionId}.json`);
if (resume && !existsSync(sessionFile)) {
  out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: sessionId, total_cost_usd: 0, errors: [`No conversation found with session ID: ${sessionId}`] });
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
}
if (!resume && existsSync(sessionFile)) {
  process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`);
  process.exit(1);
}
const session = resume ? JSON.parse(readFileSync(sessionFile, "utf8")) : { cwd, turns: [] };

// --- MCP client (stdio JSON-RPC, newline-delimited) ---
function mcpServer() {
  const cfgPath = flag("--mcp-config");
  if (!cfgPath) return null;
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const [name, server] = Object.entries(cfg.mcpServers ?? {})[0] ?? [];
  return name ? { name, server } : null;
}
async function mcpCall(tool, args) {
  const s = mcpServer();
  if (!s) return { is_error: true, text: "no MCP server" };
  const child = spawn(s.server.command, s.server.args ?? [], { env: { ...process.env, ...(s.server.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const waiters = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((res) => { const my = ++id; waiters.set(my, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n"); });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const answer = await rpc("tools/call", { name: tool, arguments: args });
  child.stdin.end();
  if (answer.error) return { is_error: true, text: answer.error.message };
  const text = (answer.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { is_error: answer.result?.isError === true, text };
}
async function mcpToolNames() {
  const s = mcpServer();
  if (!s || modes.has("agent-mcp-down")) return { name: s?.name, status: s ? "failed" : null, tools: [] };
  const child = spawn(s.server.command, s.server.args ?? [], { env: { ...process.env, ...(s.server.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const done = new Promise((res) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try { const m = JSON.parse(line); if (m.id === 2) res(m.result?.tools ?? []); } catch { /* partial */ }
      }
    });
    child.on("exit", () => res([]));
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  let timer;
  const tools = await Promise.race([done, new Promise((r) => { timer = setTimeout(() => r([]), 5000); })]);
  clearTimeout(timer);
  child.stdin.end();
  return { name: s.name, status: "connected", tools: tools.map((t) => `mcp__${s.name}__${t.name}`) };
}

// --- the turn ---
const builtIn = (flag("--tools") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
const mcp = await mcpToolNames();
out({
  type: "system", subtype: "init", cwd, session_id: sessionId, tools: [...builtIn, ...mcp.tools],
  mcp_servers: mcp.name ? [{ name: mcp.name, status: mcp.status }] : [], model: flag("--model") ?? "claude-sonnet-5-5",
  permissionMode: flag("--permission-mode") ?? "default", skills: [],
});

let msgCount = 0;
const message = () => `msg_fake_${n}_${msgCount++}`;
async function say(text) {
  const id = message();
  out({ type: "stream_event", event: { type: "message_start", message: { id, role: "assistant", content: [] } }, session_id: sessionId });
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
  const pieces = text.match(/.{1,12}/gs) ?? [text];
  for (const p of pieces) out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } }, session_id: sessionId });
  out({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] }, session_id: sessionId });
  out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
  out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
}
async function tool(name, input, run) {
  const id = message();
  const toolId = `toolu_fake_${n}_${msgCount}`;
  out({ type: "stream_event", event: { type: "message_start", message: { id, role: "assistant", content: [] } }, session_id: sessionId });
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name, input: {} } }, session_id: sessionId });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }, session_id: sessionId });
  out({ type: "assistant", message: { id, role: "assistant", content: [{ type: "tool_use", id: toolId, name, input }] }, session_id: sessionId });
  out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
  const r = await run();
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, is_error: r.is_error, content: r.text }] }, session_id: sessionId });
}
function insideCwd(path) {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(cwd, abs).replace(/\\/g, "/");
  if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, why: `${path} is outside ${cwd}; --restricted confines the file tools to the working directory.` };
  if (/^\.(studio|claude)(\/|$)/.test(rel)) return { ok: false, why: "File is in a directory that is denied by your permission settings." };
  return { ok: true, abs };
}

const said = [];
const lines = prompt.split(/\r?\n/).filter((l) => l.startsWith("@fake "));
if (!lines.length) {
  const last = prompt.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  const text = `Đã nhận: ${last.slice(0, 60)}`;
  await say(text); said.push(text);
}
for (const line of lines) {
  const [, cmd, ...rest] = line.split(" ");
  if (cmd === "say") { const text = rest.join(" ").replace(/\\n/g, "\n"); await say(text); said.push(text); }
  else if (cmd === "write") {
    const [path, ...words] = rest;
    await tool("Write", { file_path: path, content: words.join(" ") }, async () => {
      const where = insideCwd(path);
      if (!where.ok) return { is_error: true, text: where.why };
      mkdirSync(dirname(where.abs), { recursive: true });
      writeFileSync(where.abs, words.join(" ").replace(/\\n/g, "\n"));
      return { is_error: false, text: `File created successfully at: ${where.abs}` };
    });
  } else if (cmd === "read") {
    const [path] = rest;
    await tool("Read", { file_path: path }, async () => {
      const where = insideCwd(path);
      if (!where.ok) return { is_error: true, text: where.why };
      return existsSync(where.abs) ? { is_error: false, text: readFileSync(where.abs, "utf8") } : { is_error: true, text: "File does not exist." };
    });
  } else if (cmd === "mcp") {
    const [name, ...json] = rest;
    const args = json.length ? JSON.parse(json.join(" ")) : {};
    await tool(`mcp__${mcp.name ?? "studio"}__${name}`, args, () => mcpCall(name, args));
  } else if (cmd === "slow") await sleep(Number(rest[0] ?? 100));
  else if (cmd === "busy") {
    const [ms, every] = [Number(rest[0] ?? 1000), Number(rest[1] ?? 200)];
    for (let t = 0; t < ms; t += every) { out({ type: "stream_event", event: { type: "ping" }, session_id: sessionId }); await sleep(every); }
  }
  else if (cmd === "hang") { writeFileSync(join(logDir, "hang.pid"), String(process.pid)); await sleep(10 * 60_000); }
  else if (cmd === "fail") { process.stderr.write("fake failure\n"); process.exit(1); }
}

session.turns.push({ prompt, said });
writeFileSync(sessionFile, JSON.stringify(session));
out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1791631200, unifiedWindows: { five_hour: { utilization: 0.2 }, seven_day: { utilization: 0.4 } } } });
out({
  type: "result", subtype: "success", is_error: false, num_turns: lines.length + 1, session_id: sessionId,
  result: said.join("\n\n"), total_cost_usd: 0.001,
  usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 20 },
});
