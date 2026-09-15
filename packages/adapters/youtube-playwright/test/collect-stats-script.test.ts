import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "collect-stats.mjs");

// No Chrome/Playwright in tests: this only checks the real script parses as valid JS (never runs it,
// never touches a browser). Behavior against real YouTube Studio pages is exercised via
// PlaywrightStatsCollector against fake stand-in scripts (playwright-stats-collector.test.ts).
describe("collect-stats.mjs", () => {
  it("is syntactically valid (node --check)", () => {
    expect(() => execFileSync(process.execPath, ["--check", SCRIPT], { stdio: "pipe" })).not.toThrow();
  });
});
