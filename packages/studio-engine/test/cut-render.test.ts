import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompositionSchema, TimelineV4Schema, upgradeTimelineV3, type TimelineV4 } from "@harness/contracts";
import { prepareRender, replaceEpisodes, saveEpisodeRevision, startPremiereExport, StudioRunError, voicePath } from "../src/index.js";
import { seedProduction, world } from "./helpers.js";

const KEY = "c".repeat(64);

function cut(): TimelineV4 {
  const base = upgradeTimelineV3({
    schema_version: "studio.timeline/v3", production_id: "prod-1", episode_id: "ep-1", canvas: { width: 3840, height: 2160 }, fps: 30, language: "vi",
    clips: [{ clip_id: "C001", asset_id: "a", section_title: null }, { clip_id: "C002", asset_id: "a", section_title: null }],
    texts: [], music: null, source_audio: { muted: false },
    assets: { a: { title: "Phố cổ", summary_vi: "Phố", duration_s: 30, orientation: "landscape" } }, alternates: [],
  });
  return TimelineV4Schema.parse({
    ...base, edit_style: "cut",
    clips: [{ ...base.clips[0]!, in: 1, out: 5, line_id: "L001" }, { ...base.clips[1]!, in: 10, out: 14 }],
    narration: { voice: "tts", lead_seconds: 0.3, lines: [{ line_id: "L001", text: "Phố cổ.", audio: { key: KEY, duration_s: 1.2, words: [] } }] },
    captions: { mode: "burn-in" },
  });
}

describe("rendering a shot-cut timeline", () => {
  it("uploads each narration line from the voice store as stage:voice/<line_id>.wav", async () => {
    const voiceDir = mkdtempSync(join(tmpdir(), "voice-"));
    writeFileSync(voicePath(voiceDir, KEY), "RIFF-L001");
    const work = mkdtempSync(join(tmpdir(), "render-"));
    const build = await prepareRender(work, { timeline: cut(), revision: 2, productionId: "prod-1", episodeId: "ep-1", output: "episodes/ep-1/renders/final.mp4", thumbnails: [], voiceDir });
    expect(build.extraUploads?.map((u) => u.relPath)).toEqual(["composition.json", "voice/L001.wav"]);
    expect(readFileSync(build.extraUploads![1]!.localPath, "utf8")).toBe("RIFF-L001");
    const composition = CompositionSchema.parse(JSON.parse(readFileSync(build.extraUploads![0]!.localPath, "utf8")));
    expect(composition.narration).toEqual([{ line_id: "L001", wav: "stage:voice/L001.wav", start: 0.3, end: 1.5 }]);
    expect(composition.segments[0]).toMatchObject({ in: 1, out: 5 });
  });

  it("a narration line missing from the voice store stops the render, naming it", async () => {
    const work = mkdtempSync(join(tmpdir(), "render-"));
    await expect(prepareRender(work, { timeline: cut(), revision: 2, productionId: "prod-1", episodeId: "ep-1", output: "o.mp4", thumbnails: [], voiceDir: mkdtempSync(join(tmpdir(), "voice-")) }))
      .rejects.toThrow(/L001/);
    await expect(prepareRender(work, { timeline: cut(), revision: 2, productionId: "prod-1", episodeId: "ep-1", output: "o.mp4", thumbnails: [] }))
      .rejects.toThrow(/voice store/);
  });

  it("Premiere does not yet take a trimmed or narrated timeline (phase 4)", async () => {
    const { db, bucket } = world();
    const prod = seedProduction(db);
    replaceEpisodes(db, prod, [{ id: "ep-1", idx: 1, title: "T", hook: "h", plan: "{}", edit_style: "cut" }], "plan-run");
    saveEpisodeRevision(db, "ep-1", { baseRevision: 0, data: { ...cut(), production_id: prod }, authorId: "system" });
    const farm = { submitJob: async () => { throw new Error("must not be called"); } };
    const err = await startPremiereExport({ db, bucket, farm: farm as never }, { productionId: prod, episodeId: "ep-1", media: "proxy", userId: "u" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioRunError);
    expect((err as StudioRunError).details).toMatchObject({ code: "premiere_needs_phase_4" });
  });
});
