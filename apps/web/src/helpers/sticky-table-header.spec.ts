/**
 * Every table keeps its header in view while its rows scroll: each antd `<Table` and `<ProTable` in the web's source
 * has a `sticky` prop, so a new table cannot forget it. Plain HTML tables (`<table`, Markdown and the diff view) are not
 * antd's and are left out by the case of the tag.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".tsx") && !/\.spec\.tsx$/.test(name) ? [path] : [];
  });
}

/** The opening tag starting at `from` (`<Table` …): up to its `>`, skipping a type argument and `{…}` expressions. */
export function openingTag(text: string, from: number): string {
  let i = text.indexOf("<", from) + 1;
  while (/[\w.]/.test(text[i] ?? "")) i++;
  if (text[i] === "<") {
    for (let angles = 0; i < text.length; i++) {
      if (text[i] === "<") angles++;
      else if (text[i] === ">" && --angles === 0) { i++; break; }
    }
  }
  let braces = 0;
  let quote: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") braces++;
    else if (c === "}") braces--;
    else if (c === ">" && braces === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}

/** Props written at the top level of a tag (not inside `{…}`): `sticky={…}` or a bare `sticky`. */
export function hasTopLevelProp(tag: string, prop: string): boolean {
  let braces = 0;
  let top = "";
  for (const c of tag) {
    if (c === "{") braces++;
    if (braces === 0) top += c;
    if (c === "}") braces--;
  }
  return new RegExp(`\\s${prop}(=|\\s|/?>|$)`).test(top);
}

describe("tables keep their header in view", () => {
  const tables = sourceFiles(SRC).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(/<(Table|ProTable)(?=[\s<>/])/g)].map((m) => {
      const line = text.slice(0, m.index).split("\n").length;
      return { at: `${relative(SRC, file).replace(/\\/g, "/")}:${line}`, tag: openingTag(text, m.index!) };
    });
  });

  it("finds the tables", () => {
    expect(tables.length).toBeGreaterThanOrEqual(9);
  });

  it("every <Table> and <ProTable> has a sticky header", () => {
    expect(tables.filter((x) => !hasTopLevelProp(x.tag, "sticky")).map((x) => x.at)).toEqual([]);
  });

  it("reads a tag's own props, not those of what it renders", () => {
    const tag = openingTag(`<Table<Row> rowKey="id" expandable={{ render: () => <Inner sticky /> }} scroll={{ x: 800 }} />`, 0);
    expect(hasTopLevelProp(tag, "sticky")).toBe(false);
    expect(hasTopLevelProp(openingTag(`<Table\n  sticky={PAGE_TABLE_STICKY}\n  columns={c}\n/>`, 0), "sticky")).toBe(true);
    expect(hasTopLevelProp(openingTag(`<ProTable<A> columns={c} sticky />`, 0), "sticky")).toBe(true);
  });
});
