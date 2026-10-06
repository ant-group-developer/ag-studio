import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StudioTtsPayloadSchema, TtsManifestSchema } from "@ag-farm/protocol";
import { cutPayloadBuilders, getVoiceLine, putVoiceLine, voiceKey, voicePath, type CutMediaDeps } from "../src/index.js";
import { seedProduction, world } from "./helpers.js";
import { stageWorkspace } from "./stage-harness.js";

const VOICE = { reference: "library:voices/mai.wav", reference_text: "Xin chào, tôi là Mai.", speed: 1 };

function setup(narration: "tts" | "none" = "tts") {
  const { db, bucket } = world();
  const prod = seedProduction(db);
  db.run("UPDATE productions SET voice = ? WHERE id = ?", [JSON.stringify(VOICE), prod]);
  const voiceDir = mkdtempSync(join(tmpdir(), "voice-"));
  const media: CutMediaDeps = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", voiceDir, resolveAssets: async () => ({ items: [], missing: [] }), download: async () => {} };
  const plan = {
    schema_version: "studio.edit-plan/v1", episode_id: "ep-1", narration, language: "vi", target_seconds: 30,
    shots: [{ order: 1, shot_id: "s000-000", source_id: "src_0000000000000000000000000A", in: 0, out: 4, line_id: narration === "tts" ? "L001" : null, transition: "cut", section_title: null, note: "" }],
    lines: narration === "tts" ? [{ line_id: "L001", text: "Phố cổ Hoa Lư lúc chiều." }, { line_id: "L002", text: "Đền vua Đinh." }] : [],
    texts: [], music_mood: null,
  };
  const run = stageWorkspace({ runId: "r", stageKey: "tts", inputs: [
    { type: "studio_edit_plan", name: "edit-plan.json", json: plan },
    { type: "studio_brief", name: "brief.json", json: { production_id: prod, language: "vi" } },
  ] });
  return { db, bucket, media, prod, run, builder: cutPayloadBuilders({ db, bucket, media })["studio-cut-tts"]! };
}

describe("voice store", () => {
  it("keys a line by what is read and how, and keeps its WAV and timings", () => {
    const k = voiceKey({ text: "Đền vua Đinh.", language: "vi", voice: VOICE });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(voiceKey({ text: "Đền vua Đinh.", language: "vi", voice: VOICE })).toBe(k);
    expect(voiceKey({ text: "Đền vua Lê.", language: "vi", voice: VOICE })).not.toBe(k);
    expect(voiceKey({ text: "Đền vua Đinh.", language: "vi", voice: { ...VOICE, speed: 1.1 } })).not.toBe(k);

    const { db, media } = setup();
    const wav = join(mkdtempSync(join(tmpdir(), "w-")), "L.wav");
    writeFileSync(wav, "RIFF");
    expect(getVoiceLine(db, media.voiceDir, k)).toBeNull();
    putVoiceLine(db, media.voiceDir, k, wav, { duration_s: 1.5, words: [{ word: "Đền", start: 0, end: 0.4 }], language: "vi" }, "2026-10-06T10:00:00.000Z");
    expect(getVoiceLine(db, media.voiceDir, k)).toMatchObject({ key: k, duration_s: 1.5, words: [{ word: "Đền", start: 0, end: 0.4 }], path: voicePath(media.voiceDir, k) });
  });
});

describe("studio-cut-tts", () => {
  it("sends every line not read yet, in the production's voice, with word timings", async () => {
    const { builder, run, prod } = setup();
    const build = await builder(run.request, run.ctx);
    expect(build.skip).toBeUndefined();
    const payload = StudioTtsPayloadSchema.parse(build.payload);
    expect(payload).toMatchObject({ production_id: prod, language: "vi", voice: VOICE, align_words: true });
    expect(payload.lines.map((l) => [l.line_id, l.text])).toEqual([["L001", "Phố cổ Hoa Lư lúc chiều."], ["L002", "Đền vua Đinh."]]);
  });

  it("a line already in the voice store is not read again; none left: skip", async () => {
    const { builder, run, db, media } = setup();
    const wav = join(mkdtempSync(join(tmpdir(), "w-")), "L.wav");
    writeFileSync(wav, "RIFF");
    putVoiceLine(db, media.voiceDir, voiceKey({ text: "Đền vua Đinh.", language: "vi", voice: VOICE }), wav, { duration_s: 1.5, words: [], language: "vi" }, "2026-10-06T10:00:00.000Z");
    expect(StudioTtsPayloadSchema.parse((await builder(run.request, run.ctx)).payload).lines.map((l) => l.line_id)).toEqual(["L001"]);

    putVoiceLine(db, media.voiceDir, voiceKey({ text: "Phố cổ Hoa Lư lúc chiều.", language: "vi", voice: VOICE }), wav, { duration_s: 2, words: [], language: "vi" }, "2026-10-06T10:00:00.000Z");
    const all = await builder(run.request, run.ctx);
    expect(all.skip).toBeDefined();
    expect(TtsManifestSchema.parse(JSON.parse(String(all.skip!.files["tts.json"]))).lines).toEqual([]);
  });

  it("an episode without narration skips", async () => {
    const { builder, run } = setup("none");
    expect((await builder(run.request, run.ctx)).skip).toBeDefined();
  });

  it("a production without a voice to clone is a contract error", async () => {
    const { builder, run, db, prod } = setup();
    db.run("UPDATE productions SET voice = ? WHERE id = ?", [JSON.stringify({ reference: null, reference_text: null, speed: 1 }), prod]);
    await expect(builder(run.request, run.ctx)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
