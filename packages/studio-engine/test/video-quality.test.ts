import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RenderInspection, TimelineV4 } from "@harness/contracts";
import { createProject, createThread, createVideo, measureVideo, postUserMessage, saveVideoRevision, videoQuality, type StudioDb } from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-11-01T00:00:00.000Z";
const PERIOD = { from: "2026-10-31T00:00:00.000Z", to: "2026-11-07T00:00:00.000Z" };

/** A narrated cut: `shots` clip lengths in seconds, a line on every clip but those in `silent`. */
function timeline(shots: number[], o: { silent?: number[]; music?: boolean; reuse?: boolean; project?: string; video?: string } = {}): TimelineV4 {
  const assets: TimelineV4["assets"] = {};
  const clips = shots.map((len, i) => {
    const asset = o.reuse && i === 1 ? "a0" : `a${i}`;
    assets[asset] = { title: `Cảnh ${i}`, summary_vi: "…", duration_s: 120, orientation: "landscape" };
    return { clip_id: `C${String(i + 1).padStart(3, "0")}`, asset_id: asset, section_title: null, in: o.reuse && i === 1 ? 1 : 0, out: (o.reuse && i === 1 ? 1 : 0) + len, shot_id: null,
      line_id: o.silent?.includes(i) ? null : `L${String(i + 1).padStart(3, "0")}`, transition_out: { kind: "cut" as const, seconds: 0 } };
  });
  const lines = clips.filter((c) => c.line_id).map((c) => ({ line_id: c.line_id!, text: "Một câu đọc", audio: { key: "a".repeat(64), duration_s: 3, words: [] } }));
  return {
    schema_version: "studio.timeline/v4", production_id: o.project ?? "p", episode_id: o.video ?? "e", canvas: { width: 1920, height: 1080 }, fps: 30, language: "vi", edit_style: "cut",
    clips, texts: [], narration: { voice: "tts", lead_seconds: 0.3, lines }, captions: { mode: "burn-in" },
    music: o.music === false ? null : { key: "library:studio/m.mp3", title: "Nhạc", gain_db: -18 } as unknown as TimelineV4["music"],
    source_audio: { muted: true }, assets, alternates: [],
  };
}

function inspection(issues: RenderInspection["issues"], lufs = -15): RenderInspection {
  return {
    schema_version: "harness.render-inspect/v1", expected_seconds: 60, video_seconds: 60, audio_seconds: 60, freezes: [], blacks: [], silences: [], segments: [],
    loudness_median_lufs: lufs, sheets: [], issues, inspect_seconds: 3,
  } as RenderInspection;
}

const quiet = { renders: 1, asksAfterFirstRender: 0, agentEditsAfterFirstRender: 0 };

describe("measuring one video", () => {
  it("a clean cut has numbers and no warnings", () => {
    const m = measureVideo(timeline([4, 5, 6, 5, 4]), { inspected: true }, inspection([]), quiet);
    expect(m).toMatchObject({ shots: 5, shotMedian: 5, longShare: 0, shortShare: 0, longestShot: 6, assetVariety: 1, lines: 5, linesWithoutAudio: 0, music: true, captions: "burn-in" });
    expect(m.flags).toEqual([]);
  });

  it("flags long holds, flashes, voice gaps, footage used twice, loudness and retakes", () => {
    const m = measureVideo(
      timeline([25, 25, 0.5, 0.6, 0.5, 30], { silent: [1, 2, 3], music: false, reuse: true }),
      { inspected: true, problem: "thiếu tiếng" },
      inspection([
        { code: "freeze", severity: "error", start: 1, end: 9 },
        ...[1, 2, 3].map((order) => ({ code: "clip_loudness", severity: "warning" as const, order, delta_db: 20 })),
      ], -24),
      { renders: 7, asksAfterFirstRender: 12, agentEditsAfterFirstRender: 4 },
    );
    expect(m.flags.map((f) => f.code).sort()).toEqual(
      ["clip_loudness", "fast_cuts", "freeze", "jump_cuts", "long_shots", "loudness_off", "many_retakes", "narration_overrun", "no_music", "render_problem", "repeated_footage", "voice_gaps"].sort(),
    );
    expect(m.maxVoiceGap).toBeGreaterThan(10);
  });

  it("says when the render was not inspected, and when narration has no voice yet", () => {
    const t = timeline([4, 4, 4]);
    t.narration.lines[0]!.audio = null;
    const m = measureVideo(t, { inspected: false }, null, quiet);
    expect(m.flags.map((f) => f.code)).toEqual(["lines_without_audio", "no_inspection"]);
    expect(m.inspect).toBeNull();
  });
});

describe("videos of a period", () => {
  let db: StudioDb | null = null;
  afterEach(async () => { await db?.close(); db = null; });

  it("one row per video, its final render first, with the inspection read from the workspace and asks after the first render", async () => {
    const w = await world();
    db = w.db;
    await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Nhóm', ?, ?)", [NOW, NOW]);
    const p = await createProject(w.db, "team-1", { name: "Mưa", description: "", language: "vi", aspect: "16:9" }, "auth0|lan", NOW);
    const v = await createVideo(w.db, p.id, { title: "Mưa trên núi", createdBy: "auth0|lan" }, NOW);
    const t = await createThread(w.db, { projectId: p.id, videoId: v.id, kind: "video", title: "Mưa", createdBy: "auth0|lan" }, NOW);
    await saveVideoRevision(w.db, v.id, { baseRevision: 0, data: timeline([4, 5, 6], { project: p.id, video: v.id, music: false }), authorId: "system", label: "fit" });
    const root = mkdtempSync(join(tmpdir(), "vq-"));
    const dir = `videos/${v.id}/renders/final-r1`;
    mkdirSync(join(root, p.id, dir), { recursive: true });
    writeFileSync(join(root, p.id, dir, "inspect.json"), JSON.stringify(inspection([{ code: "black", severity: "error", start: 0, end: 2 }])));
    const render = async (kind: string, finished: string, result: object) => {
      await w.db.run(
        `INSERT INTO project_jobs (id, project_id, video_id, kind, status, title, request, result, created_by, created_at, started_at, finished_at, updated_at)
         VALUES (?, ?, ?, ?, 'done', 'r', '{}', ?::jsonb, 'u', ?, ?, ?, ?)`,
        [randomUUID(), p.id, v.id, kind, JSON.stringify(result), finished, finished, finished, finished],
      );
    };
    await render("render_preview", "2026-11-01T10:00:00.000Z", { revision: 1, height: 1080, duration_s: 15 });
    await render("render_final", "2026-11-02T10:00:00.000Z", { revision: 1, height: 2160, width: 3840, duration_s: 15, inspect: { dir, sheets: [], issues: [] } });
    await render("render_preview", "2026-11-03T10:00:00.000Z", { revision: 1, height: 1080 });
    await postUserMessage(w.db, { threadId: t.id, text: "Đổi cảnh", actor: { id: "auth0|lan", role: "editor" } }, "2026-11-01T11:00:00.000Z");
    await postUserMessage(w.db, { threadId: t.id, text: "Trước render", actor: { id: "auth0|lan", role: "editor" } }, "2026-11-01T09:00:00.000Z");

    const q = await videoQuality(w.db, PERIOD, { workspacesRoot: root });
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0]).toMatchObject({ kind: "render_final", height: 2160, renders: 3, asksAfterFirstRender: 1, inspect: { issues: { black: 1 } }, projectName: "Mưa" });
    expect(q.rows[0]!.flags.map((f) => f.code)).toEqual(["black", "no_music"]);
    expect(q.summary).toMatchObject({ videos: 1, flags: [{ code: "black", videos: 1, severity: "error" }, { code: "no_music", videos: 1, severity: "info" }], byHeight: { "2160": 1 } });
    expect((await videoQuality(w.db, { from: "2026-12-01T00:00:00.000Z", to: "2026-12-02T00:00:00.000Z" })).rows).toEqual([]);
  });
});
