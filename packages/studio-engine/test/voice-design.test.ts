/**
 * A machine voice without a sample: one sentence read on the farm in a designed voice becomes the production's
 * sample (origin synthetic, the sentence as its words); episodes wait for it like for a missing voice.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProductionVoiceSchema } from "@harness/contracts";
import { jobOutputPrefix } from "@harness/executors";
import {
  designInstruct, getProduction, MemoryBucket, pollVoiceDesign, productionAudio, productionVoice, startVoiceDesign, StudioRunError,
  VOICE_DESIGN_STAGE, voiceDesignText,
} from "../src/index.js";
import { seedProduction, world } from "./helpers.js";
import { hasFfmpeg, makeWav } from "../../../tests/media.js";

const TOOLS = { ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", ffprobe: process.env.FFPROBE_PATH ?? "ffprobe" };
const DESIGN = { gender: "female", age: "young adult", pitch: "moderate pitch" } as const;

function fakeFarm() {
  const submitted: { type: string; payload: Record<string, unknown>; correlation_id: string }[] = [];
  const jobs = new Map<string, { status: string; error: unknown }>();
  return {
    submitted, jobs,
    async submitJob(j: { type: string; payload: unknown; correlation_id: string }) {
      submitted.push(j as never);
      const id = `job-${submitted.length}`;
      jobs.set(id, { status: "queued", error: null });
      return { job: { id }, created: true };
    },
    async getJob(id: string) { return { id, ...jobs.get(id)! }; },
    async ackJob() { return {}; },
  };
}

describe("a machine voice designed on the farm", () => {
  it("sends one sentence to read in the voice described; the production waits for it", async () => {
    const w = world();
    const prod = seedProduction(w.db);
    const farm = fakeFarm();
    const v = await startVoiceDesign({ db: w.db, farm: farm as never }, { productionId: prod, design: DESIGN, userId: "auth0|owner" });
    expect(v).toMatchObject({ mode: "designing", instruct: "female, young adult, moderate pitch", farm_job_id: "job-1", error: null });
    expect(farm.submitted[0]).toMatchObject({
      type: "studio.tts",
      payload: { production_id: prod, language: "vi", voice: { reference: null, instruct: "female, young adult, moderate pitch" }, lines: [{ line_id: "L001", text: voiceDesignText("vi") }] },
    });
    expect(w.db.get("SELECT stage_key, job_type FROM studio_farm_jobs WHERE farm_job_id = 'job-1'")).toEqual({ stage_key: VOICE_DESIGN_STAGE, job_type: "studio.tts" });
    expect(productionVoice(getProduction(w.db, prod)!.voice, {}).kind).toBe("missing");
    expect(productionAudio(getProduction(w.db, prod)!).voice).toMatchObject({ mode: "designing", error: null });
    expect(await pollVoiceDesign({ db: w.db, bucket: new MemoryBucket(), farm: farm as never, ...TOOLS }, prod)).toBe("waiting");
    w.core.close();
  });

  it("a failed job leaves the reason, for another try", async () => {
    const w = world();
    const prod = seedProduction(w.db);
    const farm = fakeFarm();
    await startVoiceDesign({ db: w.db, farm: farm as never }, { productionId: prod, design: DESIGN, userId: "auth0|owner" });
    farm.jobs.set("job-1", { status: "failed", error: { message: "CUDA out of memory" } });
    expect(await pollVoiceDesign({ db: w.db, bucket: new MemoryBucket(), farm: farm as never, ...TOOLS }, prod)).toBe("failed");
    expect(productionAudio(getProduction(w.db, prod)!).voice).toMatchObject({ mode: "designing", error: "farm không tạo được giọng: CUDA out of memory" });
    w.core.close();
  });

  it("only OmniVoice's own words describe a voice", () => {
    expect(designInstruct(DESIGN)).toBe("female, young adult, moderate pitch");
    expect(() => designInstruct({ ...DESIGN, age: "teenage" as never })).toThrow(StudioRunError);
  });

  it.skipIf(!hasFfmpeg())("a finished job: its sample becomes the voice, synthetic, its sentence as its words (needs ffmpeg)", async () => {
    const w = world();
    const prod = seedProduction(w.db);
    const farm = fakeFarm();
    const bucket = new MemoryBucket();
    await startVoiceDesign({ db: w.db, farm: farm as never }, { productionId: prod, design: DESIGN, userId: "auth0|owner" });
    const attempt = w.db.get<{ attempt_id: string }>("SELECT attempt_id FROM studio_farm_jobs WHERE farm_job_id = 'job-1'")!.attempt_id;
    const out = jobOutputPrefix(prod, VOICE_DESIGN_STAGE, attempt);
    const wav = join(mkdtempSync(join(tmpdir(), "design-")), "L001.wav");
    makeWav(wav, 7);
    await bucket.put(`${out}tts/L001.wav`, readFileSync(wav));
    await bucket.put(`${out}tts.json`, Buffer.from(JSON.stringify({
      schema: "ag.studio.tts/v1", production_id: prod, language: "vi", engine: { name: "omnivoice", version: null },
      lines: [{ line_id: "L001", output: "tts/L001.wav", duration_s: 7, words: [] }],
    })));
    farm.jobs.set("job-1", { status: "completed", error: null });
    expect(await pollVoiceDesign({ db: w.db, bucket, farm: farm as never, ...TOOLS }, prod)).toBe("done");
    const voice = ProductionVoiceSchema.parse(JSON.parse(getProduction(w.db, prod)!.voice!));
    expect(voice).toMatchObject({ mode: "clone", origin: "synthetic", source: { kind: "design", instruct: "female, young adult, moderate pitch" }, reference_text: voiceDesignText("vi") });
    expect(productionVoice(getProduction(w.db, prod)!.voice, {}).kind).toBe("clone");
    expect(await pollVoiceDesign({ db: w.db, bucket, farm: farm as never, ...TOOLS }, prod)).toBe("none");
    w.core.close();
  });
});
