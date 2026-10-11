import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));

/** A stand-in for the Studio API: the two agent-tool routes, and what it was asked. */
async function fakeApi(handler: (req: IncomingMessage, body: unknown) => { status: number; body: unknown }) {
  const seen: { method: string; url: string; auth: string | undefined; body: unknown }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const out = handler(req, body);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** Starts the MCP server and talks JSON-RPC to it. */
function mcp(apiUrl: string) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, STUDIO_AGENT_API_URL: apiUrl, STUDIO_AGENT_TOKEN: "tok-1" }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      buf = buf.slice(nl + 1);
      waiting.get(msg.id as number)?.(msg);
    }
  });
  let n = 0;
  const call = (method: string, params?: unknown) => new Promise<Record<string, unknown>>((res) => {
    const id = ++n;
    waiting.set(id, res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const exited = new Promise<number | null>((r) => child.on("exit", r));
  return { call, notify: (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`), close: () => { child.stdin.end(); return exited; } };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

describe("studio MCP server", () => {
  it("answers initialize, lists Studio's tools and calls one with the turn's token", async () => {
    const api = await fakeApi((req, body) => {
      if (req.url === "/api/agent-tools/tools") return { status: 200, body: { success: true, data: { tools: [{ name: "project_info", description: "Dự án", inputSchema: { type: "object" } }] }, error: null, requestId: "r" } };
      return { status: 200, body: { success: true, data: { text: `kênh: ${(body as { arguments: { x: string } }).arguments.x}`, isError: false }, error: null, requestId: "r" } };
    });
    cleanups.push(api.close);
    const s = mcp(api.url);
    const init = await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "2" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "studio" }, capabilities: { tools: {} } });
    s.notify("notifications/initialized");
    expect((await s.call("tools/list")).result).toEqual({ tools: [{ name: "project_info", description: "Dự án", inputSchema: { type: "object" } }] });
    expect((await s.call("tools/call", { name: "project_info", arguments: { x: "A" } })).result).toEqual({ content: [{ type: "text", text: "kênh: A" }], isError: false });
    expect(api.seen.map((r) => [r.method, r.url, r.auth])).toEqual([
      ["GET", "/api/agent-tools/tools", "Bearer tok-1"], ["POST", "/api/agent-tools/call", "Bearer tok-1"],
    ]);
    expect(api.seen[1]!.body).toEqual({ name: "project_info", arguments: { x: "A" } });
    expect(await s.close()).toBe(0);
  });

  it("turns a refusal of the API into a tool error the agent can read", async () => {
    const api = await fakeApi(() => ({ status: 403, body: { success: false, data: null, error: { code: "bad_agent_token", message: "token của lượt không hợp lệ: hết hạn" }, requestId: "r" } }));
    cleanups.push(api.close);
    const s = mcp(api.url);
    const out = await s.call("tools/call", { name: "video_list", arguments: {} });
    expect(out.result).toEqual({ content: [{ type: "text", text: "Lỗi Studio khi chạy video_list: token của lượt không hợp lệ: hết hạn" }], isError: true });
    expect((await s.call("tools/list")).error).toMatchObject({ code: -32603 });
    expect((await s.call("server/discover")).error).toMatchObject({ code: -32601 });
    expect((await s.call("ping")).result).toEqual({});
    await s.close();
  });
});
