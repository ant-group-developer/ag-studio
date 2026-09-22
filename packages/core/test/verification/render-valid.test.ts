import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompositionSchema, newId, RenderReportSchema, type Checker, type Composition, type MediaProbe, type MediaProber, type RenderReport, type StageRequest, type StageResult } from "@harness/contracts";
import { compositionCheckers } from "../../src/index.js";
import { hasFfmpeg } from "../../../../tests/media.js";

const sha = "sha256:" + "a".repeat(64);
const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";

function ffmpegPath(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}
function ffprobePath(): string {
  return process.env.FFPROBE_PATH ?? "ffprobe";
}

function prober(): MediaProber {
  return {
    async probe(path: string): Promise<MediaProbe | null> {
      const r = spawnSync(ffprobePath(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (r.status !== 0) return null;
      let parsed: { format?: { duration?: string; format_name?: string }; streams?: Record<string, unknown>[] };
      try {
        parsed = JSON.parse(r.stdout) as typeof parsed;
      } catch {
        return null;
      }
      const streams = parsed.streams ?? [];
      const v = streams.find((s) => s.codec_type === "video");
      const a = streams.find((s) => s.codec_type === "audio");
      const rate = (s: Record<string, unknown>): number | null => {
        const [num, den] = String(s.avg_frame_rate ?? "0/0").split("/").map(Number);
        return num && den ? num / den : null;
      };
      const duration = Number(parsed.format?.duration);
      return {
        media: null,
        duration_seconds: Number.isFinite(duration) ? duration : null,
        mime_type: null,
        container: parsed.format?.format_name ?? null,
        video: v ? { codec: String(v.codec_name), width: Number(v.width), height: Number(v.height), fps: rate(v) } : null,
        audio: a ? { codec: String(a.codec_name), channels: Number(a.channels), sample_rate: Number(a.sample_rate) } : null,
      };
    },
  };
}

function checker(opts: { available?: boolean } = {}): Checker {
  const all = compositionCheckers({ prober: prober(), ffmpeg: ffmpegPath(), ...opts });
  const c = all.find((x) => x.id === "render-valid");
  if (!c) throw new Error("no render-valid checker");
  return c;
}

function run(bin: string, args: string[]): void {
  const r = spawnSync(bin, args, { maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(" ")} failed: ${r.stderr?.toString("utf8") ?? ""}`);
}

/**
 * A 3840x2160 / 25 fps / 4s episode with 48 kHz stereo AAC. `pattern: "flat"` is a single solid colour (luma
 * std-dev 0 everywhere, so every frame-content probe fails, exactly like an episode whose `ass`/`overlay`
 * filter silently did nothing). `"noise"` stands in for a fully painted episode: `testsrc2` alone will NOT
 * do, because its top-right corner -- where the logo probe samples -- is one of its flat colour bars, so a
 * grid is drawn over the whole frame to give every sampled region real structure.
 */
function makeEpisode(path: string, pattern: "flat" | "noise", seconds = 4): void {
  const video = pattern === "flat" ? `color=c=0x303030:size=3840x2160:rate=25` : `testsrc2=size=3840x2160:rate=25,drawgrid=w=64:h=64:t=6:color=white`;
  run(ffmpegPath(), [
    "-hide_banner", "-y", "-f", "lavfi", "-i", video, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", "25",
    "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", "-shortest", path,
  ]);
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseRequest(overrides: Partial<StageRequest> = {}): StageRequest {
  return {
    schema_version: "harness.stage-request/v1",
    run_id: newId("run"),
    stage_run_id: newId("stage_run"),
    attempt_id: newId("attempt"),
    project_id: "p",
    portfolio_id: "pf",
    stage_key: "media-render",
    workflow: { id: "library-production", version: "1.3.0", digest: sha },
    profile_snapshot: { id: "studio", revision: 4 },
    inputs: [],
    workspace_uri: "",
    stage_config: {},
    options: {},
    source_items: [],
    resources: [],
    expected_outputs: [],
    policy: {},
    limits: { deadline_at: "2026-09-14T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 },
    capabilities: [],
    fencing_token: 1,
    ...overrides,
  };
}

function baseResult(outputs: StageResult["outputs"]): StageResult {
  return {
    schema_version: "harness.stage-result/v1",
    attempt_id: newId("attempt"),
    outcome: "succeeded",
    outputs,
    checks: [],
    usage: { wall_seconds: 1, cost_usd: 0 },
    external_operations: [],
    errors: [],
  };
}

function composition(overrides: Partial<Composition> = {}): Composition {
  return CompositionSchema.parse({
    schema_version: "harness.composition/v1",
    output: { width: 3840, height: 2160, fps: 25, codec: "h264" },
    voice: "none",
    language: "en",
    total_seconds: 4,
    request_id: newId("content_request"),
    brand: null,
    segments: [{
      order: 0, source_id: SRC_A, source_path: "/abs/a.mp4", in: 0, out: 4, start: 0, end: 4,
      fit: "scale_pad", has_audio: true, transition_out: { kind: "cut", seconds: 0.4, tail_available: false },
    }],
    text_events: [],
    captions: { mode: "none", cues: [] },
    music: null,
    logo: null,
    narration: [],
    transitions: { requested: 0, applied: 0, downgraded: [] },
    text_dropped: [],
    warnings: [],
    ...overrides,
  });
}

function report(overrides: Partial<RenderReport> = {}): RenderReport {
  return RenderReportSchema.parse({
    schema_version: "harness.render-report/v1",
    encoder: "cpu",
    codec: "h264",
    output: { width: 3840, height: 2160, fps: 25, seconds: 4, bytes: 1234 },
    segments: { total: 1, rendered: 1, cached: 0, mezz_seconds: 4 },
    transitions: { requested: 0, applied: 0, downgraded: [] },
    captions: { mode: "none", cues: 0 },
    text_events: { total: 0, dropped: [] },
    music: { track_id: null, loop: false },
    loudness: { integrated_lufs: -14.03, true_peak_dbtp: -1.49, lra: 6.6 },
    brand: "absent",
    warnings: [],
    render_seconds: 12.5,
    ffmpeg_version: "8.1",
    ...overrides,
  });
}

/** Lays out a `media-render` workspace: episode video, render-report.json, composition.json input and a
 * captions/ directory with `cues` SRT blocks. Returns the checker input. */
function world(o: { episode: string; composition: Composition; report: RenderReport; srtBlocks?: number; captionsAs?: "output" | "input" }) {
  const ws = tempDir("render-valid-ws-");
  writeFileSync(join(ws, "render-report.json"), JSON.stringify(o.report));
  writeFileSync(join(ws, "composition.json"), JSON.stringify(o.composition));
  const capDir = join(ws, "captions");
  mkdirSync(capDir, { recursive: true });
  const blocks = o.srtBlocks ?? o.composition.captions.cues.length;
  const srt = Array.from({ length: blocks }, (_, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i + 1},000\nline ${i}\n`).join("\n");
  writeFileSync(join(capDir, "captions.srt"), srt);

  const outputs: StageResult["outputs"] = [
    { path: "full-episode.mp4", type: "episode_video", checksum: sha, size_bytes: 1, kind: "file" },
    { path: "render-report.json", type: "render_report", checksum: sha, size_bytes: 1, kind: "file" },
  ];
  const inputs: StageRequest["inputs"] = [{ type: "composition", path: "composition.json" }];
  if ((o.captionsAs ?? "output") === "output") outputs.push({ path: "captions", type: "captions", checksum: sha, size_bytes: 1, kind: "directory" });
  else inputs.push({ type: "captions", path: "captions" });

  // The episode file itself lives outside the workspace (it is expensive to make); symlink-free approach:
  // the output path is relative to workspaceDir, so copy the path in by writing the workspace entry.
  run(ffmpegPath(), ["-hide_banner", "-y", "-i", o.episode, "-c", "copy", join(ws, "full-episode.mp4")]);

  return { workspaceDir: ws, request: baseRequest({ inputs }), result: baseResult(outputs) };
}

describe("render-valid", () => {
  it("skips when no prober is available", async () => {
    const res = await checker({ available: false }).check({ workspaceDir: tempDir("rv-"), request: baseRequest(), result: baseResult([]) });
    expect(res.verdict).toBe("skip");
  });

  it("skips when the stage produced no episode_video/render_report", async () => {
    const res = await checker().check({ workspaceDir: tempDir("rv-"), request: baseRequest(), result: baseResult([]) });
    expect(res.verdict).toBe("skip");
  });
});

describe.skipIf(!hasFfmpeg())("render-valid (needs ffmpeg)", () => {
  let noise = "";
  let flat = "";

  beforeAll(() => {
    const dir = tempDir("rv-episodes-");
    noise = join(dir, "noise.mp4");
    flat = join(dir, "flat.mp4");
    makeEpisode(noise, "noise");
    makeEpisode(flat, "flat");
  }, 240_000);

  it("passes on a well-formed episode", async () => {
    const comp = composition();
    const w = world({ episode: noise, composition: comp, report: report() });
    const res = await checker().check(w);
    expect(res.verdict).toBe("pass");
  }, 60_000);

  it("fails when the episode duration does not match composition.total_seconds", async () => {
    const comp = composition({ total_seconds: 5 });
    const res = await checker().check(world({ episode: noise, composition: comp, report: report() }));
    expect(res.verdict).toBe("fail");
    expect(res.evidence.reason).toBe("duration mismatch");
  }, 60_000);

  it("fails when the measured integrated loudness is out of the [-16, -12] band", async () => {
    const res = await checker().check(world({ episode: noise, composition: composition(), report: report({ loudness: { integrated_lufs: -20, true_peak_dbtp: -3, lra: 6 } }) }));
    expect(res.verdict).toBe("fail");
    expect(res.evidence.reason).toBe("integrated loudness out of range");
  }, 60_000);

  it("fails when the true peak is above -0.5 dBTP", async () => {
    const res = await checker().check(world({ episode: noise, composition: composition(), report: report({ loudness: { integrated_lufs: -14, true_peak_dbtp: -0.1, lra: 6 } }) }));
    expect(res.verdict).toBe("fail");
    expect(res.evidence.reason).toBe("true peak too high");
  }, 60_000);

  it("fails when the report carries no loudness at all", async () => {
    const res = await checker().check(world({ episode: noise, composition: composition(), report: report({ loudness: null }) }));
    expect(res.verdict).toBe("fail");
    expect(res.evidence.reason).toBe("no loudness measurement");
  }, 60_000);

  it("fails when the SRT block count does not match composition.captions.cues", async () => {
    const comp = composition({
      captions: { mode: "none", cues: [{ index: 1, start: 0, end: 1, lines: ["a"], raise_px: 0, words: [] }, { index: 2, start: 1, end: 2, lines: ["b"], raise_px: 0, words: [] }] },
    });
    const res = await checker().check(world({ episode: noise, composition: comp, report: report(), srtBlocks: 1 }));
    expect(res.verdict).toBe("fail");
    expect(res.evidence.reason).toBe("captions.srt block count mismatch");
  }, 60_000);

  it("reads the captions directory from the stage INPUTS when it is not an output of this stage", async () => {
    const comp = composition({
      captions: { mode: "none", cues: [{ index: 1, start: 0, end: 1, lines: ["a"], raise_px: 0, words: [] }] },
    });
    const res = await checker().check(world({ episode: noise, composition: comp, report: report(), captionsAs: "input" }));
    expect(res.verdict).toBe("pass");
  }, 60_000);

  it("passes the logo frame probe on a non-flat episode and fails it on a flat one", async () => {
    const comp = composition({ logo: { path: "/abs/logo.png", corner: "right", opacity: 0.8, height_px: 140 } });
    expect((await checker().check(world({ episode: noise, composition: comp, report: report() }))).verdict).toBe("pass");

    const bad = await checker().check(world({ episode: flat, composition: comp, report: report() }));
    expect(bad.verdict).toBe("fail");
    expect(bad.evidence.reason).toBe("logo region looks unpainted");
  }, 120_000);

  it("checks the caption band when captions.mode is not none", async () => {
    const comp = composition({
      captions: { mode: "burn-in", cues: [{ index: 1, start: 1, end: 3, lines: ["hello"], raise_px: 0, words: [] }] },
    });
    expect((await checker().check(world({ episode: noise, composition: comp, report: report() }))).verdict).toBe("pass");

    const bad = await checker().check(world({ episode: flat, composition: comp, report: report() }));
    expect(bad.verdict).toBe("fail");
    expect(bad.evidence.reason).toBe("caption region looks unpainted");
  }, 120_000);
});
