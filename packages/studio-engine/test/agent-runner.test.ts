import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentToolList, agentTools, callAgentTool, createAgentRunner, createProject, createThread, getMessage, getProject, getThread, getVideo,
  listFileVersions, listMessages, listVideos, MemoryBucket, mcpToolNames, postUserMessage, projectDir, requestCancel, seedWorkspace,
  verifyAgentToken, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FAKE = join(ROOT, "fixtures", "fake-studio-agent.mjs");
const MCP = join(ROOT, "packages", "studio-mcp", "server.mjs");
const SECRET = "k".repeat(32);
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** The two agent-tool routes over the engine's real tools, as the API answers them. */
async function toolsApi(db: StudioDb, workspacesRoot: string) {
  const tools = agentTools();
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: status < 300, data, error: status < 300 ? null : data, requestId: "r" })); };
      try {
        const claims = verifyAgentToken((req.headers.authorization ?? "").slice(7), SECRET);
        const message = getMessage(db, claims.msg)!;
        if (message.status !== "running") return send(403, { code: "turn_not_running", message: "lượt đã kết thúc" });
        if (req.url === "/api/agent-tools/tools") return send(200, { tools: agentToolList(tools) });
        const body = JSON.parse(raw) as { name: string; arguments: unknown };
        const thread = getThread(db, claims.thread)!;
        const project = getProject(db, claims.project)!;
        const out = await callAgentTool(tools, {
          db, claims, message, thread, project, video: thread.video_id ? getVideo(db, thread.video_id) ?? null : null,
          workspaceDir: projectDir(workspacesRoot, project.id), role: message.actor_role ?? "viewer", now: () => new Date().toISOString(),
        }, body.name, body.arguments);
        send(200, out);
      } catch (e) { send(401, { code: "bad_agent_token", message: String(e) }); }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
}

const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

async function setup(env: Record<string, string> = {}) {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [new Date().toISOString(), new Date().toISOString()]);
  const root = mkdtempSync(join(tmpdir(), "agent-runner-"));
  const workspaces = join(root, "ws");
  const logs = join(root, "fake-logs");
  mkdirSync(logs, { recursive: true });
  const project = createProject(w.db, "team-1", { name: "Du lịch chậm", channelUrl: "@dlc", description: "Đi bộ phố cổ", language: "vi", aspect: "16:9" }, "auth0|u");
  const dir = seedWorkspace(workspaces, project);
  writeFileSync(join(dir, "memory", "lessons.md"), "# Bài học\n- Mở đầu dưới 5 giây.\n");
  const thread = createThread(w.db, { projectId: project.id, kind: "project", title: "Kênh", createdBy: "auth0|u" });
  const api = await toolsApi(w.db, workspaces);
  closers.push(api.close);
  const bucket = new MemoryBucket();
  const runner = createAgentRunner({
    db: w.db, bucket, logger: quiet, workspacesRoot: workspaces, dataRoot: join(root, "data"), apiUrl: api.url, tokenSecret: SECRET,
    claudeCommand: [process.execPath, FAKE], mcpCommand: [process.execPath, MCP], configDir: join(root, "claude-config"),
    model: "sonnet", maxTurns: 20, deadlineMs: 60_000, mcpTools: () => mcpToolNames(agentTools()), cap: () => 4,
    baseEnv: { ...process.env, FAKE_AGENT_LOG_DIR: logs, ...env }, updateMs: 50,
  });
  const calls = () => readdirSync(join(logs, "calls")).sort().map((f) => JSON.parse(readFileSync(join(logs, "calls", f), "utf8")) as { argv: string[]; prompt: string; append: string });
  const say = (text: string) => postUserMessage(w.db, { threadId: thread.id, text, actor: { id: "auth0|u", role: "editor" } });
  const turnOf = (id: string) => getMessage(w.db, id)!;
  return { ...w, project, dir, thread, runner, calls, say, turnOf, bucket };
}

describe("agent runner (fake CLI, real MCP server)", { timeout: 60_000 }, () => {
  it("runs a turn in the project folder: streams it, its tools work, files are versioned, history and log written", async () => {
    const { db, runner, say, turnOf, calls, dir, project, thread } = await setup();
    const { turn } = say("@fake say Mình tạo video nhé\n@fake mcp video_create {\"title\":\"Hội An đêm\",\"brief\":\"Phố đèn lồng\"}\n@fake write channel/notes.md ghi chú\n@fake say Xong");
    await runner.tick();
    await runner.idle();
    const done = turnOf(turn!.id);
    expect(done).toMatchObject({ status: "done", text: "Mình tạo video nhé\n\nXong", error: null });
    expect(JSON.parse(done.parts!).filter((p: { kind: string }) => p.kind === "tool").map((p: { name: string; is_error: boolean }) => [p.name, p.is_error]))
      .toEqual([["mcp__studio__video_create", false], ["Write", false]]);
    expect(listVideos(db, project.id).map((v) => v.title)).toEqual(["Hội An đêm"]);
    expect(listFileVersions(db, project.id, "channel/notes.md")[0]).toMatchObject({ author_kind: "agent", message_id: turn!.id });
    expect(readFileSync(join(dir, ".studio", "history", `${thread.id}.md`), "utf8")).toContain("Mình tạo video nhé");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls WHERE source = 'claude-agent' AND attempt_id = ?", [turn!.id])?.n).toBe(1);
    expect(getThread(db, thread.id)?.session_started).toBe(1);
    const first = calls()[0]!;
    expect(first.argv).toContain("--restricted");
    expect(first.argv).toContain("--session-id");
    expect(first.prompt).toContain("<studio_context>");
    expect(first.prompt).toContain("Dự án: Du lịch chậm (@dlc)");
    expect(first.append).toContain("# Bạn là agent của AG Studio");
    expect(first.append).toContain("Đi bộ phố cổ");
    expect(first.append).toContain("Mở đầu dưới 5 giây.");
    expect(existsSync(join(dir, "..", "..", "data", "agent-runs", turn!.id))).toBe(false);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM lease WHERE owner LIKE 'agent%'")?.n).toBe(0);
  });

  it("the next turn resumes the session; messages sent during a turn get the next one", async () => {
    const { runner, say, calls, thread, db } = await setup();
    say("@fake slow 1500\n@fake say một");
    await runner.tick();
    await new Promise((r) => setTimeout(r, 300));
    expect(say("hai").turn).toBeNull();
    await runner.idle();
    await runner.tick();
    await runner.idle();
    const second = calls()[1]!;
    expect(second.argv.slice(second.argv.indexOf("--resume"), second.argv.indexOf("--resume") + 2)).toEqual(["--resume", getThread(db, thread.id)!.claude_session_id]);
    expect(second.prompt.endsWith("hai")).toBe(true);
    expect(listMessages(db, thread.id).map((m) => [m.role, m.status])).toEqual([["user", "done"], ["assistant", "done"], ["user", "done"], ["assistant", "done"]]);
  });

  it("a stop ends the running turn, keeping what it said", async () => {
    const { runner, say, turnOf, db } = await setup();
    const { turn } = say("@fake say đang làm\n@fake hang");
    await runner.tick();
    for (let i = 0; i < 100 && !turnOf(turn!.id).text; i++) await new Promise((r) => setTimeout(r, 50));
    requestCancel(db, turn!.id);
    await runner.idle();
    expect(turnOf(turn!.id)).toMatchObject({ status: "cancelled", text: "đang làm" });
  });

  it("a lost session starts a new one with a recap; the plan's limit waits and retries", async () => {
    const { runner, say, turnOf, thread, db, calls } = await setup({ FAKE_STUDIO_MODE: "agent-rate-limit-once" });
    const { turn } = say("xin chào");
    await runner.tick();
    await runner.idle();
    const limited = turnOf(turn!.id);
    expect(limited.status).toBe("rate_limited");
    expect(Date.parse(limited.not_before!)).toBeGreaterThan(Date.now() + 4 * 60_000);
    db.run("UPDATE agent_messages SET not_before = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), turn!.id]);
    db.run("UPDATE agent_threads SET session_started = 1 WHERE id = ?", [thread.id]);
    await runner.tick();
    await runner.idle();
    expect(turnOf(turn!.id).status).toBe("done");
    const last = calls().at(-1)!;
    expect(last.prompt).toContain("phiên mới của một luồng đã có");
    expect(last.prompt).toContain("Lượt trước bị ngắt");
  });
});
