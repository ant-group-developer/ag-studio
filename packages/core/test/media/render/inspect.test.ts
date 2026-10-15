import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RenderInspectionSchema, type Composition } from "@harness/contracts";
import { inspectArgs, inspectionIssues, inspectRender, parseDetections, parseMomentary, segmentLoudness } from "../../../src/media/render/inspect.js";
import { hasFfmpeg } from "../../../../../tests/media.js";

const seg = (order: number, start: number, end: number, lufs: number | null = -20) => ({ order, start, end, lufs });

function facts(over: Partial<Parameters<typeof inspectionIssues>[0]> = {}): Parameters<typeof inspectionIssues>[0] {
  return {
    expected_seconds: 60, video_seconds: 60, audio_seconds: 60, freezes: [], blacks: [], silences: [],
    segments: [seg(0, 0, 20), seg(1, 20, 40), seg(2, 40, 60)], loudness_median_lufs: -20, ...over,
  };
}

describe("inspectArgs", () => {
  it("names its outputs relative to the working directory and maps audio only when there is some", () => {
    const withAudio = inspectArgs({ ffmpeg: "ffmpeg", input: "C:\\r\\full-episode.mp4", hasAudio: true });
    const graph = withAudio[withAudio.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("freezedetect");
    expect(graph).toContain("tile=5x4");
    expect(graph).toContain("file=loudness.txt");
    expect(graph).not.toContain("C:");
    expect(withAudio).toContain("sheet-%02d.jpg");
    expect(withAudio.slice(-5)).toEqual(["-map", "[aout]", "-f", "null", "-"]);
    const silent = inspectArgs({ ffmpeg: "ffmpeg", input: "x.mp4", hasAudio: false });
    expect(silent.join(" ")).not.toContain("silencedetect");
    expect(silent).not.toContain("[aout]");
  });
});

describe("parseDetections", () => {
  it("pairs starts with ends and closes what runs to the end of the file", () => {
    const d = parseDetections([
      "[Parsed_freezedetect_3 @ 0000023d] lavfi.freezedetect.freeze_start: 18",
      "[Parsed_silencedetect_8 @ 0000023d] silence_start: 10",
      "[Parsed_silencedetect_8 @ 0000023d] silence_end: 25 | silence_duration: 15",
      "[Parsed_silencedetect_8 @ 0000023d] silence_start: -0.002",
      "[Parsed_silencedetect_8 @ 0000023d] silence_end: 1.5 | silence_duration: 1.5",
      "[blackdetect @ 0x1] black_start:3 black_end:4.5 black_duration:1.5",
    ], 25);
    expect(d.freezes).toEqual([{ start: 18, end: 25 }]);
    expect(d.silences).toEqual([{ start: 10, end: 25 }, { start: 0, end: 1.5 }]);
    expect(d.blacks).toEqual([{ start: 3, end: 4.5 }]);
  });
});

describe("parseMomentary / segmentLoudness", () => {
  it("reads ametadata lines and averages each segment as energy, gated", () => {
    const text = ["frame:0 pts:0 pts_time:0", "lavfi.r128.M=-120.691", "frame:1 pts:4800 pts_time:0.5", "lavfi.r128.M=-20", "frame:2 pts:9600 pts_time:1", "lavfi.r128.M=-20",
      "frame:3 pts:0 pts_time:1.5", "lavfi.r128.M=-inf", "frame:4 pts:0 pts_time:2", "lavfi.r128.M=-10"].join("\n");
    const points = parseMomentary(text);
    expect(points).toHaveLength(5);
    expect(points[3]!.m).toBe(-Infinity);
    const loud = segmentLoudness(points, [{ order: 0, start: 0, end: 1.2 }, { order: 1, start: 1.2, end: 2 }, { order: 2, start: 2, end: 3 }]);
    expect(loud[0]!.lufs).toBe(-20);
    expect(loud[1]!.lufs).toBe(-10);
    expect(loud[2]!.lufs).toBeNull();
  });
});

describe("inspectionIssues", () => {
  it("says nothing about a clean render", () => {
    expect(inspectionIssues(facts())).toEqual([]);
  });

  it("calls a freeze across a cut an error and one that runs out the file to_end", () => {
    const issues = inspectionIssues(facts({ freezes: [{ start: 35, end: 60 }] }));
    expect(issues).toEqual([{ code: "freeze", severity: "error", start: 35, end: 60, order: 1, to_end: true }]);
  });

  it("lets a short still inside one clip pass and warns of a long one", () => {
    expect(inspectionIssues(facts({ freezes: [{ start: 22, end: 25 }] }))).toEqual([]);
    expect(inspectionIssues(facts({ freezes: [{ start: 22, end: 30 }] }))).toEqual([{ code: "freeze", severity: "warning", start: 22, end: 30, order: 1 }]);
  });

  it("reports a short render first, black and silence by time, and leaves fades alone", () => {
    const issues = inspectionIssues(facts({ video_seconds: 50, blacks: [{ start: 0, end: 1 }, { start: 30, end: 32 }], silences: [{ start: 12, end: 16 }, { start: 40, end: 41 }] }));
    expect(issues.map((i) => i.code)).toEqual(["duration", "silence", "black"]);
    expect(issues[0]).toMatchObject({ expected_s: 60, actual_s: 50, severity: "error" });
  });

  it("calls an episode silent nearly throughout one error", () => {
    expect(inspectionIssues(facts({ silences: [{ start: 0.5, end: 60 }] }))).toEqual([{ code: "silence", severity: "error", start: 0, end: 60 }]);
  });

  it("names a clip much quieter than the others", () => {
    const issues = inspectionIssues(facts({ segments: [seg(0, 0, 20), seg(1, 20, 40, -30), seg(2, 40, 60), seg(3, 60, 61, -50)] }));
    expect(issues).toEqual([{ code: "clip_loudness", severity: "warning", start: 20, end: 40, order: 1, delta_db: -10 }]);
  });
});

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!hasFfmpeg())("inspectRender (real ffmpeg)", () => {
  it("finds the freeze and the silence of a file and makes a sheet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inspect-"));
    tempDirs.push(dir);
    const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
    const file = join(dir, "episode.mp4");
    // 18 s of moving picture, then 7 s frozen; a tone for 10 s, then silence
    const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=18", "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=10",
      "-filter_complex", "[0:v]tpad=stop_mode=clone:stop_duration=7[v];[1:a]apad=whole_dur=25[a]", "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", file]);
    expect(r.status).toBe(0);
    const composition = {
      total_seconds: 25,
      segments: [{ order: 0, start: 0, end: 12 }, { order: 1, start: 12, end: 25 }],
    } as unknown as Composition;
    const out = join(dir, "inspect");
    const { inspection, path, sheets } = await inspectRender(
      { ffmpeg, clock: { now: () => new Date().toISOString() } },
      { episodePath: file, composition, outDir: out, hasAudio: true, videoSeconds: 25, audioSeconds: 25, timeoutSeconds: 120 },
    );
    expect(RenderInspectionSchema.parse(JSON.parse(readFileSync(path, "utf8")))).toEqual(inspection);
    expect(inspection.freezes).toHaveLength(1);
    expect(inspection.freezes[0]!.start).toBeGreaterThan(17);
    expect(inspection.freezes[0]!.end).toBe(25);
    expect(inspection.silences[0]!.start).toBeCloseTo(10, 0);
    expect(inspection.segments[0]!.lufs).not.toBeNull();
    expect(inspection.issues.map((i) => i.code)).toEqual(["silence", "freeze"]);
    expect(inspection.issues[1]).toMatchObject({ severity: "warning", to_end: true });
    expect(sheets).toHaveLength(1);
    expect(existsSync(sheets[0]!)).toBe(true);
    expect(inspection.sheets[0]).toMatchObject({ file: "sheet-01.jpg", from_s: 0, frames: 3, columns: 5, rows: 4 });
    expect(existsSync(join(out, "loudness.txt"))).toBe(false);
  });

  it("makes a sheet of one frame for a file shorter than the sheet's step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inspect-short-"));
    tempDirs.push(dir);
    const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
    const file = join(dir, "short.mp4");
    expect(spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=3", "-c:v", "libx264", "-preset", "ultrafast", file]).status).toBe(0);
    const composition = { total_seconds: 3, segments: [{ order: 0, start: 0, end: 3 }] } as unknown as Composition;
    const { inspection, sheets } = await inspectRender(
      { ffmpeg, clock: { now: () => new Date().toISOString() } },
      { episodePath: file, composition, outDir: join(dir, "inspect"), hasAudio: false, videoSeconds: 3, audioSeconds: null, timeoutSeconds: 60 },
    );
    expect(sheets).toHaveLength(1);
    expect(inspection.sheets[0]).toMatchObject({ frames: 1 });
    expect(inspection.segments[0]!.lufs).toBeNull();
    expect(inspection.issues).toEqual([]);
  });
});
