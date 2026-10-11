/**
 * Every literal `t("…")` key the web uses exists in both locales: a missing key renders as the raw key
 * (`footage.selectClipFirst`, `player.pause` reached the editor that way). A message naming the AI (`{{ai}}`) is only
 * read through `useAiTranslation`: plain `useTranslation` shows "{{ai}}" as is (the new video's chat did).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "./locales/en";
import { vi } from "./locales/vi";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "playground" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : [];
  });
}

function lookup(messages: unknown, key: string): string | null {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}
const has = (messages: unknown, key: string): boolean => lookup(messages, key) !== null;

/** Keys of i18next plurals (`key_one`, `key_other`) count as the key. */
const hasKey = (messages: unknown, key: string) => has(messages, key) || has(messages, `${key}_other`);

describe("i18n keys", () => {
  const used = new Map<string, string>();
  /** Per file: the keys it reads, and whether it reads them through `useAiTranslation`. */
  const files: { file: string; keys: string[]; ai: boolean }[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const keys = [...text.matchAll(/\bt\(\s*["']([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+)["']/g)].map((m) => m[1]!);
    for (const k of keys) if (!used.has(k)) used.set(k, relative(SRC, file));
    files.push({ file: relative(SRC, file), keys, ai: /\buseAiTranslation\(/.test(text) });
  }

  it("finds the keys the web uses", () => {
    expect(used.size).toBeGreaterThan(100);
  });

  it.each([["vi", vi], ["en", en]] as const)("every key used exists in %s", (_lang, messages) => {
    const missing = [...used].filter(([key]) => !hasKey(messages, key)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it("messages that name the AI are read with useAiTranslation", () => {
    const names = (key: string) => [vi, en].some((m) => /\{\{ai\}\}/.test(lookup(m, key) ?? lookup(m, `${key}_other`) ?? ""));
    const wrong = files.filter((f) => !f.ai).flatMap((f) => f.keys.filter(names).map((k) => `${k} (${f.file})`));
    expect(wrong).toEqual([]);
  });
});
