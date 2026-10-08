import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StudioStyle } from "@harness/contracts";
import type { AgGoFootageVideo } from "@harness/core";
import {
  approveChatScope, createStudioEngineCore, GATE_SOURCES, MemoryBucket, planRunView, readStageDocument, StudioDb, submitStudioGate,
  type FootageCatalogSource, type StudioEngineCore, type ThumbnailRenderer,
} from "../src/index.js";

export const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
export const FAKE_CLAUDE = join(ROOT, "fixtures", "fake-studio-claude.mjs");

/** A minimal fake MP4 buffer for farm render results. */
export function fakeMp4(id: string | number): Buffer { return Buffer.from(`fake-mp4-${id}`); }

/** Minimal fake JPEG for thumbnail results. */
export function fakeJpeg(id: string | number): Buffer { return Buffer.from(`\xff\xd8fake-thumb-${id}`); }

/**
 * ag-go footage catalog stand-in — returns whole-asset items (GĐ2).
 * count assets, each duration_s seconds long, all usable, landscape.
 */
export function fakeFootage(count = 8, duration_s = 30): FootageCatalogSource & { calls: { actAs: string; folderIds: string[] }[] } {
  const calls: { actAs: string; folderIds: string[] }[] = [];
  const items: AgGoFootageVideo[] = Array.from({ length: count }, (_, i) => ({
    assetId: `asset-${String(i + 1).padStart(4, "0")}`,
    name: `Cảnh phở số ${i + 1}`,
    durationMs: duration_s * 1000,
    orientation: "landscape",
    hasSpeech: false,
    titleVi: `Video phở ${i + 1}`,
    summaryVi: `Cảnh quay phở buổi sáng số ${i + 1}`,
    genre: "food",
    topics: ["food"],
    subjects: ["pho"],
    places: ["Hanoi"],
    actions: ["eating"],
    keywordsVi: ["phở", "Hà Nội"],
    tags: ["pho", "food"],
    mood: "calm",
    setting: "interior",
    quality: 4,
    usable: true,
    approved: true,
  }));
  return {
    calls,
    async getCatalog(actAs, body) {
      calls.push({ actAs, folderIds: body.folderIds });
      return { items, nextCursor: null };
    },
  };
}

/**
 * ag-farm owner API stand-in for GĐ2 (no TTS; renders episodes).
 * Runs a studio.render_final job synchronously: writes output MP4 + thumbnails + render.json.
 */
/**
 * ag-farm owner API stand-in for GĐ2.  Runs studio.render_final synchronously:
 * writes output files into the bucket at the path the FarmExecutor's storage adapter
 * will call `downloadOutput` on: `productions/<productionId>/jobs/<stageKey>/<attemptId>/out/`.
 *
 * correlation_id = attempt_id; stage key for the only farm stage is "render-final".
 */
export function fakeFarm(bucket: MemoryBucket) {
  const jobs = new Map<string, { id: string; type: string; payload: Record<string, unknown>; requirements: Record<string, unknown>; status: string; result: unknown; error: unknown }>();
  let n = 0;
  return {
    jobs,
    async submitJob(req: { type: string; payload: unknown; correlation_id: string; requirements?: Record<string, unknown> }) {
      const id = `job-${++n}`;
      const p = req.payload as Record<string, unknown>;
      const prod = String(p.production_id ?? "");
      const attemptId = String(req.correlation_id ?? id);
      // FarmExecutor resolves output prefix as: productions/<productionId>/jobs/<stageKey>/<attemptId>/out/
      const stageKey = req.type === "studio.tts" ? "tts" : req.type === "studio.transcribe" ? "transcribe" : "render-final";
      const out = `productions/${prod}/jobs/${stageKey}/${attemptId}/out/`;
      // Shot-cut episodes (phase 5): narration read and footage listened to, as the render worker answers them
      if (req.type === "studio.tts") {
        const lines = (p.lines as { line_id: string; text: string }[]).map((l) => {
          const words = l.text.split(/\s+/).filter(Boolean);
          const duration = Math.round((l.text.length / 14 + 0.4) * 1000) / 1000;
          bucket.objects.set(`${out}tts/${l.line_id}.wav`, Buffer.from(`RIFF-${l.line_id}`));
          return { line_id: l.line_id, output: `tts/${l.line_id}.wav`, duration_s: duration,
            words: words.map((w, i) => ({ word: w, start: Math.round((i * duration / words.length) * 1000) / 1000, end: Math.round(((i + 1) * duration / words.length) * 1000) / 1000 })) };
        });
        bucket.objects.set(`${out}tts.json`, Buffer.from(JSON.stringify({ schema: "ag.studio.tts/v1", production_id: prod, language: p.language, lines, engine: { name: "fake", version: null } })));
        jobs.set(id, { id, type: req.type, payload: p, requirements: req.requirements ?? {}, status: "completed", result: { manifest: "tts.json" }, error: null });
        return { job: { id }, created: true };
      }
      if (req.type === "studio.transcribe") {
        const sources = (p.sources as { source_id: string }[]).map((s) => ({ source_id: s.source_id, language: "vi", alignment: "word", segments: [] }));
        bucket.objects.set(`${out}transcribe.json`, Buffer.from(JSON.stringify({ schema: "ag.studio.transcribe/v1", production_id: prod, engine: { name: "fake", version: null }, sources })));
        jobs.set(id, { id, type: req.type, payload: p, requirements: req.requirements ?? {}, status: "completed", result: { manifest: "transcribe.json" }, error: null });
        return { job: { id }, created: true };
      }

      const durationS = 60;
      const outputFile = String(p.output ?? "final.mp4");
      const thumbBase = outputFile.replace(/\.mp4$/, "");
      bucket.objects.set(`${out}${outputFile}`, fakeMp4(id));
      // Thumbnails — written at paths matching the rename-map keys in payloads.ts:
      // `${output.replace(/\.mp4$/, ".thumb-N.jpg")}` so the FarmExecutor can
      // download them before renaming to thumb-1.jpg … thumb-3.jpg.
      const thumbsPayload = (p.thumbnails ?? []) as { t_s: number; text: string }[];
      for (let t = 1; t <= 3; t++) { bucket.objects.set(`${out}${thumbBase}.thumb-${t}.jpg`, fakeJpeg(t)); }
      const canvas = (p.canvas ?? { width: 1920, height: 1080 }) as { width: number; height: number };
      // Read the composition.json that the FarmExecutor uploaded to the input prefix.
      // It has `total_seconds` which the studio-render-valid checker compares to m.duration_s.
      const inputPrefix = `productions/${prod}/jobs/${stageKey}/${attemptId}/in/`;
      let effectiveDuration = durationS;
      const compBuf = bucket.objects.get(`${inputPrefix}composition.json`);
      if (compBuf) {
        try {
          const comp = JSON.parse(compBuf.toString("utf8")) as { total_seconds?: number };
          if (typeof comp.total_seconds === "number") effectiveDuration = comp.total_seconds;
        } catch { /* fall back to durationS */ }
      }
      bucket.objects.set(`${out}render.json`, Buffer.from(JSON.stringify({
        schema: "ag.studio.render/v1", production_id: prod,
        revision: p.revision ?? 1, output: outputFile, width: canvas.width, height: canvas.height,
        duration_s: effectiveDuration, size_bytes: fakeMp4(id).length, watermarked: false, sources: [], warnings: [],
        thumbnails: thumbsPayload.map((th, i) => ({ output: `${thumbBase}.thumb-${i + 1}.jpg`, t_s: th.t_s, width: canvas.width, height: canvas.height })),
      })));
      jobs.set(id, { id, type: req.type, payload: p, requirements: req.requirements ?? {}, status: "completed", result: { manifest: "render.json" }, error: null });
      return { job: { id }, created: true };
    },
    async getJob(id: string) { const j = jobs.get(id)!; return { ...j, progress_percent: 100 }; },
    async ackJob() { return {}; },
    async cancelJob() { return {}; },
  };
}

export function world() {
  const dir = mkdtempSync(join(tmpdir(), "studio-engine-"));
  const dbPath = join(dir, "studio.db");
  const core = createStudioEngineCore({ dbPath, dataRoot: join(dir, "data"), harnessRoot: ROOT });
  const db = new StudioDb(dbPath);
  const bucket = new MemoryBucket();
  return { dir, dbPath, core, db, bucket };
}

export function seedProduction(db: StudioDb, over: {
  title?: string; target?: number; aspect?: string;
  episode_target_seconds?: number; max_episodes?: number;
  /** A second production in the same db needs its own id. */
  id?: string;
} = {}): string {
  const now = new Date().toISOString();
  db.run("INSERT OR IGNORE INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [now, now]);
  db.run("INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', 'auth0|owner', 'owner', ?)", [now]);
  const id = over.id ?? "11111111-1111-4111-8111-111111111111";
  db.run(`INSERT INTO productions (id, team_id, title, status, brief, created_at, updated_at, owner_user_id, target_seconds, aspect, language,
            goal, audience, tone, episode_target_seconds, max_episodes)
          VALUES (?, 'team-1', ?, 'draft', 'Một bát phở buổi sáng', ?, ?, 'auth0|owner', ?, ?, 'vi',
            'Chia sẻ ẩm thực Việt', 'Người Việt trẻ 18-35', 'warm', ?, ?)`,
    [id, over.title ?? "Phở sáng Hà Nội", now, now, over.target ?? 30, over.aspect ?? "16:9",
      over.episode_target_seconds ?? 60, over.max_episodes ?? 2]);
  db.run("INSERT INTO production_sources (production_id, source_id, added_at) VALUES (?, 'folder-a', ?)", [id, now]);
  return id;
}

/** Thumbnail pictures without ffmpeg: a frame is a small fake JPEG naming its moment, words are appended to it. */
export function fakeThumbnails(): ThumbnailRenderer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async extractFrame(_video, t_s, out) { calls.push(`frame ${t_s}`); writeFileSync(out, fakeJpeg(`frame-${t_s}`)); },
    async compose(base, out, p) { calls.push(`compose ${p.lines.join("|")}`); writeFileSync(out, Buffer.concat([readFileSync(base), Buffer.from(` ${p.lines.join("|")}`)])); },
    async normalize(input, out) { calls.push("normalize"); copyFileSync(input, out); },
  };
}

/** The files of a zip whose entries are stored (not deflated), by name, read through its central directory. */
export function readStoredZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const skip = nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    files.set(name, zip.subarray(data, data + size));
    at += 46 + skip;
  }
  return files;
}

/**
 * Approves, as Claude proposed them, the plan gates a test does not look at, in the order the run asks, until `until`
 * waits (then returns, leaving it waiting) or the plan waits for nothing more (`until` null). The plan's gates change
 * between releases (3.2.0 added approve-style beside the trend report), so a test names only the gate it is about.
 * Returns the gates approved, in order.
 */
export async function approvePlanGatesUntil(
  s: { core: StudioEngineCore; db: StudioDb }, productionId: string, drain: () => Promise<void>, until: string | null,
): Promise<string[]> {
  const approved: string[] = [];
  for (let i = 0; i < 12; i++) {
    await drain();
    const view = planRunView(s.core, s.db, productionId);
    const gate = view.waiting_gate;
    if (!gate || gate === until) {
      if (until && gate !== until) throw new Error(`the plan never waited at ${until} (approved ${approved.join(", ")})`);
      return approved;
    }
    const src = GATE_SOURCES[gate];
    if (!src) throw new Error(`no document source for gate ${gate}`);
    await submitStudioGate(s.core, s.db, view.run_id, gate, readStageDocument(s.core, view.run_id, src.stage, src.file));
    approved.push(gate);
  }
  throw new Error(`the plan kept asking (approved ${approved.join(", ")})`);
}

/**
 * The same with a worker running on its own (integration tests): waits for each gate the plan asks for, approves it
 * as shown (`approveChatScope`, no turn), and returns once `until` waits — or, with `until` null, once approve-plan
 * is approved. Two gates may wait at once (the style beside the trend report); the plan shows the earlier stage's.
 */
export async function approvePlanGatesLive(
  s: { core: StudioEngineCore; db: StudioDb }, productionId: string, userId: string, until: string | null, ms = 60_000,
): Promise<string[]> {
  const approved: string[] = [];
  while (approved.at(-1) !== "approve-plan") {
    const since = Date.now();
    let gate: string | null = null;
    while (!gate) {
      try {
        const g = planRunView(s.core, s.db, productionId).waiting_gate;
        if (g && !approved.includes(g)) gate = g;
      } catch { /* no plan run yet */ }
      if (gate) break;
      if (Date.now() - since > ms) throw new Error(`no plan gate within ${ms} ms (approved ${approved.join(", ") || "none"})`);
      await new Promise((r) => setTimeout(r, 100));
    }
    if (gate === until) return approved;
    await approveChatScope(s.core, s.db, { productionId, stageKey: gate, turnId: null, userId });
    approved.push(gate);
  }
  if (until) throw new Error(`the plan never waited at ${until} (approved ${approved.join(", ")})`);
  return approved;
}

/** An approved edit style (series plan 3.2.0): slow cuts, 5–8 s shots. */
export const STYLE: StudioStyle = {
  schema_version: "studio.style/v1", skipped: false, skipped_reason: null, name: "Chậm", summary: "Cảnh dài, ít chữ.",
  references: [{ video_id: "U_17EqTHUIo", title: "Kyoto", channel_title: "Mei Time", url: "https://www.youtube.com/watch?v=U_17EqTHUIo", duration_s: 1299 }],
  measured: { videos: 1, shots: 200, cuts_per_minute: 9, shot_seconds: { p25: 5, median: 6.5, p75: 8 }, first_shot_s: 2 },
  params: { cut_rhythm: "slow", shot_seconds: { min: 5, max: 8 }, transitions: ["cut"], opening: { seconds: 16, structure: "montage" },
    text_overlay: { density: "low", style: "serif nhỏ" }, subtitles: "none", voice: "unknown", music: { mood: "calm", ducking: null }, visual: "", pace_notes: "" },
  do: ["Mở bằng montage"], dont: [], evidence: [{ param: "opening", video_id: "U_17EqTHUIo", t: 2.5, note: "a" }],
};
