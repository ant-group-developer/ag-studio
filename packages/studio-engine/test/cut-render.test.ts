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

  function premiereWorld(timeline: TimelineV4 = cut()) {
    const { db, bucket } = world();
    const prod = seedProduction(db);
    replaceEpisodes(db, prod, [{ id: "ep-1", idx: 1, title: "T", hook: "h", plan: "{}", edit_style: "cut" }], "plan-run");
    saveEpisodeRevision(db, "ep-1", { baseRevision: 0, data: { ...timeline, production_id: prod }, authorId: "system" });
    const submitted: { type: string; payload: Record<string, unknown> }[] = [];
    const farm = { submitJob: async (j: { type: string; payload: Record<string, unknown> }) => { submitted.push(j); return { job: { id: `farm-${submitted.length}` } }; } };
    return { db, bucket, prod, submitted, farm: farm as never };
  }

  it("Premiere takes a trimmed, dissolved, narrated timeline: the composition and each line's WAV go with the job", async () => {
    const voiceDir = mkdtempSync(join(tmpdir(), "voice-"));
    writeFileSync(voicePath(voiceDir, KEY), "RIFF-L001");
    const t = cut();
    t.clips[0]!.transition_out = { kind: "dissolve", seconds: 0.5 };
    const w = premiereWorld(t);
    const job = await startPremiereExport({ db: w.db, bucket: w.bucket, farm: w.farm, voiceDir }, { productionId: w.prod, episodeId: "ep-1", media: "proxy", userId: "u" });
    expect(job.status).toBe("running");
    expect(w.submitted.map((j) => j.type)).toEqual(["studio.export_premiere"]);
    // a worker that cannot read shot-cut episodes refuses the job instead of dropping trims and narration
    expect(w.submitted[0]!.payload).toMatchObject({ composition: "stage:composition.json", media: "proxy", edit_style: "cut" });
    const keys = [...w.bucket.objects.keys()].filter((k) => k.includes(`/editor-premiere/${job.id}/`));
    expect(keys.map((k) => k.slice(k.indexOf("/in/") + 4)).sort()).toEqual(["composition.json", "voice/L001.wav"]);
    expect(w.bucket.objects.get(keys.find((k) => k.endsWith("voice/L001.wav"))!)!.toString("utf8")).toBe("RIFF-L001");
    const composition = CompositionSchema.parse(JSON.parse(w.bucket.objects.get(keys.find((k) => k.endsWith("composition.json"))!)!.toString("utf8")));
    expect(composition.segments[0]).toMatchObject({ in: 1, out: 5 });
    expect(composition.narration).toEqual([{ line_id: "L001", wav: "stage:voice/L001.wav", start: 0.3, end: 1.5 }]);
  });

  it("Premiere of a timeline whose narration WAV is gone is refused, naming the line; no job is made", async () => {
    const w = premiereWorld();
    const err = await startPremiereExport({ db: w.db, bucket: w.bucket, farm: w.farm, voiceDir: mkdtempSync(join(tmpdir(), "voice-")) }, { productionId: w.prod, episodeId: "ep-1", media: "proxy", userId: "u" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioRunError);
    expect((err as StudioRunError).code).toBe("invalid");
    expect((err as StudioRunError).details).toMatchObject({ code: "narration_missing", line_id: "L001" });
    expect(w.submitted).toHaveLength(0);
    expect(w.db.all("SELECT id FROM episode_jobs")).toHaveLength(0);
  });

  it("Premiere of a timeline without narration sends no WAV, and needs no voice store", async () => {
    const t = cut();
    t.narration = { ...t.narration, voice: "none", lines: [] };
    t.clips[0]!.line_id = null;
    const w = premiereWorld(t);
    const job = await startPremiereExport({ db: w.db, bucket: w.bucket, farm: w.farm }, { productionId: w.prod, episodeId: "ep-1", media: "original", userId: "u" });
    expect(job.status).toBe("running");
    expect([...w.bucket.objects.keys()].filter((k) => k.includes("/voice/"))).toEqual([]);
  });
});
