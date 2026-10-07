/**
 * A machine voice without a sample (plan optional-audio, phase C): the person describes the voice (gender, age,
 * pitch); the farm reads one sample sentence in a voice OmniVoice designs from that description (`studio.tts` with
 * `voice.instruct`, no reference); the WAV becomes the production's voice sample, `origin: synthetic`, with the
 * sentence as its `reference_text`. Every episode then clones that one sample, so the series keeps one voice —
 * designing each line would give each line its own speaker.
 *
 * While the farm reads, `productions.voice` is `designing` (episodes wait as for a missing voice). The screen that
 * shows the production's audio asks `pollVoiceDesign`, which turns a finished job into the sample.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionVoiceSchema, type ProductionVoice } from "@harness/contracts";
import { jobOutputPrefix } from "@harness/executors";
import { StudioTtsPayloadSchema, TTS_MANIFEST_PATH, TtsManifestSchema } from "@ag-farm/protocol";
import type { FarmOwnerClient } from "@ag-farm/owner-client";
import { importProductionAudio, type AudioImportDeps } from "./audio-import.js";
import { StudioRunError } from "./run-control.js";
import { getProduction, type StudioDb } from "./studio-db.js";

/** What a person may say about the voice: OmniVoice's own instruct items (English), one of each. */
export const VOICE_DESIGN_OPTIONS = {
  gender: ["female", "male"],
  age: ["young adult", "middle-aged", "elderly"],
  pitch: ["low pitch", "moderate pitch", "high pitch"],
} as const;
export interface VoiceDesign {
  gender: (typeof VOICE_DESIGN_OPTIONS.gender)[number];
  age: (typeof VOICE_DESIGN_OPTIONS.age)[number];
  pitch: (typeof VOICE_DESIGN_OPTIONS.pitch)[number];
}

export function designInstruct(d: VoiceDesign): string {
  for (const k of ["gender", "age", "pitch"] as const) {
    if (!(VOICE_DESIGN_OPTIONS[k] as readonly string[]).includes(d[k])) {
      throw new StudioRunError("invalid", `giọng máy: ${k} không hợp lệ`, { code: "voice_design_invalid", field: k });
    }
  }
  return `${d.gender}, ${d.age}, ${d.pitch}`;
}

/** The sentence the sample reads: long enough for a voice sample (3–20 s), in the production's language. */
const SAMPLE_TEXT: Record<string, string> = {
  vi: "Xin chào. Đây là giọng đọc lời dẫn cho series của bạn. Mình sẽ kể từng câu chuyện thật chậm rãi, rõ ràng và gần gũi.",
  en: "Hello. This is the narration voice for your series. I will tell each story slowly, clearly and warmly.",
};
export function voiceDesignText(language: string): string {
  return SAMPLE_TEXT[language.slice(0, 2)] ?? SAMPLE_TEXT.en!;
}

/** Stage key of the farm job (its bucket prefix and `/farm/sign` scope). */
export const VOICE_DESIGN_STAGE = "voice-design";
export type VoiceDesignFarm = Pick<FarmOwnerClient, "submitJob" | "getJob" | "ackJob">;

function readDesigning(db: StudioDb, productionId: string) {
  const raw = getProduction(db, productionId)?.voice;
  if (!raw) return null;
  const v = ProductionVoiceSchema.parse(JSON.parse(raw));
  return "mode" in v && v.mode === "designing" ? v : null;
}

function saveVoice(db: StudioDb, productionId: string, v: ProductionVoice): void {
  db.run("UPDATE productions SET voice = ?, updated_at = ? WHERE id = ?", [JSON.stringify(ProductionVoiceSchema.parse(v)), new Date().toISOString(), productionId]);
}

/** Sends the farm job reading the sample; the production's voice is `designing` from now (with `error` if not sent). */
export async function startVoiceDesign(
  d: { db: StudioDb; farm: VoiceDesignFarm }, o: { productionId: string; design: VoiceDesign; userId: string },
): Promise<ProductionVoice> {
  const p = getProduction(d.db, o.productionId);
  if (!p) throw new StudioRunError("not_found", `production ${o.productionId} not found`);
  const instruct = designInstruct(o.design);
  const language = p.language ?? "vi";
  const text = voiceDesignText(language);
  const attempt = randomUUID();
  const payload = StudioTtsPayloadSchema.parse({
    production_id: o.productionId, language, voice: { reference: null, reference_text: null, speed: 1, instruct },
    lines: [{ line_id: "L001", text, pause_seconds: null }], align_words: false,
  });
  let farmJobId: string | null = null;
  let error: string | null = null;
  try {
    const { job } = await d.farm.submitJob({
      type: "studio.tts", correlation_id: `voice-design-${attempt}`, affinity_key: o.productionId, max_attempts: 2, payload,
    });
    farmJobId = job.id;
    // the worker puts the sample under this job's prefix through /farm/sign, which looks the job up here
    d.db.run(
      "INSERT INTO studio_farm_jobs (id, farm_job_id, run_id, stage_key, attempt_id, production_id, episode_id, job_type, is_final_render, requirements, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 'studio.tts', 0, '{}', ?)",
      [randomUUID(), job.id, VOICE_DESIGN_STAGE, VOICE_DESIGN_STAGE, attempt, o.productionId, new Date().toISOString()],
    );
  } catch (e) {
    error = `không gửi được việc tạo giọng lên farm: ${e instanceof Error ? e.message : String(e)}`;
  }
  const voice: ProductionVoice = {
    mode: "designing", instruct, text, farm_job_id: farmJobId, requested_by: o.userId, requested_at: new Date().toISOString(), error,
  };
  saveVoice(d.db, o.productionId, voice);
  return voice;
}

/** Productions whose finished sample is being turned into their voice right now (two polls must not both import). */
const importing = new Set<string>();

/**
 * Looks at the farm job of a voice being designed: finished, its sample becomes the production's voice (`done`);
 * failed, the voice keeps `designing` with the reason (`failed`); otherwise nothing changes.
 */
export async function pollVoiceDesign(
  d: AudioImportDeps & { farm: VoiceDesignFarm }, productionId: string,
): Promise<"done" | "failed" | "waiting" | "none"> {
  const v = readDesigning(d.db, productionId);
  if (!v || !v.farm_job_id || v.error) return "none";
  if (importing.has(productionId)) return "waiting";
  const job = await d.farm.getJob(v.farm_job_id);
  if (job.status === "failed" || job.status === "cancelled") {
    const reason = (job.error as { message?: string } | null)?.message ?? job.status;
    saveVoice(d.db, productionId, { ...v, error: `farm không tạo được giọng: ${reason}` });
    await d.farm.ackJob(v.farm_job_id).catch(() => undefined);
    return "failed";
  }
  if (job.status !== "completed") return "waiting";
  importing.add(productionId);
  const work = mkdtempSync(join(tmpdir(), "voice-design-"));
  try {
    const row = d.db.get<{ attempt_id: string }>("SELECT attempt_id FROM studio_farm_jobs WHERE farm_job_id = ?", [v.farm_job_id]);
    if (!row) throw new Error(`farm job ${v.farm_job_id} is not recorded`);
    const out = jobOutputPrefix(productionId, VOICE_DESIGN_STAGE, row.attempt_id);
    const manifest = TtsManifestSchema.parse(JSON.parse((await d.bucket.get(`${out}${TTS_MANIFEST_PATH}`)).toString("utf8")));
    const line = manifest.lines[0];
    if (!line) throw new Error("the farm read no line");
    const file = join(work, "sample.wav");
    writeFileSync(file, await d.bucket.get(`${out}${line.output}`));
    await importProductionAudio(d, {
      productionId, kind: "voice", file, source: { kind: "design", instruct: v.instruct }, userId: v.requested_by,
      origin: "synthetic", referenceText: v.text,
    });
    await d.farm.ackJob(v.farm_job_id).catch(() => undefined);
    return "done";
  } catch (e) {
    saveVoice(d.db, productionId, { ...v, error: `không dùng được giọng farm tạo: ${e instanceof Error ? e.message : String(e)}` });
    return "failed";
  } finally {
    importing.delete(productionId);
    rmSync(work, { recursive: true, force: true });
  }
}
