// Exercises the studio ops project's fixture wrappers directly (spawned in place, cwd = the fixture so
// `@harness/script-sdk` resolves through its own node_modules -- see tests/integration/library-helpers.ts
// for the same trick used by the full pipeline tests). `collect-samples.mjs` needs a real ffmpeg to probe
// and frame-grab whatever it ends up with (a downloaded fake clip or a local file), so the whole suite is
// skipped without one; `transcribe.mjs` needs neither ffmpeg nor script-sdk and is exercised unconditionally.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HARNESS_ROOT } from "@harness/core";
import { hasFfmpeg, makeVideo } from "../media.js";

const STUDIO_FIXTURE = join(HARNESS_ROOT, "fixtures", "ops-project-studio");
const WRAPPERS = join(STUDIO_FIXTURE, "executors", "wrappers");
const SHA = "sha256:" + "a".repeat(64);

interface BaseRequestOptions {
  stage_key?: string;
  source_items?: unknown[];
  inputs?: unknown[];
  expected_outputs?: unknown[];
}

function baseRequest(ws: string, o: BaseRequestOptions = {}) {
  return {
    schema_version: "harness.stage-request/v1",
    run_id: "run_1", stage_run_id: "stage_1", attempt_id: "attempt_1",
    project_id: "p", portfolio_id: "pf", stage_key: o.stage_key ?? "collect-samples",
    workflow: { id: "w", version: "1.0.0", digest: SHA },
    profile_snapshot: { id: "studio", revision: 1 },
    inputs: o.inputs ?? [],
    workspace_uri: ws, stage_config: {}, options: {},
    source_items: o.source_items ?? [],
    resources: [], expected_outputs: o.expected_outputs ?? [], policy: {},
    limits: { deadline_at: new Date(Date.now() + 60_000).toISOString(), max_cost_usd: 5, max_attempts: 1 },
    capabilities: [], fencing_token: 1,
  };
}

function runWrapper(script: string, ws: string, env: Record<string, string> = {}): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [join(WRAPPERS, script)], {
    cwd: STUDIO_FIXTURE,
    env: { ...process.env, HARNESS_WORKSPACE: ws, ...env },
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe.skipIf(!hasFfmpeg())("collect-samples wrapper", () => {
  it("FAKE_YTDLP=1: a URL line becomes a fake downloaded clip (label + url), a local-path line stays in place (label, no url)", () => {
    const ws = mkdtempSync(join(tmpdir(), "collect-samples-"));
    mkdirSync(join(ws, "output"), { recursive: true });
    const localVideo = join(ws, "local.mp4");
    makeVideo(localVideo, { seconds: 3 });
    const listPath = join(ws, "samples.txt");
    writeFileSync(listPath, `https://example.com/video1\n${localVideo}\n`);

    const req = baseRequest(ws, {
      source_items: [{ source_id: "src_1", uri: pathToFileURL(listPath).href, checksum: SHA, mime_type: "text/plain", duration_seconds: null }],
      expected_outputs: [{ type: "sample_set", mime_type: "application/x-directory", kind: "directory", name: "samples" }],
    });
    writeFileSync(join(ws, "stage-request.json"), JSON.stringify(req));

    const r = runWrapper("collect-samples.mjs", ws, { FAKE_YTDLP: "1" });
    expect(r.status, `stderr: ${r.err}`).toBe(0);

    const samples = JSON.parse(readFileSync(join(ws, "output", "samples", "samples.json"), "utf8")) as
      { index: number; label: string; path: string; url?: string; frames: string[] }[];
    expect(samples).toHaveLength(2);

    expect(samples[0]!.label).toBe("s0");
    expect(samples[0]!.url).toBe("https://example.com/video1");
    expect(existsSync(samples[0]!.path)).toBe(true);
    expect(samples[0]!.frames).toHaveLength(3);

    expect(samples[1]!.label).toBe("s1");
    expect(samples[1]!.url).toBeUndefined();
    expect(samples[1]!.path).toBe(localVideo);
    expect(existsSync(samples[1]!.path)).toBe(true);
  });

  it("a missing yt-dlp binary is reported as a transient stage failure (harness core never calls yt-dlp itself)", () => {
    const ws = mkdtempSync(join(tmpdir(), "collect-samples-"));
    mkdirSync(join(ws, "output"), { recursive: true });
    const listPath = join(ws, "samples.txt");
    writeFileSync(listPath, "https://example.com/video1\n");

    const req = baseRequest(ws, {
      source_items: [{ source_id: "src_1", uri: pathToFileURL(listPath).href, checksum: SHA, mime_type: "text/plain", duration_seconds: null }],
      expected_outputs: [{ type: "sample_set", mime_type: "application/x-directory", kind: "directory", name: "samples" }],
    });
    writeFileSync(join(ws, "stage-request.json"), JSON.stringify(req));

    const r = runWrapper("collect-samples.mjs", ws, { YTDLP_PATH: "definitely-missing-yt-dlp-xyz" });
    expect(r.status).toBe(0); // the sdk's ctx.fail writes stage-result.json and exits 0 -- the harness core reads the result, not the exit code
    const result = JSON.parse(readFileSync(join(ws, "stage-result.json"), "utf8")) as { outcome: string; errors: { kind: string }[] };
    expect(result.outcome).toBe("failed");
    expect(result.errors[0]!.kind).toBe("transient");
  });
});

describe("transcribe.mjs", () => {
  it("segments a sibling <media>.txt into 5-second-per-line entries", () => {
    const ws = mkdtempSync(join(tmpdir(), "transcribe-"));
    const media = join(ws, "clip.mp4");
    writeFileSync(media, "not really a video");
    writeFileSync(`${media}.txt`, "Line one.\nLine two.\n\nLine three.\n");
    const outPath = join(ws, "transcript.json");

    const r = spawnSync(process.execPath, [join(WRAPPERS, "transcribe.mjs"), "--in", media, "--out", outPath], { encoding: "utf8" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    const transcript = JSON.parse(readFileSync(outPath, "utf8")) as { segments: { start: number; end: number; text: string }[] };
    expect(transcript.segments).toEqual([
      { start: 0, end: 5, text: "Line one." },
      { start: 5, end: 10, text: "Line two." },
      { start: 10, end: 15, text: "Line three." },
    ]);
  });

  it("no sibling .txt: writes an empty segments array", () => {
    const ws = mkdtempSync(join(tmpdir(), "transcribe-"));
    const media = join(ws, "clip.mp4");
    writeFileSync(media, "not really a video");
    const outPath = join(ws, "transcript.json");

    const r = spawnSync(process.execPath, [join(WRAPPERS, "transcribe.mjs"), "--in", media, "--out", outPath], { encoding: "utf8" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({ segments: [] });
  });

  it("FAKE_TRANSCRIBE=crash: exits 1, writes no output", () => {
    const ws = mkdtempSync(join(tmpdir(), "transcribe-"));
    const media = join(ws, "clip.mp4");
    writeFileSync(media, "not really a video");
    const outPath = join(ws, "transcript.json");

    const r = spawnSync(process.execPath, [join(WRAPPERS, "transcribe.mjs"), "--in", media, "--out", outPath], {
      encoding: "utf8",
      env: { ...process.env, FAKE_TRANSCRIBE: "crash" },
    });
    expect(r.status).toBe(1);
    expect(existsSync(outPath)).toBe(false);
  });
});
