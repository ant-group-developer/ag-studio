/**
 * Every literal `t("…")` key the web uses exists in both locales: a missing key renders as the raw key
 * (`footage.selectClipFirst`, `player.pause` reached the editor that way).
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

function has(messages: unknown, key: string): boolean {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

/** Keys of i18next plurals (`key_one`, `key_other`) count as the key. */
const hasKey = (messages: unknown, key: string) => has(messages, key) || has(messages, `${key}_other`);

describe("i18n keys", () => {
  const used = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    for (const m of readFileSync(file, "utf8").matchAll(/\bt\(\s*["']([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+)["']/g)) {
      if (!used.has(m[1]!)) used.set(m[1]!, relative(SRC, file));
    }
  }

  it("finds the keys the web uses", () => {
    expect(used.size).toBeGreaterThan(100);
  });

  it.each([["vi", vi], ["en", en]] as const)("every key used exists in %s", (_lang, messages) => {
    const missing = [...used].filter(([key]) => !hasKey(messages, key)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });
});
