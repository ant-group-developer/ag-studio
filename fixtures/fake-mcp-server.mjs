// A tiny MCP stdio server for tests of the agent runtime: `echo` answers its text and whether FAKE_MCP_TOKEN is set.
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const tools = [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }];
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo:${msg.params.arguments.text} token=${process.env.FAKE_MCP_TOKEN ? "yes" : "no"}` }] } });
  else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}).on("close", () => process.exit(0));
