import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgGoCatalogItem } from "@harness/core";
import { createStudioEngineCore, MemoryBucket, StudioDb, type FootageCatalogSource } from "../src/index.js";

export const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
export const FAKE_CLAUDE = join(ROOT, "fixtures", "fake-studio-claude.mjs");

/** A minimal valid 16-bit mono PCM WAV of `seconds` of silence. */
export function wav(seconds: number, rate = 24000): Buffer {
  const n = Math.floor(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

/** ag-go `/footage/catalog` stand-in; records who it was called as. */
export function fakeFootage(count = 16, seconds = 8): FootageCatalogSource & { calls: { actAs: string; folderIds: string[] }[] } {
  const calls: { actAs: string; folderIds: string[] }[] = [];
  const items: AgGoCatalogItem[] = Array.from({ length: count }, (_, i) => ({
    segmentId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, assetId: `asset-${Math.floor(i / 4)}`,
    startMs: (i % 4) * seconds * 1000, endMs: ((i % 4) + 1) * seconds * 1000, durationMs: seconds * 1000,
    captionVi: `cảnh phở số ${i + 1}`, captionEn: `pho shot ${i + 1}`, tags: ["pho"], keywordsVi: ["phở"], subjects: [], actions: [],
    shotSize: "medium", cameraMotion: null, timeOfDay: "morning", setting: null, peopleCount: null,
    orientation: "landscape", quality: 4, usable: true, approved: i % 2 === 0,
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
 * ag-farm owner API stand-in that runs a job the moment it is submitted: TTS writes one WAV per line
 * (0.2 s per word) + `tts.json`; a render writes `output` + `render.json` with the composition's length.
 */
export function fakeFarm(bucket: MemoryBucket) {
  const jobs = new Map<string, { id: string; type: string; payload: Record<string, unknown>; status: string; result: unknown; error: unknown }>();
  let n = 0;
  return {
    jobs,
    async submitJob(req: { type: string; payload: unknown; correlation_id: string }) {
      const id = `job-${++n}`;
      const p = req.payload as Record<string, unknown>;
      const prod = String(p.production_id);
      const editor = String(req.correlation_id).startsWith("editor-");
      const attempt = String(req.correlation_id).replace(/^editor-/, "");
      const stage = req.type === "studio.tts" ? (editor ? "editor-tts" : "tts") : editor ? "editor-preview" : "render-final";
      const out = `productions/${prod}/jobs/${stage}/${attempt}/out/`;
      let manifest: string;
      if (req.type === "studio.tts") {
        const lines = (p.lines as { line_id: string; text: string }[]).map((l) => {
          const duration = Math.round(l.text.split(/\s+/).length * 0.2 * 1000) / 1000;
          bucket.objects.set(`${out}tts/${l.line_id}.wav`, wav(duration));
          return { line_id: l.line_id, output: `tts/${l.line_id}.wav`, duration_s: duration, words: [] };
        });
        bucket.objects.set(`${out}tts.json`, Buffer.from(JSON.stringify({ schema: "ag.studio.tts/v1", production_id: prod, language: String(p.language), lines, engine: { name: "fake", version: null } })));
        manifest = "tts.json";
      } else {
        const comp = JSON.parse(bucket.objects.get(`productions/${prod}/jobs/${stage}/${attempt}/in/composition.json`)!.toString("utf8"));
        const video = Buffer.from(`fake-mp4-${id}`);
        bucket.objects.set(`${out}${String(p.output)}`, video);
        const canvas = p.canvas as { width: number; height: number };
        bucket.objects.set(`${out}render.json`, Buffer.from(JSON.stringify({
          schema: "ag.studio.render/v1", production_id: prod, revision: p.revision, output: p.output, width: canvas.width, height: canvas.height,
          duration_s: comp.total_seconds, size_bytes: video.length, watermarked: req.type !== "studio.render_final", sources: [], warnings: [],
        })));
        manifest = "render.json";
      }
      jobs.set(id, { id, type: req.type, payload: p, status: "completed", result: { manifest }, error: null });
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

export function seedProduction(db: StudioDb, over: { target?: number; aspect?: string } = {}): string {
  const now = new Date().toISOString();
  db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [now, now]);
  db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', 'auth0|owner', 'owner', ?)", [now]);
  const id = "11111111-1111-4111-8111-111111111111";
  db.run(`INSERT INTO productions (id, team_id, title, status, brief, created_at, updated_at, owner_user_id, target_seconds, aspect, language)
          VALUES (?, 'team-1', 'Phở sáng Hà Nội', 'draft', 'Một bát phở buổi sáng', ?, ?, 'auth0|owner', ?, ?, 'vi')`, [id, now, now, over.target ?? 30, over.aspect ?? "16:9"]);
  db.run("INSERT INTO production_sources (production_id, source_id, added_at) VALUES (?, 'folder-a', ?)", [id, now]);
  return id;
}
