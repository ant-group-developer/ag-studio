/**
 * Where a project and a video stand on the playbook (spec 2026-10-10 agent-workspace §6): each step `missing`,
 * `draft`, `invalid`, `done`, `skipped`, `stale` (done, but a step it builds on changed since) or `running`, from the
 * files and what Studio knows — and the next steps to suggest. Nothing here blocks anything.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PlaybookStep, StepStatus, StudioPlaybook } from "@harness/contracts";
import type { StudioDb } from "../studio-db.js";
import { docStatus } from "./frontmatter.js";
import { loadPlaybook, stepPath } from "./playbook.js";
import { hasErrors, validateWorkspaceFile, type FileIssue } from "./validators.js";
import { studioStepFacts } from "./step-facts.js";

/** What Studio knows of a `studio` step (inputs prepared, timeline built, render done…). */
export interface StepFact { status: "done" | "running" | "missing"; detail?: string }

export interface StepOutputState { path: string; role: "doc" | "data" | "studio"; exists: boolean; issues: FileIssue[] }

export interface StepState {
  key: string;
  scope: "project" | "video";
  title: string;
  description: string;
  skill: string | null;
  optional: boolean;
  requires: string[];
  status: StepStatus;
  outputs: StepOutputState[];
  issues: FileIssue[];
  /** The file a person opens for the step. */
  primary: string;
  prompts: { do: string; redo: string | null; revise: string | null };
  /** For a stale step: the steps it builds on that changed after it was done. */
  staleBecause: string[];
  detail: string | null;
}

export interface PlaybookStatus {
  custom: boolean;
  issues: FileIssue[];
  project: StepState[];
  video: StepState[] | null;
  /** Up to three steps to suggest next (project steps first). */
  next: { scope: "project" | "video"; key: string }[];
}

const fill = (s: string | undefined, videoId: string | null, file: string) => (s ? stepPath(s, videoId).replace(/\{file\}/g, file) : null);

function digestOf(dir: string, paths: string[]): string {
  const h = createHash("sha256");
  for (const p of paths) {
    const abs = join(dir, ...p.split("/"));
    h.update(p).update("\0");
    if (existsSync(abs) && statSync(abs).isFile()) h.update(readFileSync(abs));
    h.update("\0");
  }
  return h.digest("hex");
}

function baseStatus(dir: string, s: PlaybookStep, outputs: StepOutputState[], fact: StepFact | undefined): { status: StepStatus; detail: string | null } {
  const errors = outputs.some((o) => hasErrors(o.issues));
  if (s.done_when === "studio") {
    if (fact) return { status: fact.status === "done" ? (errors ? "invalid" : "done") : fact.status === "running" ? "running" : "missing", detail: fact.detail ?? null };
    return { status: outputs.every((o) => o.exists) ? (errors ? "invalid" : "done") : "missing", detail: null };
  }
  const primary = outputs[0]!;
  if (!primary.exists) return { status: "missing", detail: null };
  if (s.done_when === "files_valid") {
    if (!outputs.every((o) => o.exists)) return { status: "draft", detail: null };
    return { status: errors ? "invalid" : "done", detail: null };
  }
  const text = readFileSync(join(dir, ...primary.path.split("/")), "utf8");
  const doc = docStatus(text);
  if (doc === "skipped") return { status: "skipped", detail: null };
  if (errors) return { status: "invalid", detail: null };
  if (doc === "done" && outputs.every((o) => o.exists || o.role === "studio")) return { status: "done", detail: null };
  return { status: "draft", detail: null };
}

/** The steps of one scope, with the marks of done steps kept up to date (stale detection). */
function scopeStates(db: StudioDb | null, dir: string, playbook: StudioPlaybook, scope: "project" | "video", o: {
  projectId: string; videoId: string | null; facts?: ((key: string, videoId: string | null) => StepFact | undefined) | undefined;
  upstreamDigests: Map<string, string>; now: string;
}): StepState[] {
  const states: StepState[] = [];
  for (const s of playbook.steps.filter((x) => x.scope === scope)) {
    const outputs = s.outputs.map((out) => {
      const path = stepPath(out.path, o.videoId);
      const abs = join(dir, ...path.split("/"));
      const exists = existsSync(abs);
      return { path, role: out.role, exists, issues: exists && out.role !== "studio" ? validateWorkspaceFile(dir, path) : [] };
    });
    const paths = outputs.map((x) => x.path);
    const digest = digestOf(dir, paths);
    o.upstreamDigests.set(s.key, digest);
    let { status, detail } = baseStatus(dir, s, outputs, o.facts?.(s.key, o.videoId));
    let staleBecause: string[] = [];
    if (db && status === "done") {
      const vid = scope === "video" ? o.videoId ?? "" : "";
      const mark = db.get<{ output_digest: string; upstream: string }>(
        "SELECT output_digest, upstream FROM step_marks WHERE project_id = ? AND video_id = ? AND step_key = ?", [o.projectId, vid, s.key]);
      const upstreamNow = Object.fromEntries(s.requires.map((r) => [r, o.upstreamDigests.get(r) ?? ""]));
      if (!mark || mark.output_digest !== digest) {
        db.run(
          `INSERT INTO step_marks (project_id, video_id, step_key, output_digest, upstream, marked_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, video_id, step_key) DO UPDATE SET output_digest = excluded.output_digest, upstream = excluded.upstream, marked_at = excluded.marked_at`,
          [o.projectId, vid, s.key, digest, JSON.stringify(upstreamNow), o.now]);
      } else {
        const before = JSON.parse(mark.upstream) as Record<string, string>;
        staleBecause = s.requires.filter((r) => before[r] !== undefined && before[r] !== upstreamNow[r]);
        if (staleBecause.length) status = "stale";
      }
    }
    const primary = paths[0]!;
    states.push({
      key: s.key, scope, title: s.title, description: s.description, skill: s.skill ?? null, optional: s.optional, requires: s.requires,
      status, outputs, issues: outputs.flatMap((x) => x.issues.map((i) => ({ ...i, message: `${x.path}: ${i.message}` }))), primary,
      prompts: { do: fill(s.prompts.do, o.videoId, primary)!, redo: fill(s.prompts.redo, o.videoId, primary), revise: fill(s.prompts.revise, o.videoId, primary) },
      staleBecause, detail,
    });
  }
  return states;
}

const OPEN: StepStatus[] = ["missing", "draft", "invalid", "stale"];
const FINE: StepStatus[] = ["done", "skipped"];

/** The playbook's state for the project (and one video). `db` keeps the stale marks; without it nothing is stale. */
export function playbookStatus(db: StudioDb | null, dir: string, o: {
  projectId: string; videoId?: string | null; facts?: (key: string, videoId: string | null) => StepFact | undefined; now?: string;
}): PlaybookStatus {
  const { playbook, custom, issues } = loadPlaybook(dir);
  const now = o.now ?? new Date().toISOString();
  const digests = new Map<string, string>();
  // Studio's own steps (preparing inputs…) from the database, unless the caller says otherwise
  const facts = o.facts ?? (db ? studioStepFacts(db, o.projectId) : undefined);
  const project = scopeStates(db, dir, playbook, "project", { projectId: o.projectId, videoId: null, facts, upstreamDigests: digests, now });
  const video = o.videoId ? scopeStates(db, dir, playbook, "video", { projectId: o.projectId, videoId: o.videoId, facts, upstreamDigests: digests, now }) : null;
  const byKey = new Map([...project, ...(video ?? [])].map((s) => [s.key, s]));
  const next: PlaybookStatus["next"] = [];
  for (const s of [...project, ...(video ?? [])]) {
    if (next.length >= 3) break;
    if (!OPEN.includes(s.status) || (s.optional && s.status === "missing")) continue;
    if (s.requires.every((r) => FINE.includes(byKey.get(r)?.status ?? "missing"))) next.push({ scope: s.scope, key: s.key });
  }
  return { custom, issues, project, video, next };
}

const ICON: Record<StepStatus, string> = { done: "✓", skipped: "–", draft: "✎", invalid: "✗", stale: "↻", missing: "·", running: "…" };

/** A few lines for the agent's `<studio_context>`: the steps with their state, the next ones, the files with errors. */
export function playbookContextLines(st: PlaybookStatus): string[] {
  const line = (states: StepState[]) => states.map((s) => `${s.key} ${ICON[s.status]}${s.status === "stale" ? `(do ${s.staleBecause.join(",")} đổi)` : ""}`).join(" · ");
  const lines = ["Tiến độ theo quy trình gợi ý (✓ xong, ✎ nháp, ✗ lỗi, ↻ cũ, · chưa có, – bỏ qua; chỉ là gợi ý, không bắt buộc):", `- Kênh: ${line(st.project)}`];
  if (st.video) lines.push(`- Video này: ${line(st.video)}`);
  const all = [...st.project, ...(st.video ?? [])];
  if (st.next.length) {
    lines.push(`Bước gợi ý tiếp theo: ${st.next.map((n) => { const s = all.find((x) => x.key === n.key)!; return `${s.title} (${s.primary})`; }).join("; ")}`);
  }
  const errors = all.flatMap((s) => s.issues.filter((i) => i.level === "error")).slice(0, 5);
  if (errors.length) lines.push("File đang lỗi (Studio không dùng được tới khi sửa):", ...errors.map((e) => `- ${e.message}`));
  if (st.issues.length) lines.push(...st.issues.map((i) => `- ${i.message}`));
  lines.push("Chi tiết: .studio/status.json");
  return lines;
}
