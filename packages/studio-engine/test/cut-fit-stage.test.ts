import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TimelineV4Schema } from "@harness/contracts";
import { studioSourceId } from "@harness/core";
import { cutStages, getVoiceLine, latestEpisodeRevision, replaceEpisodes, voiceKey, type CutMediaDeps } from "../src/index.js";
import { fakeFootage, seedProduction, world } from "./helpers.js";
import { runStage, stageWorkspace } from "./stage-harness.js";

const A = studioSourceId("a");
const VOICE = { reference: "library:voices/mai.wav", reference_text: "Xin chào.", speed: 1 };

describe("studio-cut-fit", () => {
  it("keeps the lines the farm read, fits the plan and saves the timeline v4 as a new revision", async () => {
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
        { order: 2, shot_id: "s000-001", source_id: A, in: 12, out: 16, line_id: null, transition: "cut", section_title: null, note: "" },
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
    ] });
    await runStage(cutStages({ db, bucket, footage: fakeFootage(), startEpisodeRun: async () => ({ runId: "x" }), media })["studio-cut-fit"], run);

    const key = voiceKey({ text: "Phố cổ lúc chiều.", language: "vi", voice: VOICE });
    expect(getVoiceLine(db, voiceDir, key)).toMatchObject({ duration_s: 1.9, words: [{ word: "Phố", start: 0, end: 0.3 }] });
    const t = TimelineV4Schema.parse(run.json("timeline.json"));
    expect(t.narration.lines[0]?.audio?.key).toBe(key);
    expect(t.clips.map((c) => c.line_id)).toEqual(["L001", null]);
    expect(run.json<{ schema_version: string }>("fit-report.json").schema_version).toBe("harness.fit-report/v1");
    const rev = latestEpisodeRevision(db, "ep-1")!;
    expect(rev).toMatchObject({ revision: 1, author_id: "system", label: "fit" });
    expect(rev.data).toEqual(t);
  });
});
