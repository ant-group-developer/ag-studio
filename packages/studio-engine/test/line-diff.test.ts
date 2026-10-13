import { describe, expect, it } from "vitest";
import { lineDiff, splitLines } from "../src/index.js";

const lines = (n: number, f = (i: number) => `dòng ${i + 1}`) => Array.from({ length: n }, (_, i) => f(i)).join("\n") + "\n";

/** Applies the hunks to `before` (they must be exact): what a reader of the diff would rebuild. */
function apply(before: string, d: NonNullable<ReturnType<typeof lineDiff>>): string[] {
  const a = splitLines(before);
  const out: string[] = [];
  let i = 0;
  for (const h of d.hunks) {
    const start = h.old_lines === 0 ? h.old_start : h.old_start - 1;
    while (i < start) out.push(a[i++]!);
    for (const l of h.lines) {
      if (l.kind === "add") { out.push(l.text); continue; }
      expect(a[i]).toBe(l.text);
      if (l.kind === "context") out.push(l.text);
      i++;
    }
  }
  while (i < a.length) out.push(a[i++]!);
  return out;
}

describe("line diff", () => {
  it("splits lines on \\n or \\r\\n; a final newline adds no empty line", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("same texts have no hunks", () => {
    expect(lineDiff("a\nb\n", "a\nb\n")).toEqual({ hunks: [], added: 0, removed: 0 });
  });

  it("a changed line in the middle: one hunk with three lines of context each side", () => {
    const before = lines(20);
    const after = before.replace("dòng 10\n", "dòng mười\n");
    const d = lineDiff(before, after)!;
    expect(d).toMatchObject({ added: 1, removed: 1 });
    expect(d.hunks).toEqual([{
      old_start: 7, old_lines: 7, new_start: 7, new_lines: 7,
      lines: [
        { kind: "context", text: "dòng 7" }, { kind: "context", text: "dòng 8" }, { kind: "context", text: "dòng 9" },
        { kind: "del", text: "dòng 10" }, { kind: "add", text: "dòng mười" },
        { kind: "context", text: "dòng 11" }, { kind: "context", text: "dòng 12" }, { kind: "context", text: "dòng 13" },
      ],
    }]);
  });

  it("changes far apart are separate hunks, close ones share one", () => {
    const before = lines(40);
    const far = before.replace("dòng 2\n", "hai\n").replace("dòng 30\n", "ba mươi\n");
    expect(lineDiff(before, far)!.hunks.map((h) => [h.old_start, h.old_lines])).toEqual([[1, 5], [27, 7]]);
    const near = before.replace("dòng 10\n", "mười\n").replace("dòng 16\n", "mười sáu\n");
    expect(lineDiff(before, near)!.hunks).toHaveLength(1);
    const apart = before.replace("dòng 10\n", "mười\n").replace("dòng 18\n", "mười tám\n");
    expect(lineDiff(before, apart)!.hunks).toHaveLength(2);
  });

  it("a new file is all added, a removed one all removed (a side with no lines starts at 0)", () => {
    expect(lineDiff("", "a\nb\n")).toEqual({ added: 2, removed: 0, hunks: [{ old_start: 0, old_lines: 0, new_start: 1, new_lines: 2, lines: [{ kind: "add", text: "a" }, { kind: "add", text: "b" }] }] });
    expect(lineDiff("a\n", "")).toMatchObject({ added: 0, removed: 1, hunks: [{ old_start: 1, old_lines: 1, new_start: 0, new_lines: 0 }] });
  });

  it("finds the shortest script: inserting lines does not mark the rest changed", () => {
    const d = lineDiff("a\nb\nc\nd\n", "a\nx\nb\nc\ny\nd\n", { context: 0 })!;
    expect(d).toMatchObject({ added: 2, removed: 0 });
    expect(d.hunks.map((h) => [h.new_start, h.lines])).toEqual([[2, [{ kind: "add", text: "x" }]], [5, [{ kind: "add", text: "y" }]]]);
  });

  it("random edits: the hunks rebuild the new text exactly", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: rnd(40) }, () => `l${rnd(8)}`);
      const b = [...a];
      for (let e = rnd(10); e > 0; e--) {
        const at = rnd(b.length + 1);
        if (rnd(2) && b.length) b.splice(at, 1); else b.splice(at, 0, `n${rnd(8)}`);
      }
      const before = a.join("\n");
      const d = lineDiff(before, b.join("\n"), { context: rnd(4) })!;
      expect(apply(before, d)).toEqual(b);
    }
  });

  it("stays exact and quick on big, very different texts; too many lines is not compared", () => {
    const before = lines(20_000, (i) => `a${i}`);
    const after = lines(20_000, (i) => `b${i}`);
    const t = Date.now();
    const d = lineDiff(before, after)!;
    expect(Date.now() - t).toBeLessThan(3000);
    expect(d).toMatchObject({ added: 20_000, removed: 20_000 });
    expect(apply(before, d)).toEqual(splitLines(after));
    expect(lineDiff(lines(60_000), "")).toBeNull();
  });
});
