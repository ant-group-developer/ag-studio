import { describe, expect, it } from "vitest";
import { Redactor } from "../../src/observability/redaction.js";
import { createLogger } from "../../src/observability/logger.js";

describe("Redactor", () => {
  it("masks secret values anywhere in nested data", () => {
    const r = new Redactor(() => ["tok-123", "yt-456"]);
    expect(r.redact({ a: "Bearer tok-123", b: ["x", "yt-456"], c: { d: "fine" }, n: 1 })).toEqual({ a: "Bearer [REDACTED]", b: ["x", "[REDACTED]"], c: { d: "fine" }, n: 1 });
    expect(r.redact("tok-123 and tok-123")).toBe("[REDACTED] and [REDACTED]");
  });
  it("ignores empty secrets", () => {
    const r = new Redactor(() => [""]);
    expect(r.redact("abc")).toBe("abc");
  });
  it("redacts a longer secret fully even when a shorter secret is its prefix", () => {
    const r = new Redactor(() => ["ab", "abcdef"]);
    expect(r.redact("leaked: abcdef and ab")).toBe("leaked: [REDACTED] and [REDACTED]");
    expect(r.redact("leaked: abcdef")).not.toContain("cdef");
  });
});

describe("createLogger", () => {
  it("redacts messages and data before writing", () => {
    const lines: string[] = [];
    const log = createLogger({ redactor: new Redactor(() => ["tok-123"]), sink: (line) => lines.push(line), level: "info" });
    log.info("using tok-123", { key: "tok-123", other: 1 });
    log.child({ run_id: "run_x" }).warn("child tok-123");
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("tok-123");
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "using [REDACTED]", key: "[REDACTED]", other: 1, level: "info" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ run_id: "run_x", msg: "child [REDACTED]" });
  });
});
