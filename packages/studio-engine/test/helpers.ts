import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgGoFootageVideo } from "@harness/core";
import { createStudioEngineCore, MemoryBucket, StudioDb, type FootageCatalogSource } from "../src/index.js";

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
  const jobs = new Map<string, { id: string; type: string; payload: Record<string, unknown>; status: string; result: unknown; error: unknown }>();
  let n = 0;
  return {
    jobs,
    async submitJob(req: { type: string; payload: unknown; correlation_id: string }) {
      const id = `job-${++n}`;
      const p = req.payload as Record<string, unknown>;
      const prod = String(p.production_id ?? "");
      const attemptId = String(req.correlation_id ?? id);
      // FarmExecutor resolves output prefix as: productions/<productionId>/jobs/<stageKey>/<attemptId>/out/
      const stageKey = "render-final";
      const out = `productions/${prod}/jobs/${stageKey}/${attemptId}/out/`;

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
      jobs.set(id, { id, type: req.type, payload: p, status: "completed", result: { manifest: "render.json" }, error: null });
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
} = {}): string {
  const now = new Date().toISOString();
  db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [now, now]);
  db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', 'auth0|owner', 'owner', ?)", [now]);
  const id = "11111111-1111-4111-8111-111111111111";
  db.run(`INSERT INTO productions (id, team_id, title, status, brief, created_at, updated_at, owner_user_id, target_seconds, aspect, language,
            goal, audience, tone, episode_target_seconds, max_episodes)
          VALUES (?, 'team-1', ?, 'draft', 'Một bát phở buổi sáng', ?, ?, 'auth0|owner', ?, ?, 'vi',
            'Chia sẻ ẩm thực Việt', 'Người Việt trẻ 18-35', 'warm', ?, ?)`,
    [id, over.title ?? "Phở sáng Hà Nội", now, now, over.target ?? 30, over.aspect ?? "16:9",
      over.episode_target_seconds ?? 60, over.max_episodes ?? 2]);
  db.run("INSERT INTO production_sources (production_id, source_id, added_at) VALUES (?, 'folder-a', ?)", [id, now]);
  return id;
}
