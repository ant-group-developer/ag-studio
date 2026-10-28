/**
 * The worker's agent loop (spec 2026-10-10 agent-workspace §3.2, ADR-0001 item 182): runs waiting turns next to the
 * stage loops, outside `claim()`. Each turn takes a `claude` slot (`agent:<message>` lease row, the same cap as chat
 * replies and stages), writes its turn folder (mcp.json with a token, settings.json) outside the workspace, runs the
 * CLI in the project folder and streams what it does into the message row. One turn per thread at a time.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { runAgentTurn, runStructuredCall, type AgentTurnOutcome, type AgentTurnState } from "@harness/adapter-agent-cli";
import type { HarnessLogger } from "@harness/core";
import type { StudioBucket } from "../bucket.js";
import { acquireClaudeSlot, CHAT_SLOT_LEASE_SECONDS, heartbeatClaudeSlot, idsHoldingSlots, releaseClaudeSlot } from "../claude-slots.js";
import type { StudioDb } from "../studio-db.js";
import { logAudit } from "../audit-log.js";
import { finalAnswer, thinAnswer } from "./answer.js";
import { turnChangedFiles } from "../workspace/file-changes.js";
import { projectDir, scanWorkspace } from "../workspace/files.js";
import { playbookContextLines, playbookStatus, type StepFact } from "../workspace/playbook-status.js";
import { getProject, getVideo, projectSettings } from "../workspace/project-db.js";
import { seedWorkspace } from "../workspace/templates.js";
import { hasErrors, validateWorkspaceFile } from "../workspace/validators.js";
import { materializeSkillPlugin } from "./skills.js";
import { saveThreadSummary, summaryPrompt, THREAD_SUMMARY_JSON_SCHEMA, ThreadSummarySchema, threadsToSummarize } from "./summaries.js";
import { LESSONS_PATH } from "./prompt.js";
import { threadMarkdown } from "./history.js";
import { agentSystemPrompt, agentTurnPrompt, youtubeBlockLines } from "./prompt.js";
import { youtubeBlock } from "../settings.js";
import {
  automaticTurnsInARow, cancelRequested, finishTurn, getMessage, getThread, listThreadRefs, markAgentTurnRunning, markSessionStarted, nextPendingAgentTurns,
  orphanedAgentTurns, postSystemMessage, queueFollowUp, requeueAgentTurn, resetSession, setTurnChangedFiles, TIMEOUT_TURNS_IN_A_ROW, turnInput, updateRunningTurn, type MessageRecord,
} from "./threads-db.js";
import { signAgentToken } from "./token.js";

/** Waits before the next try after the plan's limit: 5, 10, 20, 40, then 60 minutes. */
export const AGENT_RATE_LIMIT_BACKOFF_MINUTES = [5, 10, 20, 40, 60];
/** Built-in tools of a turn: files only, and skills (no shell, no web). */
export const AGENT_BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Skill"];
/** Settings every turn runs with (`--settings`): Studio's folders are read-only, and only Studio's skills exist. */
export const AGENT_TURN_SETTINGS = {
  permissions: { deny: ["Write(.studio/**)", "Edit(.studio/**)", "Write(.claude/**)", "Edit(.claude/**)", "Write(.git/**)", "Edit(.git/**)"] },
  disableBundledSkills: true,
  skillOverrides: { design: "off", doctor: "off" },
};

export interface AgentRunnerOptions {
  db: StudioDb;
  bucket: StudioBucket | null;
  logger: HarnessLogger;
  workspacesRoot: string;
  /** Turn folders go under `<dataRoot>/agent-runs/`. */
  dataRoot: string;
  /** Where the MCP server reaches the Studio API (`http://127.0.0.1:3101`). */
  apiUrl: string;
  tokenSecret: string;
  /** The CLI (`["claude"]`) and the MCP server (`[node, …/studio-mcp/server.mjs]`). */
  claudeCommand: string[];
  mcpCommand: string[];
  /** CLAUDE_CONFIG_DIR of agent sessions (kept across deploys). */
  configDir: string;
  model: string;
  maxTurns: number;
  /** Hard cap of a turn, however busy the agent is (the MCP token lasts as long). */
  deadlineMs: number;
  /** A turn stops after this long with no output from the CLI; none or 0: only the hard cap. */
  idleMs?: number;
  /** `mcp__studio__<tool>` names the turn may call without asking. */
  mcpTools: () => string[];
  /** Skills: Studio's own (`agent-skills/`) and where each turn's plugin folder is written. */
  skills?: { builtinDir: string; pluginsRoot: string };
  /** What Studio knows of the playbook's `studio` steps (inputs prepared, renders…); later phases. */
  stepFacts?: (key: string, videoId: string | null) => StepFact | undefined;
  /** More `<studio_context>` lines for a turn (jobs — later phases). */
  contextLines?: (projectId: string, videoId: string | null) => string[];
  /** Farm machines that fetch reference videos now (`referenceFetchers`): while YouTube blocks the server, the agent is told they can. */
  referenceFetchers?: () => Promise<string[]>;
  /** Summaries of quiet threads and the lessons they propose (`false`: off); the model of that small call. */
  summaries?: false | { model?: string; idleMinutes?: number };
  cap: () => number | Promise<number>;
  /** What people call the footage library (ag-go's `siteName`), told to the agent; default "AG Go". */
  siteName?: () => string;
  baseEnv?: Record<string, string | undefined>;
  now?: () => string;
  pollMs?: number;
  heartbeatMs?: number;
  /** How often a running turn's text and tool calls are written to its row. */
  updateMs?: number;
}

export interface AgentRunner {
  tick(signal?: AbortSignal): Promise<void>;
  readonly running: number;
  idle(): Promise<void>;
  runForever(signal: AbortSignal): Promise<void>;
}

const plusMinutes = (now: string, m: number) => new Date(Date.parse(now) + m * 60_000).toISOString();

const duration = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} phút` : `${Math.round(ms / 1000)} giây`;

/** The note a turn out of time leaves for the turn that goes on (it resumes the same session): which limit stopped it. */
function timeoutNote(limit: "idle" | "deadline" | null, o: { deadlineMs: number; idleMs?: number }): string {
  const why = limit === "idle" && o.idleMs
    ? `dừng vì ${duration(o.idleMs)} không thấy tiến triển`
    : `hết thời gian tối đa của một lượt (${duration(o.deadlineMs)})`;
  return `Lượt trước ${why} khi đang làm dở. Các file đã ghi vẫn còn: làm tiếp từ chỗ dừng, đừng làm lại phần đã xong; việc dài thì chia ra, ghi kết quả dần.`;
}

export function createAgentRunner(o: AgentRunnerOptions): AgentRunner {
  const { db, logger } = o;
  const now = o.now ?? (() => new Date().toISOString());
  const inFlight = new Map<string, Promise<void>>();
  const waiting = new Set<string>();
  /** Threads whose summary failed, and when to try again. */
  const summaryRetryAt = new Map<string, number>();
  let summarizing: Promise<void> | null = null;

  async function summarize(threadId: string): Promise<void> {
    const slot = `sum-${threadId}`;
    try {
      const thread = await getThread(db, threadId);
      const project = thread ? await getProject(db, thread.project_id) : undefined;
      if (!thread || !project) return;
      const dir = seedWorkspace(o.workspacesRoot, project);
      const lessonsFile = join(dir, ...LESSONS_PATH.split("/"));
      const lessons = existsSync(lessonsFile) ? readFileSync(lessonsFile, "utf8") : "";
      const out = await runStructuredCall({
        command: o.claudeCommand, cwd: dir, prompt: await summaryPrompt(db, thread, lessons), jsonSchema: THREAD_SUMMARY_JSON_SCHEMA,
        model: (o.summaries && o.summaries.model) || "haiku", baseEnv: o.baseEnv ?? process.env, configDir: o.configDir, deadlineMs: 5 * 60_000,
      });
      const parsed = out.status === "done" ? ThreadSummarySchema.safeParse(out.output) : null;
      if (!parsed?.success) {
        summaryRetryAt.set(threadId, Date.now() + 30 * 60_000);
        logger.warn("thread summary failed; tries again later", { thread_id: threadId, status: out.status, error: out.error });
        return;
      }
      const saved = await saveThreadSummary(db, { thread, dir, summary: parsed.data, now: now() });
      logger.info("thread summarized", { thread_id: threadId, path: saved.path, lessons: saved.lessons });
    } catch (e) {
      summaryRetryAt.set(threadId, Date.now() + 30 * 60_000);
      logger.warn("thread summary crashed", { thread_id: threadId, error: e instanceof Error ? e.message : String(e) });
    } finally {
      await releaseClaudeSlot(db, "agent", slot).catch((e: unknown) => logger.warn("summary slot not released", { thread_id: threadId, error: String(e) }));
    }
  }

  /** One summary at a time, only with a free slot and nothing of the person waiting. */
  async function maybeSummarize(cap: number) {
    if (o.summaries === false || summarizing) return;
    const idle = (o.summaries && o.summaries.idleMinutes) ?? undefined;
    const candidate = (await threadsToSummarize(db, now(), 5, idle)).find((t) => (summaryRetryAt.get(t.id) ?? 0) <= Date.now());
    if (!candidate || summarizing) return;
    if (!(await acquireClaudeSlot(db, "agent", `sum-${candidate.id}`, cap, now()))) { await releaseClaudeSlot(db, "agent", `sum-${candidate.id}`); return; }
    summarizing = summarize(candidate.id).finally(() => { summarizing = null; });
  }

  async function runOnce(message: MessageRecord, signal: AbortSignal, opts: { recap: boolean }): Promise<AgentTurnOutcome> {
    const thread = (await getThread(db, message.thread_id))!;
    const project = (await getProject(db, thread.project_id))!;
    const video = thread.video_id ? (await getVideo(db, thread.video_id)) ?? null : null;
    const dir = seedWorkspace(o.workspacesRoot, project);
    // what changed since the last version (seeded files, files a job wrote) is Studio's, not this turn's
    try { if (!opts.recap) await scanWorkspace(db, { projectId: project.id, dir, author: { kind: "studio", id: null }, now: now() }); }
    catch (e) { logger.warn("workspace not scanned before the turn", { message_id: message.id, error: String(e) }); }
    const turnDir = join(o.dataRoot, "agent-runs", message.id);
    mkdirSync(turnDir, { recursive: true });
    const deadline = Date.now() + o.deadlineMs;
    const token = signAgentToken({
      msg: message.id, thread: thread.id, project: project.id, video: video?.id ?? null, sub: message.created_by ?? "studio",
      exp: Math.floor(deadline / 1000) + 60,
    }, o.tokenSecret);
    writeFileSync(join(turnDir, "mcp.json"), JSON.stringify({
      mcpServers: { studio: { type: "stdio", command: o.mcpCommand[0], args: o.mcpCommand.slice(1), env: { STUDIO_AGENT_API_URL: o.apiUrl, STUDIO_AGENT_TOKEN: token } } },
    }));
    writeFileSync(join(turnDir, "settings.json"), JSON.stringify(AGENT_TURN_SETTINGS));
    const status = await playbookStatus(db, dir, { projectId: project.id, videoId: video?.id ?? null, ...(o.stepFacts ? { facts: o.stepFacts } : {}), now: now() });
    writeStudioFile(dir, "status.json", JSON.stringify({ updated_at: now(), video_id: video?.id ?? null, ...status }, null, 2));
    const studioBlock = await youtubeBlock(db, now());
    const fetchers = studioBlock && o.referenceFetchers ? await o.referenceFetchers().catch(() => [] as string[]) : [];
    const blockLines = youtubeBlockLines(studioBlock, { farm: await youtubeBlock(db, now(), "farm"), fetchers });
    const prompt = agentTurnPrompt({
      project, thread, video, refs: await listThreadRefs(db, thread.id), messages: await turnInput(db, message),
      resumed: message.attempts > 1, recap: opts.recap,
      extra: [...playbookContextLines(status), ...blockLines,...(o.contextLines?.(project.id, video?.id ?? null) ?? [])], now: now(),
    });
    const pluginDirs = o.skills ? [await materializeSkillPlugin(db, { project, workspaceDir: dir, builtinDir: o.skills.builtinDir, pluginsRoot: o.skills.pluginsRoot })] : [];
    let lastWrite = 0;
    let pending: { state: AgentTurnState; text: string } | null = null;
    let sessionMarked = thread.session_started;
    // the turn's writes land one after another, in the order the CLI said things
    let writes: Promise<void> = Promise.resolve();
    const write = (what: string, fn: () => Promise<void>) => {
      writes = writes.then(fn).catch((e: unknown) => logger.warn(`${what} not written`, { message_id: message.id, error: String(e) }));
    };
    const flush = () => {
      if (!pending) return;
      const { state, text } = pending;
      pending = null;
      lastWrite = Date.now();
      write("running turn", () => updateRunningTurn(db, message.id, { text, parts: state.parts, phase: state.phase }, now()));
    };
    const flusher = setInterval(flush, o.updateMs ?? 300);
    try {
      return await runAgentTurn({
        command: o.claudeCommand, cwd: dir, prompt, model: projectSettings(project).model ?? o.model,
        sessionId: thread.claude_session_id, resume: thread.session_started,
        tools: AGENT_BUILTIN_TOOLS, allowedTools: o.mcpTools(), appendSystemPrompt: agentSystemPrompt(dir, { useLessons: thread.use_lessons, ...(o.siteName ? { siteName: o.siteName() } : {}) }),
        settingsPath: join(turnDir, "settings.json"), mcpConfigPath: join(turnDir, "mcp.json"),
        pluginDirs, maxTurns: o.maxTurns, baseEnv: o.baseEnv ?? process.env, configDir: o.configDir,
        deadlineMs: Math.max(1000, deadline - Date.now()), ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}), signal,
        onUpdate: (state, text) => {
          if (!sessionMarked && state.session_id) { write("session start", () => markSessionStarted(db, thread.id, dir)); sessionMarked = true; }
          pending = { state, text };
          if (Date.now() - lastWrite > (o.updateMs ?? 300)) flush();
        },
      });
    } finally {
      clearInterval(flusher);
      flush();
      await writes;
      rmSync(turnDir, { recursive: true, force: true });
    }
  }

  async function record(message: MessageRecord, out: AgentTurnOutcome, wallSeconds: number): Promise<string | null> {
    const thread = (await getThread(db, message.thread_id))!;
    const id = randomUUID();
    const at = now();
    const outcome = out.status === "done" ? "accepted" : out.status === "rate_limited" ? "rate_limited" : "failed";
    let key: string | null = `llm-logs/agent/${at.slice(0, 4)}/${at.slice(5, 7)}/${at.slice(8, 10)}/${id}.json.gz`;
    try {
      if (!o.bucket) throw new Error("no bucket");
      await o.bucket.put(key, gzipSync(Buffer.from(JSON.stringify({
        schema: "studio.agent-turn/v1", id, created_at: at, thread_id: thread.id, message_id: message.id, status: out.status,
        model: out.state.model, text: out.text, parts: out.state.parts, error: out.error, result: out.state.result,
      }), "utf8")), "application/gzip");
    } catch { key = null; }
    const r = out.state.result;
    // who and which team, kept on the row for the Claude stats (the project may be deleted later)
    const teamId = (await getProject(db, thread.project_id))?.team_id ?? null;
    await db.run(
      `INSERT INTO llm_calls (id, created_at, source, production_id, episode_id, run_id, stage_key, attempt_id, skill, model, round, outcome,
         problems, input_tokens, output_tokens, cost_usd, wall_seconds, payload_key, cache_read_tokens, cache_creation_tokens, num_turns, user_id, team_id)
       VALUES (?, ?, 'claude-agent', ?, ?, ?, 'agent', ?, 'agent', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, at, thread.project_id, thread.video_id, thread.id, message.id, out.state.model ?? "", message.attempts, outcome,
        r?.input_tokens ?? null, r?.output_tokens ?? null, r?.cost_usd ?? 0, wallSeconds, key,
        r?.cache_read_tokens ?? null, r?.cache_creation_tokens ?? null, r?.num_turns ?? null, message.created_by ?? null, teamId],
    );
    return id;
  }

  async function runTurn(messageId: string, signal?: AbortSignal): Promise<void> {
    const ac = new AbortController();
    const onStop = () => ac.abort();
    signal?.addEventListener("abort", onStop, { once: true });
    const watch = setInterval(() => { void cancelRequested(db, messageId).then((c) => { if (c) ac.abort(); }, () => undefined); }, 1000);
    const started = Date.now();
    try {
      let message = (await getMessage(db, messageId))!;
      const thread = await getThread(db, message.thread_id);
      const project = thread ? await getProject(db, thread.project_id) : undefined;
      if (!thread || !project || thread.archived_at || project.archived_at) {
        await finishTurn(db, messageId, { status: "failed", text: "", parts: [], error: "luồng hoặc dự án đã lưu trữ" }, now());
        return;
      }
      let out = await runOnce(message, ac.signal, { recap: false });
      if (out.status === "session_lost") {
        logger.warn("agent session lost; starting a new one with a recap", { message_id: messageId, thread_id: thread.id });
        await resetSession(db, thread.id);
        message = (await getMessage(db, messageId))!;
        out = await runOnce(message, ac.signal, { recap: true });
      }
      if (signal?.aborted && out.status === "cancelled") {
        // the worker is stopping: the turn goes back in line and resumes its session later
        await requeueAgentTurn(db, messageId, now());
        return;
      }
      const dir = projectDir(o.workspacesRoot, project.id);
      const wall = (Date.now() - started) / 1000;
      let llmCallId: string | null = null;
      try { llmCallId = await record(message, out, wall); } catch (e) { logger.warn("agent turn not logged", { error: String(e) }); }
      const base = { text: out.text, parts: out.state.parts, costUsd: out.state.result?.cost_usd ?? null, llmCallId };
      // out of time: goes on by itself while the project allows it and it has not timed out too often since a person
      // spoke (turns jobs started do not count here)
      const goesOnAfterTimeout = out.status === "timeout" && projectSettings(project).auto_continue
        && await automaticTurnsInARow(db, thread.id, "timeout") < TIMEOUT_TURNS_IN_A_ROW;
      if (out.status === "rate_limited") {
        const wait = AGENT_RATE_LIMIT_BACKOFF_MINUTES[Math.min(message.attempts - 1, AGENT_RATE_LIMIT_BACKOFF_MINUTES.length - 1)] ?? 60;
        await finishTurn(db, messageId, { ...base, status: "rate_limited", error: "rate_limited", notBefore: plusMinutes(now(), wait) }, now());
      } else if (out.status === "done" || out.status === "max_turns") {
        await finishTurn(db, messageId, { ...base, status: "done", error: out.status === "max_turns" ? "max_turns" : null }, now());
      } else if (out.status === "cancelled") {
        await finishTurn(db, messageId, { ...base, status: "cancelled", error: null }, now());
      } else if (goesOnAfterTimeout) {
        // what it wrote is kept (scanned below); the next turn resumes the same session from where this one stopped
        logger.warn("agent turn out of time; it goes on in a new turn", { message_id: messageId });
        await finishTurn(db, messageId, { ...base, status: "done", error: "timeout" }, now());
      } else {
        const error = out.status === "timeout" ? "timeout" : out.error ?? "failed";
        logger.warn("agent turn failed", { message_id: messageId, status: out.status, error, stderr: out.stderr.slice(-500) });
        await finishTurn(db, messageId, { ...base, status: "failed", error }, now());
      }
      let changed: string[] = [];
      if (out.status !== "rate_limited") {
        ({ changed } = await scanWorkspace(db, { projectId: project.id, dir, author: { kind: "agent", id: message.created_by, messageId }, now: now() }));
        try { await setTurnChangedFiles(db, messageId, await turnChangedFiles(db, project.id, messageId), now()); }
        catch (e) { logger.warn("turn's changed files not kept", { message_id: messageId, error: String(e) }); }
        await writeHistory(thread.id, dir);
        const fixing = out.status === "done" && message.trigger !== "autofix" && projectSettings(project).auto_fix
          ? await askToFix(thread.id, dir, changed, message) : false;
        // a person's message that came in meanwhile is answered first; otherwise a turn out of time goes on
        const followed = fixing ? null : await queueFollowUp(db, thread.id, now());
        if (!fixing && !followed && goesOnAfterTimeout) {
          const actor = message.created_by && message.actor_role ? { id: message.created_by, role: message.actor_role } : null;
          await postSystemMessage(db, { threadId: thread.id, text: timeoutNote(out.timeout, o), trigger: "timeout", continueAgent: true, actor }, now());
        }
      }
      await auditTurn(message, thread.video_id, project, out, Date.now() - started, changed);
    } catch (e) {
      logger.error("agent turn crashed", { message_id: messageId, error: e instanceof Error ? e.message : String(e) });
      await finishTurn(db, messageId, { status: "failed", text: (await getMessage(db, messageId))?.text ?? "", parts: [], error: "Studio gặp lỗi khi chạy lượt này" }, now());
    } finally {
      clearInterval(watch);
      signal?.removeEventListener("abort", onStop);
    }
  }

  /**
   * The turn in the activity log, and each of Claude's own tools it used (Read, Write, Edit, Glob, Grep, Skill; the
   * Studio tools are logged by the API as they are called): who it acted for, how it ended, time, cost, files changed.
   */
  async function auditTurn(message: MessageRecord, videoId: string | null, project: { id: string; team_id: string }, out: AgentTurnOutcome, ms: number, changed: string[]) {
    const where = { teamId: project.team_id, projectId: project.id, videoId, threadId: message.thread_id, messageId: message.id };
    const r = out.state.result;
    await logAudit(db, {
      ...where, actorKind: "agent", actorId: message.created_by, kind: "turn", action: "turn", at: now(), durationMs: ms,
      outcome: out.status === "done" || out.status === "max_turns" || out.status === "cancelled" ? "ok" : "error",
      summary: out.error ?? (out.status === "done" ? null : out.status), costUsd: r?.cost_usd ?? null,
      details: {
        status: out.status, trigger: message.trigger, model: out.state.model ?? null, inputTokens: r?.input_tokens ?? null, outputTokens: r?.output_tokens ?? null,
        numTurns: r?.num_turns ?? null, changed,
        answerChars: finalAnswer(out.state.parts).length, thinAnswer: thinAnswer(out.state.parts, changed),
      },
    }, (e) => logger.warn("turn not in the activity log", { error: String(e) }));
    for (const p of out.state.parts) {
      if (p.kind !== "tool" || p.name.startsWith("mcp__")) continue;
      const input = (p.input ?? {}) as Record<string, unknown>;
      const target = ["file_path", "path", "pattern", "skill", "notebook_path"].map((k) => input[k]).find((v) => typeof v === "string") as string | undefined;
      await logAudit(db, {
        ...where, actorKind: "agent", actorId: message.created_by, kind: "tool", action: p.name, outcome: p.is_error ? "error" : "ok", at: p.started_at,
        durationMs: p.ended_at ? Date.parse(p.ended_at) - Date.parse(p.started_at) : null, target: target ?? null,
        summary: p.is_error ? (p.result ?? "").slice(0, 300) : null,
        details: { input: Object.fromEntries(Object.entries(input).filter(([k]) => !["content", "new_string", "old_string", "edits"].includes(k))) },
      }, (e) => logger.warn("tool call not in the activity log", { error: String(e) }));
    }
  }

  /** After a turn: files it wrote that do not check out get one turn to fix them (said in the thread). */
  async function askToFix(threadId: string, dir: string, changed: string[], message: MessageRecord): Promise<boolean> {
    const broken = changed.map((path) => ({ path, issues: validateWorkspaceFile(dir, path).filter((i) => i.level === "error") }))
      .filter((x) => hasErrors(x.issues));
    if (!broken.length) return false;
    const text = [
      "Studio kiểm các file vừa ghi và thấy lỗi (Studio chưa dùng được các file này):",
      ...broken.flatMap((b) => b.issues.slice(0, 5).map((i) => `- \`${b.path}\`: ${i.message}`)),
      "Hãy sửa các lỗi trên.",
    ].join("\n");
    const actor = message.created_by && message.actor_role ? { id: message.created_by, role: message.actor_role } : null;
    await postSystemMessage(db, { threadId, text, trigger: "autofix", continueAgent: true, actor }, now());
    return true;
  }

  function writeStudioFile(dir: string, name: string, text: string) {
    mkdirSync(join(dir, ".studio"), { recursive: true });
    writeFileSync(join(dir, ".studio", name), text);
  }

  async function writeHistory(threadId: string, dir: string) {
    const thread = await getThread(db, threadId);
    if (!thread) return;
    const folder = join(dir, ".studio", "history");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${thread.id}.md`), await threadMarkdown(db, thread));
  }

  const start = (id: string, signal?: AbortSignal) => {
    const beat = setInterval(() => { void heartbeatClaudeSlot(db, "agent", id, now()).catch((e: unknown) => logger.warn("agent slot not heartbeated", { message_id: id, error: String(e) })); }, o.heartbeatMs ?? (CHAT_SLOT_LEASE_SECONDS * 1000) / 4);
    const done = (async () => {
      try { await runTurn(id, signal); }
      finally {
        clearInterval(beat);
        await releaseClaudeSlot(db, "agent", id).catch((e: unknown) => logger.warn("agent slot not released", { message_id: id, error: String(e) }));
        inFlight.delete(id);
      }
    })();
    inFlight.set(id, done);
  };

  const tick = async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    const holding = await idsHoldingSlots(db, "agent");
    for (const id of await orphanedAgentTurns(db, [...holding, ...inFlight.keys()])) {
      logger.warn("agent turn left running by a stopped worker; it resumes", { message_id: id });
      await requeueAgentTurn(db, id, now());
    }
    const cap = await o.cap();
    const ready = (await nextPendingAgentTurns(db, now(), cap * 2)).filter((t) => !inFlight.has(t.id));
    const readyIds = new Set(ready.map((t) => t.id));
    for (const id of [...waiting]) if (!readyIds.has(id)) { await releaseClaudeSlot(db, "agent", id); waiting.delete(id); }
    for (const t of ready) {
      if (inFlight.has(t.id)) continue;
      if (!(await acquireClaudeSlot(db, "agent", t.id, cap, now()))) { waiting.add(t.id); continue; }
      waiting.delete(t.id);
      if (!(await markAgentTurnRunning(db, t.id, now()))) { await releaseClaudeSlot(db, "agent", t.id); continue; }
      start(t.id, signal);
    }
    if (!ready.length && !waiting.size) await maybeSummarize(cap);
  };

  return {
    tick,
    get running() { return inFlight.size; },
    idle: async () => { while (inFlight.size || summarizing) await Promise.all([...inFlight.values(), summarizing]); },
    runForever: async (signal) => {
      while (!signal.aborted) {
        try { await tick(signal); }
        catch (e) { logger.error("agent loop failed; keeps polling", { error: e instanceof Error ? e.message : String(e) }); }
        await new Promise<void>((res) => {
          const onAbort = () => { clearTimeout(t); res(); };
          const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); res(); }, o.pollMs ?? 1000);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      for (const id of waiting) await releaseClaudeSlot(db, "agent", id).catch(() => undefined);
      waiting.clear();
      while (inFlight.size || summarizing) await Promise.all([...inFlight.values(), summarizing]);
    },
  };
}
