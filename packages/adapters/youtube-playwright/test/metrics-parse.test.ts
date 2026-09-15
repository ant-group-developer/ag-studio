import { describe, expect, it } from "vitest";
import { parseCount, parseDuration, parsePercent, parseStatsJson } from "../src/metrics-parse.js";

describe("parseCount", () => {
  it("reads a K/M/B-suffixed compact count", () => {
    expect(parseCount("1.2K")).toBe(1200);
    expect(parseCount("3.4M")).toBe(3400000);
  });
  it("reads an English thousands-separated integer", () => {
    expect(parseCount("1,234")).toBe(1234);
  });
  it("reads a Vietnamese decimal-comma count with a locale suffix (N = nghìn = thousand)", () => {
    expect(parseCount("1,2 N")).toBe(1200);
  });
  it("reads a plain integer", () => {
    expect(parseCount("12")).toBe(12);
  });
  it("returns null for a dash (no data), never 0", () => {
    expect(parseCount("—")).toBeNull();
  });
  it("returns null for empty/missing input", () => {
    expect(parseCount("")).toBeNull();
    expect(parseCount(undefined)).toBeNull();
    expect(parseCount(null)).toBeNull();
  });
});

describe("parsePercent", () => {
  it("reads a dot-decimal percent", () => {
    expect(parsePercent("5.3%")).toBe(5.3);
  });
  it("reads a Vietnamese comma-decimal percent with a narrow space before %", () => {
    expect(parsePercent("5,3 %")).toBe(5.3);
  });
  it("returns null for empty input", () => {
    expect(parsePercent("")).toBeNull();
  });
});

describe("parseDuration", () => {
  it("reads m:ss", () => {
    expect(parseDuration("0:45")).toBe(45);
    expect(parseDuration("1:02")).toBe(62);
  });
  it("reads h:mm:ss", () => {
    expect(parseDuration("1:02:03")).toBe(3723);
  });
  it("returns null for a form that isn't m:ss or h:mm:ss", () => {
    expect(parseDuration("45 giây")).toBeNull();
  });
});

describe("parseStatsJson", () => {
  it("parses an ok result with every optional numeric field", () => {
    const line = JSON.stringify({ kind: "ok", views: 100, impressions: 500, ctr_pct: 5.5, avg_view_sec: 61, retention30_pct: 40, note: "n=1" });
    expect(parseStatsJson(line)).toEqual({ kind: "ok", views: 100, impressions: 500, ctr_pct: 5.5, avg_view_sec: 61, retention30_pct: 40, note: "n=1" });
  });

  it("parses an ok result with only the required views field", () => {
    expect(parseStatsJson(JSON.stringify({ kind: "ok", views: 0 }))).toEqual({ kind: "ok", views: 0 });
  });

  it("parses no-views", () => {
    expect(parseStatsJson(JSON.stringify({ kind: "no-views" }))).toEqual({ kind: "no-views" });
  });

  it("parses blocked with its reason", () => {
    expect(parseStatsJson(JSON.stringify({ kind: "blocked", reason: "Verify it's you" }))).toEqual({ kind: "blocked", reason: "Verify it's you" });
  });

  it("parses error with its reason", () => {
    expect(parseStatsJson(JSON.stringify({ kind: "error", reason: "boom" }))).toEqual({ kind: "error", reason: "boom" });
  });

  it("broken JSON -> error, never throws", () => {
    const outcome = parseStatsJson("{not json");
    expect(outcome.kind).toBe("error");
    expect((outcome as { reason: string }).reason).toContain("invalid JSON");
  });

  it("an unrecognized kind -> error", () => {
    const outcome = parseStatsJson(JSON.stringify({ kind: "weird" }));
    expect(outcome).toEqual({ kind: "error", reason: expect.stringContaining("unrecognized stats kind") });
  });

  it("ok result missing numeric views -> error", () => {
    const outcome = parseStatsJson(JSON.stringify({ kind: "ok", views: "100" }));
    expect(outcome).toEqual({ kind: "error", reason: expect.any(String) });
  });

  it("ok result with a non-numeric optional field -> error", () => {
    const outcome = parseStatsJson(JSON.stringify({ kind: "ok", views: 1, ctr_pct: "5%" }));
    expect(outcome).toEqual({ kind: "error", reason: expect.any(String) });
  });

  it("blocked without a string reason -> error", () => {
    expect(parseStatsJson(JSON.stringify({ kind: "blocked" }))).toEqual({ kind: "error", reason: expect.any(String) });
  });

  it("reads only the last line of multi-line output (banner lines before the JSON)", () => {
    const raw = "[collect] starting\n" + JSON.stringify({ kind: "ok", views: 7 });
    expect(parseStatsJson(raw)).toEqual({ kind: "ok", views: 7 });
  });
});
