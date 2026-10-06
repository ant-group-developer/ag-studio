/**
 * `@folder` in the chat box (spec local-chat §2.1). The box shows `@Kyoto 2025`; what is sent names the folder for
 * sure: `@[Kyoto 2025](folder:<id>)` — the form the API and Claude read.
 */
export interface FolderMention { id: string; name: string }

/** The `@word` being typed right before the caret, if any (what to filter the folder list by). */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@[\]()]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

/** Replaces the `@word` at `start` by `@name ` and returns the new text and caret. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length };
}

/** What is sent: every `@name` of a picked folder that is still in the text becomes `@[name](folder:id)`. */
export function encodeMentions(text: string, picked: readonly FolderMention[]): string {
  let out = text;
  for (const f of [...picked].sort((a, b) => b.name.length - a.name.length)) {
    out = out.split(`@${f.name}`).join(`@[${f.name}](folder:${f.id})`);
  }
  return out;
}

/** The picked folders still named in the text. */
export function mentionsIn(text: string, picked: readonly FolderMention[]): FolderMention[] {
  return picked.filter((f) => text.includes(`@${f.name}`));
}

/** A message as people read it: `@[Kyoto 2025](folder:f1)` shown as `@Kyoto 2025`, split for highlighting. */
export function messageParts(text: string): ({ kind: "text"; text: string } | { kind: "folder"; name: string; id: string })[] {
  const parts: ({ kind: "text"; text: string } | { kind: "folder"; name: string; id: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(/@\[([^\]\n]+)\]\(folder:([^)\s]+)\)/g)) {
    if (m.index! > last) parts.push({ kind: "text", text: text.slice(last, m.index) });
    parts.push({ kind: "folder", name: m[1]!, id: m[2]! });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}
