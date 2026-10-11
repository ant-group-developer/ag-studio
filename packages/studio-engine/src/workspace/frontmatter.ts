/**
 * The YAML block at the head of a workspace markdown file (`---\n…\n---`): where a step's document keeps its
 * `status` (draft, done, skipped) and the fields Studio reads (spec 2026-10-10 agent-workspace §6).
 */
import { parse, stringify } from "yaml";

const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

export interface Frontmatter {
  /** The parsed block (`{}` when there is none). */
  data: Record<string, unknown>;
  /** Whether the file has a block at all. */
  present: boolean;
  /** The markdown after the block. */
  body: string;
  /** Why the block could not be read (bad YAML, not a mapping). */
  error: string | null;
}

export function readFrontmatter(text: string): Frontmatter {
  const m = BLOCK.exec(text);
  if (!m) return { data: {}, present: false, body: text, error: null };
  const body = text.slice(m[0].length);
  try {
    const data = parse(m[1]!) as unknown;
    if (data === null || data === undefined) return { data: {}, present: true, body, error: null };
    if (typeof data !== "object" || Array.isArray(data)) return { data: {}, present: true, body, error: "frontmatter phải là các cặp khoá: giá trị" };
    return { data: data as Record<string, unknown>, present: true, body, error: null };
  } catch (e) {
    return { data: {}, present: true, body, error: `frontmatter YAML sai: ${(e as Error).message.split("\n")[0]}` };
  }
}

/** The text with `fields` set in its block (made when missing); other keys and the body are kept. */
export function writeFrontmatter(text: string, fields: Record<string, unknown>): string {
  const fm = readFrontmatter(text);
  if (fm.error) throw new Error(fm.error);
  const data = { ...fm.data, ...fields };
  const block = stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${block}\n---\n${fm.present ? fm.body : text.startsWith("\n") ? text.slice(1) : text}`;
}

/** A step document's status as its author set it: `draft` when absent or unknown. */
export function docStatus(text: string): "draft" | "done" | "skipped" {
  const s = readFrontmatter(text).data.status;
  return s === "done" || s === "skipped" ? s : "draft";
}
