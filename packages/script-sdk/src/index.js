// @harness/script-sdk — no dependencies beyond node builtins. Talks to the harness only through files in the workspace,
// stdout JSON lines, and the `harness op …` CLI (child process). See README.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * @typedef {import("./index.js").StageRequestLike} StageRequestLike
 * @typedef {import("./index.js").StartOptions} StartOptions
 * @typedef {import("./index.js").ScriptContext} ScriptContext
 * @typedef {import("./index.js").OperationRecord} OperationRecord
 */

/** @param {any} v @returns {any} */
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
/** @param {Buffer | string} buf @returns {string} */
const sha256 = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");
/** @param {string} path @returns {{ checksum: string, size_bytes: number }} */
function sha256File(path) { const h = createHash("sha256"); h.update(readFileSync(path)); return { checksum: "sha256:" + h.digest("hex"), size_bytes: statSync(path).size }; }
/** @param {string} root @param {string} dir @param {string[]} out @returns {void} */
function walk(root, dir, out) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(root, p, out); else if (e.isFile()) out.push(p); } }
/**
 * Same listing + digest as the harness core (`listDirectoryFiles` / `directoryDigest`).
 * @param {string} dir
 * @returns {{ entries: { path: string, checksum: string, size_bytes: number }[], checksum: string, size_bytes: number }}
 */
export function directoryListing(dir) {
  /** @type {string[]} */
  const files = []; walk(dir, dir, files);
  const entries = files.map((f) => ({ path: relative(dir, f).split(sep).join("/"), ...sha256File(f) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, checksum: sha256(JSON.stringify(sortKeys(entries))), size_bytes: entries.reduce((n, e) => n + e.size_bytes, 0) };
}

/**
 * @param {StartOptions} [opts]
 * @returns {Promise<ScriptContext>}
 */
export async function start(opts = {}) {
  const env = opts.env ?? process.env;
  const io = {
    stdout: opts.io?.stdout ?? ((/** @type {string} */ line) => process.stdout.write(line + "\n")),
    exit: opts.io?.exit ?? ((/** @type {number} */ code) => { process.exitCode = code; }),
  };
  const workspace = resolve(env.HARNESS_WORKSPACE ?? opts.workspace ?? process.cwd());
  const request = /** @type {StageRequestLike} */ (JSON.parse(readFileSync(join(workspace, "stage-request.json"), "utf8")));
  /** @type {{ path: string, type: string, checksum: string, size_bytes: number, kind: "file" | "directory" }[]} */
  const outputs = [];
  /** @param {string} rel @returns {string} */
  const abs = (rel) => (isAbsolute(rel) ? rel : join(workspace, rel));
  /** @param {string} rel @returns {string} */
  const relPosix = (rel) => rel.split("\\").join("/").replace(/\/+$/, "");
  /** @returns {string[]} */
  const cliArgv = () => { const raw = env.HARNESS_CLI_ARGV; if (!raw) throw new Error("HARNESS_CLI_ARGV is not set: ctx.op.* needs the harness CLI"); return JSON.parse(raw); };
  /** @returns {string} */
  const attemptId = () => { const v = env.HARNESS_ATTEMPT_ID; if (!v) throw new Error("HARNESS_ATTEMPT_ID is not set: ctx.op.* needs the attempt id"); return v; };
  /** @returns {string} */
  const fencingToken = () => { const v = env.HARNESS_FENCING_TOKEN; if (!v) throw new Error("HARNESS_FENCING_TOKEN is not set: ctx.op.* needs the fencing token"); return v; };
  /** @param {string[]} args @returns {OperationRecord} */
  const cli = (args) => {
    const argv = cliArgv();
    const cmd = /** @type {string} */ (argv[0]);
    const rest = argv.slice(1);
    const r = spawnSync(cmd, [...rest, "--project", env.HARNESS_PROJECT ?? process.cwd(), ...args, "--json"], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
    if (r.error) throw new Error(`harness ${args.join(" ")} could not start: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`harness ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
    const lastLine = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
    try { return JSON.parse(lastLine); }
    catch { throw new Error(`harness ${args.join(" ")} returned no JSON: ${JSON.stringify((r.stdout ?? "").trim())}`); }
  };
  /** @param {Record<string, any>} partial @returns {any} */
  const writeResult = (partial) => {
    const result = { schema_version: "harness.stage-result/v1", attempt_id: request.attempt_id, outputs, checks: [], usage: { wall_seconds: 0, cost_usd: 0 }, external_operations: [], errors: [], ...partial };
    writeFileSync(join(workspace, "stage-result.json"), JSON.stringify(result, null, 2));
    io.exit(0);
    return result;
  };
  /** @param {"info" | "warn" | "error"} level @returns {(msg: string, data?: Record<string, unknown>) => void} */
  const log = (level) => (msg, data = {}) => io.stdout(JSON.stringify({ level, msg, ...data }));
  return {
    request, workspace, options: request.options ?? {}, sources: request.source_items ?? [],
    input(typeOrPath) {
      const i = (request.inputs ?? []).find((x) => x.type === typeOrPath) ?? (request.inputs ?? []).find((x) => x.path === typeOrPath || x.path.endsWith("/" + typeOrPath));
      if (!i) throw new Error(`no input with type or path "${typeOrPath}" (have: ${(request.inputs ?? []).map((x) => `${x.type}:${x.path}`).join(", ") || "none"})`);
      return abs(i.path);
    },
    inputs(type) { return (request.inputs ?? []).filter((x) => x.type === type).map((x) => abs(x.path)); },
    hasInput(type) { return (request.inputs ?? []).some((x) => x.type === type); },
    source(i) { const s = (request.source_items ?? [])[i]; if (!s) throw new Error(`no source item at index ${i}`); return s; },
    hasResource(name) { return (request.resources ?? []).includes(name); },
    out: {
      async file(rel, o) { const p = abs(rel); if (!existsSync(p)) throw new Error(`output missing: ${rel}`); outputs.push({ path: relPosix(rel), type: o.type, ...sha256File(p), kind: "file" }); },
      async dir(rel, o) { const p = abs(rel); if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`output directory missing: ${rel}`); const { checksum, size_bytes } = directoryListing(p); outputs.push({ path: relPosix(rel), type: o.type, checksum, size_bytes, kind: "directory" }); },
      clear() { const dir = join(workspace, "output"); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); outputs.length = 0; },
    },
    heartbeat(p = {}) { writeFileSync(join(workspace, "progress.json"), JSON.stringify({ ...p, at: new Date().toISOString() })); },
    log: { info: log("info"), warn: log("warn"), error: log("error") },
    async done(o = {}) { return writeResult({ outcome: "succeeded", usage: { wall_seconds: o.wall_seconds ?? 0, cost_usd: o.cost_usd ?? 0 }, external_operations: o.external_operations ?? [] }); },
    async fail(kind, message, details = {}) { return writeResult({ outcome: "failed", outputs: [], errors: [{ kind, message, details }] }); },
    async unknown(message, external_operations = []) { return writeResult({ outcome: "unknown", outputs: [], external_operations, errors: [{ kind: "unknown", message, details: {} }] }); },
    op: {
      async intent(p) { return cli(["op", "intent", "--attempt", attemptId(), "--fencing-token", fencingToken(), "--provider", p.provider, "--kind", p.kind, "--target", p.target, "--payload", JSON.stringify(p.payload ?? {})]); },
      async confirm(operationId, r) { return cli(["op", "confirm", operationId, "--fencing-token", fencingToken(), "--provider-ref", r.provider_ref, "--receipt", JSON.stringify(r.receipt ?? {}), ...(r.cost_usd !== undefined ? ["--cost-usd", String(r.cost_usd)] : [])]); },
      async lost(operationId, reason) { return cli(["op", "lost", operationId, "--fencing-token", fencingToken(), "--reason", reason]); },
    },
  };
}
