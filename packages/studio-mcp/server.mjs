#!/usr/bin/env node
// The Studio MCP server (spec 2026-10-10 agent-workspace §3.3, ADR-0001 item 183). An agent turn's `claude` CLI starts
// it from the turn's mcp.json; it only forwards: `tools/list` → GET /api/agent-tools/tools, `tools/call` →
// POST /api/agent-tools/call, with the turn's token. It holds no other secret and exits when its stdin closes.
// Zero dependencies: JSON-RPC 2.0, one message per line on stdin/stdout.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createInterface } from "node:readline";

const API = (process.env.STUDIO_AGENT_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STUDIO_AGENT_TOKEN ?? "";
const PROTOCOL = "2025-06-18";
/** A tool call may wait for a job (inputs_prepare waits up to 60 s); the CLI's own MCP timeout is longer. */
const CALL_TIMEOUT_MS = Number(process.env.STUDIO_MCP_CALL_TIMEOUT_MS ?? 150_000);

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

/** One HTTP call to the API without keep-alive (no socket outlives it, so the process can end at once). */
function httpCall(method, path, body) {
  const url = new URL(`${API}${path}`);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method, agent: false, timeout: CALL_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}) },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (raw += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, raw }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

async function api(method, path, body) {
  const res = await httpCall(method, path, body);
  let json = null;
  try { json = JSON.parse(res.raw); } catch { /* not JSON */ }
  const data = json && typeof json === "object" && "success" in json && "data" in json ? json.data : json;
  if (res.status < 200 || res.status >= 300) {
    const err = json?.error ?? json ?? {};
    const message = typeof err.message === "string" ? err.message : `HTTP ${res.status}`;
    throw Object.assign(new Error(message), { status: res.status });
  }
  return data;
}

let tools = null;

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "studio", version: "1.0.0" },
    });
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return undefined;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    try {
      tools ??= (await api("GET", "/api/agent-tools/tools")).tools;
      return reply(id, { tools });
    } catch (e) {
      return fail(id, -32603, `Studio không trả danh sách tool: ${e.message}`);
    }
  }
  if (method === "tools/call") {
    const name = params?.name;
    try {
      const out = await api("POST", "/api/agent-tools/call", { name, arguments: params?.arguments ?? {} });
      return reply(id, { content: [{ type: "text", text: String(out?.text ?? "") }], isError: out?.isError === true });
    } catch (e) {
      const why = e.name === "TimeoutError" ? "Studio không trả lời kịp" : e.message;
      return reply(id, { content: [{ type: "text", text: `Lỗi Studio khi chạy ${name}: ${why}` }], isError: true });
    }
  }
  if (id !== undefined) return fail(id, -32601, `method not found: ${method}`);
  return undefined;
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    void handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, String(e?.message ?? e)); });
  })
  .on("close", () => { process.exitCode = 0; });
