import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TimelineV4Schema } from "@harness/contracts";
import { studioSourceId } from "@harness/core";
import { cutStages, getVoiceLine, latestEpisodeRevision, replaceEpisodes, saveLibraryMusic, voiceKey, type CutMediaDeps } from "../src/index.js";
import { fakeFootage, seedProduction, world } from "./helpers.js";
import { runStage, stageWorkspace, type StageInput } from "./stage-harness.js";

const A = studioSourceId("a");
const VOICE = { reference: "library:voices/mai.wav", reference_text: "Xin chào.", speed: 1 };

/** A production with a voice, one shot-cut episode, and the fit's inputs for a two-shot plan (`shot2`: over its second shot). */
function setup(shot2: Record<string, unknown> = {}, extra: StageInput[] = []) {
  const { db, bucket } = world();
  const prod = seedProduction(db);
  db.run("UPDATE productions SET voice = ? WHERE id = ?", [JSON.stringify(VOICE), prod]);
  replaceEpisodes(db, prod, [{ id: "ep-1", idx: 1, title: "Phố cổ", hook: "h", plan: "{}", edit_style: "cut" }], "plan-run");
  const voiceDir = mkdtempSync(join(tmpdir(), "voice-"));
  const media: CutMediaDeps = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", voiceDir, resolveAssets: async () => ({ items: [], missing: [] }), download: async () => {} };

  const ttsDir = join(mkdtempSync(join(tmpdir(), "tts-")), "tts");
  mkdirSync(ttsDir, { recursive: true });
  writeFileSync(join(ttsDir, "L001.wav"), "RIFF-L001");
  const shots = { schema_version: "harness.shots/v2", sources: [{ source_id: A, index: 0, file_name: "a.mp4", duration_seconds: 30, has_audio: true, shots: [{ shot_id: "s000-000", in: 0, out: 10 }, { shot_id: "s000-001", in: 10, out: 30 }] }] };
  const survey = { schema_version: "harness.survey-index/v2", shots: shots.sources[0]!.shots.map((x) => ({ source_id: A, shot_id: x.shot_id, in: x.in, out: x.out, score: 4, tags: [], usable: true, note: "", speech: "ambient" })) };
  const plan = {
    schema_version: "studio.edit-plan/v1", episode_id: "ep-1", narration: "tts", language: "vi", target_seconds: 10,
    shots: [
      { order: 1, shot_id: "s000-000", source_id: A, in: 1, out: 5, line_id: "L001", transition: "cut", section_title: null, note: "" },
      { order: 2, shot_id: "s000-001", source_id: A, in: 12, out: 16, line_id: null, transition: "cut", section_title: null, note: "", ...shot2 },
    ],
    lines: [{ line_id: "L001", text: "Phố cổ lúc chiều." }], texts: [], music_mood: null,
  };
  const run = stageWorkspace({ runId: "run-cut", stageKey: "fit-timeline", inputs: [
    { type: "studio_edit_plan", name: "edit-plan.json", json: plan },
    { type: "shots", name: "shots.json", json: shots },
    { type: "survey_index", name: "survey.json", json: survey },
    { type: "transcript", name: "transcribe.json", json: { schema: "ag.studio.transcribe/v1", production_id: prod, engine: { name: "none", version: null }, sources: [] } },
    { type: "cut_sources", name: "sources.json", json: { schema_version: "studio.cut-sources/v1", production_id: prod, episode_id: "ep-1", language: "vi", narration: "tts",
      sources: [{ index: 0, asset_id: "a", source_id: A, title: "Phố", duration_s: 30, has_speech: null, hints: null }] } },
    { type: "studio_episode", name: "episode.json", json: { assets: { a: { title: "Phố", summary_vi: "Phố", duration_s: 30, orientation: "landscape" } } } },
    { type: "studio_brief", name: "brief.json", json: { production_id: prod, language: "vi", canvas: { width: 3840, height: 2160 }, fps: 30, music: null } },
    { type: "voice_manifest", name: "tts.json", json: { schema: "ag.studio.tts/v1", production_id: prod, language: "vi", lines: [{ line_id: "L001", output: "tts/L001.wav", duration_s: 1.9, words: [{ word: "Phố", start: 0, end: 0.3 }] }], engine: { name: "omnivoice", version: null } } },
    { type: "voice_set", name: "tts", dir: ttsDir },
    ...extra,
  ] });
  const stages = cutStages({ db, bucket, footage: fakeFootage(), startEpisodeRun: async () => ({ runId: "x" }), media });
  return { db, prod, voiceDir, run, stages };
}

describe("studio-cut-fit", () => {
  it("keeps the lines the farm read, fits the plan and saves the timeline v4 as a new revision", async () => {
    const { db, voiceDir, run, stages } = setup({ source_audio: "mute" });
    await runStage(stages["studio-cut-fit"], run);

    const key = voiceKey({ text: "Phố cổ lúc chiều.", language: "vi", voice: VOICE });
    expect(getVoiceLine(db, voiceDir, key)).toMatchObject({ duration_s: 1.9, words: [{ word: "Phố", start: 0, end: 0.3 }] });
    const t = TimelineV4Schema.parse(run.json("timeline.json"));
    expect(t.narration.lines[0]?.audio?.key).toBe(key);
    expect(t.clips.map((c) => c.line_id)).toEqual(["L001", null]);
    expect(run.json<{ schema_version: string }>("fit-report.json").schema_version).toBe("harness.fit-report/v1");
    const rev = latestEpisodeRevision(db, "ep-1")!;
    expect(rev).toMatchObject({ revision: 1, author_id: "system", label: "fit" });
    expect(rev.data).toEqual(t);
    // fit v1 leaves the clips' sound alone, whatever the plan says
    expect(t.clips.every((x) => x.muted === undefined)).toBe(true);
  });
});

describe("studio-cut-fit-v2 (cut 1.1.0)", () => {
  it("a shot the edit plan mutes gives a muted clip; the others keep their sound", async () => {
    const { run, stages } = setup({ source_audio: "mute" });
    await runStage(stages["studio-cut-fit-v2"], run);
    const t = TimelineV4Schema.parse(run.json("timeline.json"));
    expect(t.clips.map((x) => [x.shot_id, x.muted ?? false])).toEqual([["s000-000", false], ["s000-001", true]]);
    expect(run.logs.find((l) => l.msg === "shot-cut timeline fitted")?.fields).toMatchObject({ muted_clips: 1 });
  });
});

describe("studio-cut-fit-v2: the branding's text look", () => {
  const look = { text_color: "#FFD166", outline_color: "#000000", box_color: "#1D3557", size: "l" };
  const branding = (withLook: boolean) => ({
    schema_version: "studio.branding/v1", series_name: "Phố Cổ", tagline: "", positioning: "Chân thật",
    voice: { personality: [], do: [], dont: [], signature_phrases: [], banned_words: [] },
    titles: { formulas: ["[Nơi]"], rules: [], examples: [], max_chars: 60 }, description: { opening: "", cta: "", hashtags: [] },
    thumbnail: { concept: "Phố", text_rules: [], max_words: 3, text_case: "upper", palette: { text: "#FFFFFF", outline: "#000000", accent: "#E63946" }, position: "bottom", emotion: "", do: [], dont: [] },
    on_screen_text: { style: "", max_chars: 40, rules: [], ...(withLook ? { look } : {}) }, music_mood: [],
  });

  it("is frozen into the timeline; fit v1, or a branding without one, leaves the default look", async () => {
    const withLook = setup({}, [{ type: "studio_branding", name: "branding.json", json: branding(true) }]);
    await runStage(withLook.stages["studio-cut-fit-v2"], withLook.run);
    expect(TimelineV4Schema.parse(withLook.run.json("timeline.json")).text_style).toEqual(look);

    const v1 = setup({}, [{ type: "studio_branding", name: "branding.json", json: branding(true) }]);
    await runStage(v1.stages["studio-cut-fit"], v1.run);
    expect(TimelineV4Schema.parse(v1.run.json("timeline.json")).text_style).toBeUndefined();

    const plain = setup({}, [{ type: "studio_branding", name: "branding.json", json: branding(false) }]);
    await runStage(plain.stages["studio-cut-fit-v2"], plain.run);
    expect(TimelineV4Schema.parse(plain.run.json("timeline.json")).text_style).toBeUndefined();
  });
});

describe("studio-cut-fit-v2: music from the team's library", () => {
  const track = (id: string, mood: string[]) => ({
    schema_version: "harness.music-track/v1", track_id: id, display_name: id, file: `library:music/${id}.m4a`, mood, duration_seconds: 300,
    loop_ok: true, origin: "own", origin_note: "nhóm", checksum: `sha256:${"a".repeat(64)}`, active: true,
    created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z",
  } as const);
  const branding = (music_mood: string[]) => ({
    schema_version: "studio.branding/v1", series_name: "Phố Cổ", tagline: "", positioning: "Chân thật",
    voice: { personality: [], do: [], dont: [], signature_phrases: [], banned_words: [] },
    titles: { formulas: ["[Nơi]"], rules: [], examples: [], max_chars: 60 }, description: { opening: "", cta: "", hashtags: [] },
    thumbnail: { concept: "Phố", text_rules: [], max_words: 3, text_case: "upper", palette: { text: "#FFFFFF", outline: "#000000", accent: "#E63946" }, position: "bottom", emotion: "", do: [], dont: [] },
    on_screen_text: { style: "", max_chars: 40, rules: [] }, music_mood,
  });

  it("no music of the production's own: the track of the first mood the library has (the branding's here)", async () => {
    const s = setup({}, [{ type: "studio_branding", name: "branding.json", json: branding(["Jazz", "Ấm áp"]) }]);
    saveLibraryMusic(s.db, track("am-ap", ["ấm áp"]));
    saveLibraryMusic(s.db, track("upbeat", ["upbeat"]));
    await runStage(s.stages["studio-cut-fit-v2"], s.run);
    expect(TimelineV4Schema.parse(s.run.json("timeline.json")).music).toEqual({ track: "library:music/am-ap.m4a", gain_db: -18, ducking: true });
    expect(s.run.logs.find((l) => l.msg === "shot-cut timeline fitted")?.fields).toMatchObject({ library_music: { track_id: "am-ap", mood: "Ấm áp" } });
  });

  it("the production's own music wins; fit v1 never picks one; no mood in the library: no music", async () => {
    const own = setup({}, [{ type: "studio_branding", name: "branding.json", json: branding(["ấm áp"]) }]);
    saveLibraryMusic(own.db, track("am-ap", ["ấm áp"]));
    own.db.run("UPDATE productions SET music = ? WHERE id = ?", [JSON.stringify({ track: "library:studio/p/music/x.m4a", gain_db: -20, ducking: false }), own.prod]);
    await runStage(own.stages["studio-cut-fit-v2"], own.run);
    expect(TimelineV4Schema.parse(own.run.json("timeline.json")).music?.track).toBe("library:studio/p/music/x.m4a");

    const v1 = setup({}, [{ type: "studio_branding", name: "branding.json", json: branding(["ấm áp"]) }]);
    saveLibraryMusic(v1.db, track("am-ap", ["ấm áp"]));
    await runStage(v1.stages["studio-cut-fit"], v1.run);
    expect(TimelineV4Schema.parse(v1.run.json("timeline.json")).music).toBeNull();

    const none = setup({}, [{ type: "studio_branding", name: "branding.json", json: branding(["jazz"]) }]);
    saveLibraryMusic(none.db, track("am-ap", ["ấm áp"]));
    await runStage(none.stages["studio-cut-fit-v2"], none.run);
    expect(TimelineV4Schema.parse(none.run.json("timeline.json")).music).toBeNull();
  });
});
