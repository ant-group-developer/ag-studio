import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_ROOT } from "@harness/core";
import { hasFfmpeg, makeVideo } from "../../../tests/media.js";

const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
function cli(project: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
function freshProject() {
  const dir = mkdtempSync(join(tmpdir(), "cli-source-ingest-dir-"));
  cpSync(join(HARNESS_ROOT, "fixtures", "ops-project-minimal"), dir, { recursive: true });
  cli(dir, "db", "migrate");
  return dir;
}

describe.skipIf(!hasFfmpeg())("harness source ingest <dir> (needs ffmpeg on PATH)", () => {
  it("registers every video file under a directory and reports created/already/skipped in JSON", () => {
    const p = freshProject();
    const dir = mkdtempSync(join(tmpdir(), "shoot-a-"));
    // distinct sizes so the two clips are not byte-identical (same checksum would dedup them together)
    makeVideo(join(dir, "clip-1.mp4"), { seconds: 1, size: "320x180" });
    makeVideo(join(dir, "clip-2.mp4"), { seconds: 1, size: "160x90" });
    writeFileSync(join(dir, "notes.txt"), "not a video");

    const r = cli(p, "source", "ingest", dir, "--collection", "shoot-a", "--rights", "cleared", "--json");
    expect(r.code, r.err).toBe(0);
    const report = JSON.parse(r.out) as { ingested: { source_id: string; path: string; created: boolean }[]; skipped: unknown[] };
    expect(report.ingested).toHaveLength(2);
    for (const i of report.ingested) { expect(i.source_id).toMatch(/^src_/); expect(i.created).toBe(true); }
    expect(report.skipped).toEqual([]);

    const list = cli(p, "source", "list", "--collection", "shoot-a", "--json");
    expect(JSON.parse(list.out)).toHaveLength(2);
  });

  it("--recursive descends into subdirectories; without it a nested clip is not registered", () => {
    const p = freshProject();
    const dir = mkdtempSync(join(tmpdir(), "shoot-rec-"));
    makeVideo(join(dir, "top.mp4"), { seconds: 1, size: "320x180" });
    mkdirSync(join(dir, "sub"));
    makeVideo(join(dir, "sub", "nested.mp4"), { seconds: 1, size: "160x90" });

    const shallow = cli(p, "source", "ingest", dir, "--collection", "shoot-shallow", "--json");
    expect(JSON.parse(shallow.out).ingested).toHaveLength(1);

    const deep = cli(p, "source", "ingest", dir, "--collection", "shoot-deep", "--recursive", "--json");
    expect(JSON.parse(deep.out).ingested).toHaveLength(2);
  });

  it("exits 0 even when some files were skipped, and 1 only when the directory does not exist", () => {
    const p = freshProject();
    const missing = cli(p, "source", "ingest", join(tmpdir(), "no-such-dir-xyz"), "--json");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("NOT_FOUND");
  });

  it("a plain file path keeps today's behaviour and output shape", () => {
    const p = freshProject();
    const dir = mkdtempSync(join(tmpdir(), "single-file-"));
    const file = join(dir, "clip.mp4");
    makeVideo(file, { seconds: 1 });
    const r = cli(p, "source", "ingest", file, "--collection", "main", "--json");
    expect(r.code, r.err).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed).toHaveProperty("source_id");
    expect(parsed).toHaveProperty("created", true);
    expect(parsed).toHaveProperty("checksum");
    expect(parsed).toHaveProperty("uri");
  });
});
