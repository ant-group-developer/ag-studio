import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StudioTtsPayloadSchema } from "@ag-farm/protocol";
import { TimelineV4Schema } from "@harness/contracts";
import { studioSourceId } from "@harness/core";
import { cutPayloadBuilders, cutStages, productionVoice, replaceEpisodes, type CutMediaDeps } from "../src/index.js";
import { fakeFootage, seedProduction, world } from "./helpers.js";
import { runStage, stageWorkspace } from "./stage-harness.js";

const A = studioSourceId("a");
const CLONE = {
  mode: "clone", reference: "library:studio/p/voice/abc.wav", reference_text: null, speed: 1, origin: "own",
  source: { kind: "upload", filename: "giong.m4a" }, sha256: "abc", duration_s: 12, confirmed_by: "u1", confirmed_at: "2026-10-07T00:00:00.000Z",
};
const DECLINED = { mode: "none", decided_by: "u1", decided_at: "2026-10-07T00:00:00.000Z" };

function media(): CutMediaDeps {
  return { ffmpeg: "ffmpeg", ffprobe: "ffprobe", voiceDir: mkdtempSync(join(tmpdir(), "voice-")), resolveAssets: async () => ({ items: [], missing: [] }), download: async () => {} };
}

function ttsSetup(voice: unknown) {
  const { db, bucket } = world();
  const prod = seedProduction(db);
  db.run("UPDATE productions SET voice = ? WHERE id = ?", [voice === null ? null : JSON.stringify(voice), prod]);
  const plan = {
    schema_version: "studio.edit-plan/v1", episode_id: "ep-1", narration: "tts", language: "vi", target_seconds: 30,
    shots: [{ order: 1, shot_id: "s000-000", source_id: A, in: 0, out: 4, line_id: "L001", transition: "cut", section_title: null, note: "" }],
    lines: [{ line_id: "L001", text: "Ga Ninh Bình." }], texts: [], music_mood: null,
  };
  const run = stageWorkspace({ runId: "r", stageKey: "tts", inputs: [
    { type: "studio_edit_plan", name: "edit-plan.json", json: plan },
    { type: "studio_brief", name: "brief.json", json: { production_id: prod, language: "vi" } },
  ] });
  return { run, builder: cutPayloadBuilders({ db, bucket, media: media() })["studio-cut-tts"]! };
}

describe("productionVoice", () => {
  it("not asked: the Studio default if set, else missing", () => {
    expect(productionVoice(null, {})).toEqual({ kind: "missing" });
    expect(productionVoice(null, { STUDIO_DEFAULT_VOICE_REFERENCE: "library:voices/d.wav", STUDIO_DEFAULT_VOICE_TEXT: "Xin chào." }))
      .toEqual({ kind: "clone", voice: { reference: "library:voices/d.wav", reference_text: "Xin chào.", speed: 1 } });
  });

  it("declined narration wins over the Studio default", () => {
    expect(productionVoice(JSON.stringify(DECLINED), { STUDIO_DEFAULT_VOICE_REFERENCE: "library:voices/d.wav" })).toEqual({ kind: "none" });
  });

  it("a sample: the voice the farm reads with, nothing else", () => {
    expect(productionVoice(JSON.stringify(CLONE), {})).toEqual({ kind: "clone", voice: { reference: CLONE.reference, reference_text: null, speed: 1 } });
  });

  it("the old column shape still reads; one without a reference is missing", () => {
    expect(productionVoice(JSON.stringify({ reference: "library:voices/a.wav", reference_text: "x", speed: 1 }), {}).kind).toBe("clone");
    expect(productionVoice(JSON.stringify({ reference: null, reference_text: null, speed: 1 }), {})).toEqual({ kind: "missing" });
  });
});

describe("studio-cut-tts without a voice", () => {
  it("narration declined for the production: skip, no job", async () => {
    const { builder, run } = ttsSetup(DECLINED);
    const build = await builder(run.request, run.ctx);
    expect(build.payload).toBeNull();
    expect(build.skip).toBeDefined();
  });

  it("no voice yet: a contract error that says the step needs a voice", async () => {
    const { builder, run } = ttsSetup(null);
    await expect(builder(run.request, run.ctx)).rejects.toMatchObject({ code: "CONFIG_INVALID", details: { code: "needs_voice" } });
  });

  it("a sample the person gave: read in it", async () => {
    const { builder, run } = ttsSetup(CLONE);
    const payload = StudioTtsPayloadSchema.parse((await builder(run.request, run.ctx)).payload);
    expect(payload.voice).toEqual({ reference: CLONE.reference, reference_text: null, speed: 1 });
  });
});

describe("studio-cut-fit without a voice", () => {
  async function fit(o: { voice: unknown; productionMusic?: unknown; briefMusic?: unknown }) {
    const { db, bucket } = world();
    const prod = seedProduction(db);
    db.run("UPDATE productions SET voice = ?, music = ? WHERE id = ?", [JSON.stringify(o.voice), o.productionMusic ? JSON.stringify(o.productionMusic) : null, prod]);
    replaceEpisodes(db, prod, [{ id: "ep-1", idx: 1, title: "Ga", hook: "h", plan: "{}", edit_style: "cut" }], "plan-run");
    const shots = { schema_version: "harness.shots/v2", sources: [{ source_id: A, index: 0, file_name: "a.mp4", duration_seconds: 30, has_audio: true, shots: [{ shot_id: "s000-000", in: 0, out: 10 }, { shot_id: "s000-001", in: 10, out: 30 }] }] };
    const survey = { schema_version: "harness.survey-index/v2", shots: shots.sources[0]!.shots.map((x) => ({ source_id: A, shot_id: x.shot_id, in: x.in, out: x.out, score: 4, tags: [], usable: true, note: "", speech: "ambient" })) };
    const plan = {
      schema_version: "studio.edit-plan/v1", episode_id: "ep-1", narration: "tts", language: "vi", target_seconds: 10,
      shots: [
        { order: 1, shot_id: "s000-000", source_id: A, in: 1, out: 5, line_id: "L001", transition: "cut", section_title: null, note: "" },
        { order: 2, shot_id: "s000-001", source_id: A, in: 12, out: 16, line_id: null, transition: "cut", section_title: null, note: "" },
      ],
      lines: [{ line_id: "L001", text: "Ga Ninh Bình." }], texts: [], music_mood: null,
    };
    const run = stageWorkspace({ runId: "run-cut", stageKey: "fit-timeline", inputs: [
      { type: "studio_edit_plan", name: "edit-plan.json", json: plan },
      { type: "shots", name: "shots.json", json: shots },
      { type: "survey_index", name: "survey.json", json: survey },
      { type: "transcript", name: "transcribe.json", json: { schema: "ag.studio.transcribe/v1", production_id: prod, engine: { name: "none", version: null }, sources: [] } },
      { type: "cut_sources", name: "sources.json", json: { schema_version: "studio.cut-sources/v1", production_id: prod, episode_id: "ep-1", language: "vi", narration: "tts",
        sources: [{ index: 0, asset_id: "a", source_id: A, title: "Ga", duration_s: 30, has_speech: null, hints: null }] } },
      { type: "studio_episode", name: "episode.json", json: { assets: { a: { title: "Ga", summary_vi: "Ga", duration_s: 30, orientation: "landscape" } } } },
      { type: "studio_brief", name: "brief.json", json: { production_id: prod, language: "vi", canvas: { width: 3840, height: 2160 }, fps: 30, music: o.briefMusic ?? null } },
      { type: "voice_manifest", name: "tts.json", json: { schema: "ag.studio.tts/v1", production_id: prod, language: "vi", lines: [], engine: { name: "voice-store", version: null } } },
    ] });
    await runStage(cutStages({ db, bucket, footage: fakeFootage(), startEpisodeRun: async () => ({ runId: "x" }), media: media() })["studio-cut-fit"], run);
    return TimelineV4Schema.parse(run.json("timeline.json"));
  }

  it("narration declined: the cut keeps its shots, and its lines unread, as subtitles", async () => {
    const t = await fit({ voice: DECLINED });
    expect(t.narration.voice).toBe("none");
    expect(t.narration.lines.length).toBeGreaterThan(0);
    expect(t.narration.lines.every((l) => l.audio === null)).toBe(true);
    expect(t.clips.some((c) => c.line_id !== null)).toBe(true);
    expect(t.captions.mode).toBe("burn-in");
  });

  it("the production's music now wins over the one frozen in the brief", async () => {
    const t = await fit({
      voice: DECLINED,
      productionMusic: { track: "library:studio/p/music/x.mp3", gain_db: -20, ducking: true, source: { kind: "link", url: "https://a.b/x.mp3" }, sha256: "x", duration_s: 90 },
      briefMusic: { track: "library:music/old.mp3", gain_db: -18, ducking: false },
    });
    expect(t.music).toEqual({ track: "library:studio/p/music/x.mp3", gain_db: -20, ducking: true });
  });

  it("no music on the production: the brief's", async () => {
    const t = await fit({ voice: DECLINED, briefMusic: { track: "library:music/old.mp3", gain_db: -18, ducking: false } });
    expect(t.music).toEqual({ track: "library:music/old.mp3", gain_db: -18, ducking: false });
  });
});
