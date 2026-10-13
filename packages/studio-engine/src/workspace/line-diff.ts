/**
 * A line diff of two texts (Myers' O(ND) algorithm), for "what this turn / this version changed": counts of lines added
 * and removed, and unified-diff hunks with a few lines of context around each change. Bounded: past `maxLines` lines on
 * either side the texts are not compared at all, and past `maxEdits` differing lines (or too much work) the differing
 * middle (after the common start and end) is shown as removed then added — still exact, just not the shortest script.
 */

export interface DiffLine { kind: "context" | "add" | "del"; text: string }
export interface DiffHunk { old_start: number; old_lines: number; new_start: number; new_lines: number; lines: DiffLine[] }
export interface LineDiff { hunks: DiffHunk[]; added: number; removed: number }

export const DIFF_MAX_LINES = 50_000;
const DIFF_MAX_EDITS = 2_000;
const DIFF_MAX_WORK = 20_000_000;

type Op = "=" | "-" | "+";

/** Lines of a text: `\r\n` or `\n` ends a line; a final newline does not start an empty last line. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The shortest edit script from `a` to `b`, or null when it is longer than `maxEdits` or costs too much to find. */
function myers(a: string[], b: string[], maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  // vs[d][k + d] = furthest x on diagonal k after d edits
  const vs: Int32Array[] = [];
  let work = 0;
  for (let d = 0; d <= Math.min(n + m, maxEdits); d++) {
    const prev = vs[d - 1];
    const cur = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && prev![k - 1 + d - 1]! < prev![k + 1 + d - 1]!)) x = prev![k + 1 + d - 1]!;
      else x = prev![k - 1 + d - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; work++; }
      cur[k + d] = x;
      work++;
      if (x >= n && y >= m) { vs.push(cur); return backtrack(vs, n, m); }
    }
    if (work > DIFF_MAX_WORK) return null;
    vs.push(cur);
  }
  return null;
}

function backtrack(vs: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = vs.length - 1; d > 0; d--) {
    const prev = vs[d - 1]!;
    const at = (k: number) => prev[k + d - 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push("="); x--; y--; }
    ops.push(x === prevX ? "+" : "-");
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { ops.push("="); x--; y--; }
  return ops.reverse();
}

/** The edit script: common start and end kept, the middle by Myers (or removed-then-added when it is too big). */
function editScript(a: string[], b: string[], maxEdits: number): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const middle = myers(am, bm, maxEdits) ?? [...am.map((): Op => "-"), ...bm.map((): Op => "+")];
  return [...Array<Op>(pre).fill("="), ...middle, ...Array<Op>(suf).fill("=")];
}

/**
 * Compares `before` with `after` line by line. `null` when either side has more than `maxLines` lines. Hunks keep
 * `context` unchanged lines around each change; changes closer than twice that share a hunk. Line numbers are 1-based
 * (a side with no lines in a hunk starts at the line before it, as in unified diffs).
 */
export function lineDiff(before: string, after: string, opts: { context?: number; maxLines?: number; maxEdits?: number } = {}): LineDiff | null {
  const context = opts.context ?? 3;
  const a = splitLines(before);
  const b = splitLines(after);
  const maxLines = opts.maxLines ?? DIFF_MAX_LINES;
  if (a.length > maxLines || b.length > maxLines) return null;
  const ops = editScript(a, b, opts.maxEdits ?? DIFF_MAX_EDITS);
  const rows: { kind: DiffLine["kind"]; text: string; oldBefore: number; newBefore: number }[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op === "=") { rows.push({ kind: "context", text: b[j]!, oldBefore: i, newBefore: j }); i++; j++; }
    else if (op === "-") { rows.push({ kind: "del", text: a[i]!, oldBefore: i, newBefore: j }); i++; removed++; }
    else { rows.push({ kind: "add", text: b[j]!, oldBefore: i, newBefore: j }); j++; added++; }
  }
  const hunks: DiffHunk[] = [];
  let r = 0;
  while (r < rows.length) {
    if (rows[r]!.kind === "context") { r++; continue; }
    const start = Math.max(0, r - context);
    let end = r; // last changed row of the hunk
    let s = r + 1;
    while (s < rows.length) {
      if (rows[s]!.kind !== "context") { end = s; s++; continue; }
      if (s - end > 2 * context) break;
      s++;
    }
    const stop = Math.min(rows.length, end + context + 1);
    const slice = rows.slice(start, stop);
    const oldLines = slice.filter((x) => x.kind !== "add").length;
    const newLines = slice.filter((x) => x.kind !== "del").length;
    hunks.push({
      old_start: slice[0]!.oldBefore + (oldLines > 0 ? 1 : 0), old_lines: oldLines,
      new_start: slice[0]!.newBefore + (newLines > 0 ? 1 : 0), new_lines: newLines,
      lines: slice.map((x) => ({ kind: x.kind, text: x.text })),
    });
    r = stop;
  }
  return { hunks, added, removed };
}
