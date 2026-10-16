/**
 * The answer a turn leaves a person: the text after its last step, the way the chat folds a turn (`splitTurn` of the
 * web; `suggest_replies` is not a step). On prod 24 turns ended with nothing but "Bạn chọn…" after work that wrote
 * files or started jobs; the activity log marks such a turn (`thinAnswer`) so the prompt's rule can be checked.
 */
import type { AgentPart } from "@harness/adapter-agent-cli";

const SUGGEST_REPLIES = "mcp__studio__suggest_replies";
/** An answer shorter than this, after a turn that did something, says too little of what was done. */
export const THIN_ANSWER_CHARS = 120;

export function finalAnswer(parts: readonly AgentPart[]): string {
  let last = -1;
  parts.forEach((p, i) => { if (p.kind === "tool" && p.name !== SUGGEST_REPLIES) last = i; });
  return parts.slice(last + 1).flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("").trim();
}

/** The turn changed files or started a background job (a Studio tool that answered with a `job_id`) and its answer
 * is under `THIN_ANSWER_CHARS`. */
export function thinAnswer(parts: readonly AgentPart[], changed: readonly string[]): boolean {
  const startedJob = parts.some((p) => p.kind === "tool" && p.name.startsWith("mcp__studio__") && /"job_id"/.test(p.result ?? ""));
  return (changed.length > 0 || startedJob) && finalAnswer(parts).length < THIN_ANSWER_CHARS;
}
