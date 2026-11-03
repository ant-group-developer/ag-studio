/**
 * Pictures made by Codex's own image tool (`$imagegen`, gpt-image-2) on a ChatGPT plan's login (plan 2026-11-03
 * codex-imagegen, option B): no OpenAI API key, so nothing is billed per picture; the plan's quota pays.
 *
 * `codex exec` runs once per picture, in an empty folder, with no user config (`--ignore-user-config`, so a proxy
 * provider, MCP servers or a notify hook of the machine never apply), no session kept (`--ephemeral`), a read-only
 * sandbox and never asking. Its `CODEX_HOME` is Studio's own (`STUDIO_CODEX_HOME`, where someone ran
 * `codex login --device-auth`); the child gets no API key — with one Codex would bill the API instead — and no Studio
 * secret. The prompt goes on stdin (`-i <FILE>...` would swallow a prompt after it). `--json` says nothing of the
 * picture, only the thread: Codex saves it at `$CODEX_HOME/generated_images/<thread id>/<call>.png`, which is copied
 * out and removed.
 *
 * The tool takes no size or quality (both `auto`): the prompt asks for the shape, the caller crops.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { defaultResolveDeps, killTree, resolveCommand } from "@harness/adapter-agent-cli";

const LOGIN_TIMEOUT_MS = 30_000;
/** One picture takes 1–4 minutes; past this it is given up. */
export const CODEX_IMAGE_TIMEOUT_MS = 10 * 60_000;
/** Codex's tool takes at most this many pictures to edit or follow. */
export const CODEX_IMAGE_MAX_REFERENCES = 5;
const PROMPT_MAX = 4000;
const DETAIL_MAX = 300;

/** How Codex is logged in: only `chatgpt` makes pictures here. */
export type CodexLogin = "chatgpt" | "api_key" | "none";

/** Why a picture was not made, as a code the job and the agent act on. */
export type CodexImageFailureCode =
  | "not_installed" | "not_logged_in" | "api_key_login" | "rate_limited" | "refused" | "no_image" | "timeout" | "cancelled" | "other";

/** What each code says, in the words the chat and the job show. */
export const CODEX_IMAGE_FAILURE_REASON: Record<Exclude<CodexImageFailureCode, "other">, string> = {
  not_installed: "máy này không chạy được Codex CLI (chưa cài hoặc sai STUDIO_CODEX_PATH)",
  not_logged_in: "Codex của Studio chưa đăng nhập tài khoản ChatGPT (chạy codex login --device-auth với CODEX_HOME của Studio)",
  api_key_login: "Codex của Studio đang đăng nhập bằng API key, không phải tài khoản ChatGPT; Studio không tạo ảnh tính tiền API",
  rate_limited: "tài khoản ChatGPT đã hết hạn mức tạo ảnh, thử lại sau",
  refused: "ảnh bị từ chối vì chính sách nội dung của OpenAI",
  no_image: "Codex trả lời nhưng không tạo ảnh",
  timeout: "tạo ảnh quá 10 phút, đã dừng",
  cancelled: "đã dừng",
};

export interface CodexImageFailure { code: CodexImageFailureCode; reason: string; detail: string }

export class CodexImageError extends Error {
  readonly code: CodexImageFailureCode;
  readonly reason: string;
  readonly detail: string;
  constructor(f: CodexImageFailure) {
    super(f.detail && f.code !== "other" ? `${f.reason} (${f.detail})` : f.reason);
    this.name = "CodexImageError";
    this.code = f.code;
    this.reason = f.reason;
    this.detail = f.detail;
  }
}

const fail = (code: Exclude<CodexImageFailureCode, "other">, detail = "") => new CodexImageError({ code, reason: CODEX_IMAGE_FAILURE_REASON[code], detail });

function trimDetail(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX - 1)}…` : t;
}

/** Codex's words when a turn fails -> a code (most specific first) and the start of those words. */
export function classifyCodexFailure(message: string): CodexImageFailure {
  const l = message.toLowerCase();
  const code: CodexImageFailureCode =
    /usage limit|rate[ _-]?limit|too many requests|\b429\b|quota/.test(l) ? "rate_limited"
    : /not logged in|log ?in again|unauthori[sz]ed|\b401\b|refresh token|token (has )?expired|sign in/.test(l) ? "not_logged_in"
    : /safety|moderation|content policy|policy violation|not allowed to generate|rejected/.test(l) ? "refused"
    : "other";
  const detail = trimDetail(message);
  return { code, reason: code === "other" ? (detail ? `Codex: ${detail}` : "Codex lỗi, không rõ lý do") : CODEX_IMAGE_FAILURE_REASON[code], detail };
}

/** `codex login status` -> how it is logged in. */
export function parseCodexLogin(out: string): CodexLogin {
  if (/logged in using chatgpt/i.test(out)) return "chatgpt";
  if (/logged in using an api key/i.test(out)) return "api_key";
  return "none";
}

export interface CodexRunFacts {
  threadId: string | null;
  /** The turn's own failure (`turn.failed`, `error`), when there was one. */
  failure: string | null;
  /** The agent's last words (a refusal is often only said there). */
  lastMessage: string | null;
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } | null;
}

/** The `--json` lines of one `codex exec` -> what Studio keeps. Lines that are not JSON are skipped. */
export function parseCodexEvents(stdout: string): CodexRunFacts {
  const facts: CodexRunFacts = { threadId: null, failure: null, lastMessage: null, usage: null };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (e.type === "thread.started" && typeof e.thread_id === "string") facts.threadId = e.thread_id;
    else if (e.type === "turn.failed") {
      const err = e.error as { message?: unknown } | undefined;
      facts.failure = typeof err?.message === "string" ? err.message : facts.failure ?? "turn failed";
    } else if (e.type === "error" && typeof e.message === "string") facts.failure ??= e.message;
    else if (e.type === "item.completed") {
      const item = e.item as { type?: unknown; text?: unknown } | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") facts.lastMessage = item.text;
    } else if (e.type === "turn.completed") {
      const u = e.usage as Record<string, unknown> | undefined;
      const n = (k: string) => (typeof u?.[k] === "number" ? (u[k] as number) : 0);
      if (u) facts.usage = { input_tokens: n("input_tokens"), cached_input_tokens: n("cached_input_tokens"), output_tokens: n("output_tokens") };
    }
  }
  return facts;
}

export interface CodexImageRequest {
  /** What to draw (or how to change the references); Studio's own words around it say how to call the tool. */
  prompt: string;
  /** Absolute paths of pictures to edit or follow (≤ 5): a render's frame for a thumbnail, a logo for a banner. */
  references?: readonly string[];
  transparentBackground?: boolean;
  /** Where the PNG goes. */
  out: string;
  signal?: AbortSignal;
}

export interface CodexImageResult {
  out: string;
  threadId: string;
  seconds: number;
  usage: CodexRunFacts["usage"];
}

/** The whole prompt Codex gets: call the tool once with these arguments, nothing else. */
export function codexImagePrompt(r: Pick<CodexImageRequest, "prompt" | "references" | "transparentBackground">): string {
  const refs = r.references ?? [];
  const args = [
    refs.length ? `referenced_image_paths: ${JSON.stringify(refs)}` : null,
    `transparent_background: ${r.transparentBackground ? "true" : "false"}`,
  ].filter(Boolean).join(", ");
  return [
    "Use the $imagegen tool exactly once, then stop. Do not run shell commands, do not read or write files, do not ask questions.",
    `Call it with ${args} and this prompt:`,
    "",
    r.prompt.trim(),
    "",
    "When it is done, reply with only the word DONE.",
  ].join("\n");
}

/**
 * The child's environment: what a program needs to start and find its home, plus `CODEX_HOME`. Nothing else of the
 * worker's — no `OPENAI_API_KEY`/`CODEX_API_KEY` (Codex would bill the API), no Studio secret.
 */
export function codexChildEnv(codexHome: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|TEMP|TMP|TMPDIR|LANG|LC_ALL|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS_PROXY|HTTP_PROXY|NO_PROXY|FAKE_CODEX_[A-Z_]+)$/i;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && keep.test(k)) out[k] = v;
  out.CODEX_HOME = codexHome;
  return out;
}

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }

export interface CodexImager {
  /** The version Codex reports; null when it cannot run. */
  version(): Promise<string | null>;
  /** How Studio's Codex is logged in; null when Codex cannot run. */
  login(): Promise<CodexLogin | null>;
  /** One picture; throws a `CodexImageError` saying why when none is made. */
  generate(r: CodexImageRequest): Promise<CodexImageResult>;
}

export interface CodexImagerOptions {
  /** The program and its first arguments, e.g. `["codex"]` (tests: node and a fake script). */
  argv: readonly string[];
  /** Studio's `CODEX_HOME`, holding the ChatGPT login (`auth.json`). */
  codexHome: string;
  timeoutMs?: number;
}

export function codexImager(o: CodexImagerOptions): CodexImager {
  const [first, ...head] = o.argv;
  if (!first) throw new Error("codex argv is empty");
  const env = codexChildEnv(o.codexHome);
  const resolved = resolveCommand(first, defaultResolveDeps(process.env.PATH ?? process.env.Path));
  const bin = resolved.cmd;
  const prefix = [...resolved.prefixArgs, ...head];
  const timeoutMs = o.timeoutMs ?? CODEX_IMAGE_TIMEOUT_MS;

  function run(args: string[], p: { timeoutMs: number; stdin?: string; cwd?: string; signal?: AbortSignal }): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, [...prefix, ...args], {
        stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true, detached: process.platform !== "win32", ...(p.cwd ? { cwd: p.cwd } : {}),
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      const stop = () => { if (child.pid) killTree(child.pid); else child.kill("SIGKILL"); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, p.timeoutMs);
      const onAbort = () => { aborted = true; stop(); };
      if (p.signal?.aborted) onAbort();
      p.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-8000); });
      child.stdin.on("error", () => { /* closed early: the exit says why */ });
      child.stdin.end(p.stdin ?? "");
      const done = () => { clearTimeout(timer); p.signal?.removeEventListener("abort", onAbort); };
      child.on("error", (e) => { done(); reject(e); });
      child.on("close", (code) => { done(); resolve({ code, stdout, stderr, timedOut, aborted }); });
    });
  }

  async function login(): Promise<CodexLogin | null> {
    try {
      const r = await run(["login", "status"], { timeoutMs: LOGIN_TIMEOUT_MS });
      return parseCodexLogin(`${r.stdout}\n${r.stderr}`);
    } catch {
      return null;
    }
  }

  return {
    async version() {
      try {
        const r = await run(["--version"], { timeoutMs: LOGIN_TIMEOUT_MS });
        return r.code === 0 ? r.stdout.trim() || null : null;
      } catch {
        return null;
      }
    },

    login,

    async generate(r) {
      const refs = [...(r.references ?? [])];
      if (!r.prompt.trim()) throw new Error("codex image: empty prompt");
      if (r.prompt.length > PROMPT_MAX) throw new Error(`codex image: prompt longer than ${PROMPT_MAX} characters`);
      if (refs.length > CODEX_IMAGE_MAX_REFERENCES) throw new Error(`codex image: at most ${CODEX_IMAGE_MAX_REFERENCES} references`);
      for (const ref of refs) if (!isAbsolute(ref) || !existsSync(ref)) throw new Error(`codex image: reference not found: ${ref}`);

      const how = await login();
      if (how === null) throw fail("not_installed");
      if (how === "api_key") throw fail("api_key_login");
      if (how === "none") throw fail("not_logged_in");

      const work = mkdtempSync(join(tmpdir(), "studio-codex-image-"));
      const started = Date.now();
      try {
        const args = [
          "exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
          "-s", "read-only", "-c", 'approval_policy="never"', "--enable", "image_generation", "-C", work,
          ...refs.flatMap((ref) => ["-i", ref]), "-",
        ];
        const res = await run(args, { timeoutMs, stdin: codexImagePrompt({ ...r, references: refs }), cwd: work, ...(r.signal ? { signal: r.signal } : {}) });
        if (res.aborted) throw fail("cancelled");
        if (res.timedOut) throw fail("timeout");
        const facts = parseCodexEvents(res.stdout);
        const picture = facts.threadId ? newestPicture(join(o.codexHome, "generated_images", facts.threadId)) : null;
        if (!picture) {
          if (facts.failure) throw new CodexImageError(classifyCodexFailure(facts.failure));
          if (res.code !== 0) throw new CodexImageError(classifyCodexFailure(res.stderr.trim() || `codex exited ${String(res.code)}`));
          const said = classifyCodexFailure(facts.lastMessage ?? "");
          throw said.code === "refused" || said.code === "rate_limited" ? new CodexImageError(said) : fail("no_image", trimDetail(facts.lastMessage ?? ""));
        }
        mkdirSync(dirname(r.out), { recursive: true });
        copyFileSync(picture, r.out);
        rmSync(dirname(picture), { recursive: true, force: true });
        return { out: r.out, threadId: facts.threadId!, seconds: Math.round((Date.now() - started) / 100) / 10, usage: facts.usage };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}

/** The last picture Codex saved in a thread's folder (a turn that called the tool twice keeps the second). */
function newestPicture(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /\.png$/i.test(f)).map((f) => join(dir, f));
  return files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1) ?? null;
}

/** What a failure was, when it is a Codex image one (else null). */
export const codexImageFailureOf = (e: unknown): CodexImageFailure | null =>
  e instanceof CodexImageError ? { code: e.code, reason: e.reason, detail: e.detail } : null;
