/**
 * Web editor M1 server side (plan 4.2): autosaved revisions with optimistic concurrency, re-TTS of a single
 * line, and "Render preview" -- the last two are ag-farm jobs the editor starts outside the workflow.
 *
 * ag-farm never calls Studio back: the API polls (`pollEditorJob`) when the web asks for a job's status.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TimelineV2Schema, type TimelineV2 } from "@harness/contracts";
import { timelineIssues, type TimelineIssue } from "@harness/core";
import { jobOutputPrefix, stageInputPrefix } from "@harness/executors";
import { RenderManifestSchema, TtsManifestSchema, type StudioTtsPayload } from "@ag-farm/protocol";
import type { FarmOwnerClient } from "@ag-farm/owner-client";
import { productionKey, type StudioBucket } from "./bucket.js";
import { prepareRender, ttsPayload } from "./payloads.js";
import { StudioRunError } from "./run-control.js";
import { getProduction, getRevision, saveRevision, type StudioDb } from "./studio-db.js";
import { productionVoice } from "./voice.js";

/** The part of `FarmOwnerClient` the editor uses. */
export type EditorFarmClient = Pick<FarmOwnerClient, "submitJob" | "getJob" | "ackJob">;
export interface EditorDeps { db: StudioDb; bucket: StudioBucket; farm: EditorFarmClient }

export function saveTimeline(db: StudioDb, productionId: string, p: { baseRevision: number; data: unknown; authorId: string; label?: string }): { revision: number; issues: TimelineIssue[] } {
  if (!getProduction(db, productionId)) throw new StudioRunError("not_found", `production ${productionId} not found`);
  const parsed = TimelineV2Schema.safeParse(p.data);
  if (!parsed.success) throw new StudioRunError("invalid", "timeline không hợp lệ", { problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  const saved = saveRevision(db, productionId, { baseRevision: p.baseRevision, data: parsed.data, authorId: p.authorId, label: p.label ?? "autosave" });
  return { revision: saved.revision, issues: timelineIssues(parsed.data) };
}

export interface EditorJobView {
  id: string; kind: "tts_line" | "render_preview"; status: "queued" | "running" | "completed" | "failed";
  request: Record<string, unknown>; result: Record<string, unknown> | null; error: string | null; created_at: string;
}
interface EditorJobRow { id: string; production_id: string; kind: EditorJobView["kind"]; farm_job_id: string | null; status: EditorJobView["status"]; request: string; result: string | null; error: string | null; created_by: string; created_at: string; updated_at: string }

const view = (r: EditorJobRow): EditorJobView => ({
  id: r.id, kind: r.kind, status: r.status, request: JSON.parse(r.request), result: r.result ? JSON.parse(r.result) : null, error: r.error, created_at: r.created_at,
});

/** Record the job in `studio_farm_jobs` so Studio's `/farm/sign` accepts the worker's ticket for it. */
function recordFarmJob(db: StudioDb, p: { farmJobId: string; runId: string; stageKey: string; attemptId: string; productionId: string; jobType: string }): void {
  db.run(
    "INSERT INTO studio_farm_jobs (id, farm_job_id, run_id, stage_key, attempt_id, production_id, job_type, is_final_render, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
    [randomUUID(), p.farmJobId, p.runId, p.stageKey, p.attemptId, p.productionId, p.jobType, new Date().toISOString()],
  );
}

function insertJob(db: StudioDb, p: { id: string; productionId: string; kind: EditorJobView["kind"]; request: unknown; userId: string }): void {
  const now = new Date().toISOString();
  db.run("INSERT INTO studio_editor_jobs (id, production_id, kind, status, request, created_by, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)",
    [p.id, p.productionId, p.kind, JSON.stringify(p.request), p.userId, now, now]);
}
function updateJob(db: StudioDb, id: string, patch: Partial<Pick<EditorJobRow, "farm_job_id" | "status" | "result" | "error">>): void {
  const sets = Object.keys(patch).map((k) => `${k} = ?`);
  db.run(`UPDATE studio_editor_jobs SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`,
    [...Object.values(patch).map((v) => (v === undefined ? null : v)), new Date().toISOString(), id] as (string | null)[]);
}

/** Edit one sentence -> synthesize only that sentence (plan 4.2 M1). */
export async function startLineTts(d: EditorDeps, p: { productionId: string; lineId: string; text: string; userId: string }): Promise<EditorJobView> {
  const prod = getProduction(d.db, p.productionId);
  if (!prod) throw new StudioRunError("not_found", `production ${p.productionId} not found`);
  const text = p.text.trim();
  if (!/^L\d{3}$/.test(p.lineId) || !text) throw new StudioRunError("invalid", "line_id dạng L001 và text không rỗng");
  const id = randomUUID();
  insertJob(d.db, { id, productionId: prod.id, kind: "tts_line", request: { line_id: p.lineId, text }, userId: p.userId });
  const voice = productionVoice(prod.voice);
  try {
    const { job } = await d.farm.submitJob({
      type: "studio.tts", correlation_id: `editor-${id}`, affinity_key: prod.id, max_attempts: 1,
      payload: ttsPayload({ productionId: prod.id, language: prod.language ?? "vi", voice, lines: [{ line_id: p.lineId, text }] }),
    });
    recordFarmJob(d.db, { farmJobId: job.id, runId: prod.run_id ?? "editor", stageKey: "editor-tts", attemptId: id, productionId: prod.id, jobType: "studio.tts" });
    updateJob(d.db, id, { farm_job_id: job.id, status: "running" });
  } catch (e) {
    updateJob(d.db, id, { status: "failed", error: `gửi job TTS thất bại: ${e instanceof Error ? e.message : String(e)}` });
  }
  return getEditorJob(d.db, prod.id, id);
}

/** Errors a render cannot survive; an unvoiced or overflowing line still previews. */
const RENDER_BLOCKERS = new Set(["unknown_segment", "duplicate_segment", "empty_clip", "clip_out_of_range", "beat_empty", "unknown_beat", "duplicate_id"]);

export async function startPreview(d: EditorDeps, p: { productionId: string; revision: number; userId: string }): Promise<EditorJobView> {
  const prod = getProduction(d.db, p.productionId);
  if (!prod) throw new StudioRunError("not_found", `production ${p.productionId} not found`);
  const rev = getRevision(d.db, prod.id, p.revision);
  if (!rev) throw new StudioRunError("not_found", `revision ${p.revision} not found`);
  const blocking = timelineIssues(rev.data).filter((i) => i.severity === "error" && RENDER_BLOCKERS.has(i.code));
  if (blocking.length) throw new StudioRunError("invalid", "timeline chưa render được", { problems: blocking });
  const id = randomUUID();
  const output = `previews/${id}.mp4`;
  insertJob(d.db, { id, productionId: prod.id, kind: "render_preview", request: { revision: p.revision }, userId: p.userId });
  const work = mkdtempSync(join(tmpdir(), "studio-preview-"));
  try {
    const build = await prepareRender(d.bucket, work, { productionId: prod.id, timeline: rev.data, revision: p.revision, output, final: false });
    const prefix = stageInputPrefix(prod.id, "editor-preview", id);
    for (const up of build.extraUploads ?? []) await d.bucket.put(prefix + up.relPath, readFileSync(up.localPath));
    const { job } = await d.farm.submitJob({ type: "studio.render_preview", correlation_id: `editor-${id}`, affinity_key: prod.id, max_attempts: 1, payload: build.payload });
    recordFarmJob(d.db, { farmJobId: job.id, runId: prod.run_id ?? "editor", stageKey: "editor-preview", attemptId: id, productionId: prod.id, jobType: "studio.render_preview" });
    updateJob(d.db, id, { farm_job_id: job.id, status: "running" });
  } catch (e) {
    updateJob(d.db, id, { status: "failed", error: `gửi job render preview thất bại: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return getEditorJob(d.db, prod.id, id);
}

export function getEditorJob(db: StudioDb, productionId: string, id: string): EditorJobView {
  const row = db.get<EditorJobRow>("SELECT * FROM studio_editor_jobs WHERE id = ? AND production_id = ?", [id, productionId]);
  if (!row) throw new StudioRunError("not_found", `editor job ${id} not found`);
  return view(row);
}

/**
 * Advance one editor job from ag-farm's state. On completion the outputs are made immutable: the line's WAV
 * is copied to a content-addressed `audio/<sha>.wav` (what a revision stores), a preview stays under its own
 * `previews/<job>.mp4` in the job's own output prefix (`jobOutputPrefix`), next to its manifest.
 */
export async function pollEditorJob(d: EditorDeps, productionId: string, id: string, opts: { urlTtlSeconds?: number } = {}): Promise<EditorJobView & { url?: string }> {
  const row = d.db.get<EditorJobRow>("SELECT * FROM studio_editor_jobs WHERE id = ? AND production_id = ?", [id, productionId]);
  if (!row) throw new StudioRunError("not_found", `editor job ${id} not found`);
  if (row.status === "running" && row.farm_job_id) {
    const job = await d.farm.getJob(row.farm_job_id);
    if (job.status === "failed" || job.status === "cancelled") {
      const msg = (job.error as { message?: string } | null)?.message ?? job.status;
      updateJob(d.db, id, { status: "failed", error: msg });
      await d.farm.ackJob(row.farm_job_id).catch(() => undefined);
    } else if (job.status === "completed") {
      try {
        const req = JSON.parse(row.request) as { line_id?: string; text?: string; revision?: number };
        if (row.kind === "tts_line") {
          const out = jobOutputPrefix(productionId, "editor-tts", id);
          const m = TtsManifestSchema.parse(JSON.parse((await d.bucket.get(`${out}tts.json`)).toString("utf8")));
          const line = m.lines.find((l) => l.line_id === req.line_id);
          if (!line) throw new Error(`tts.json has no line ${String(req.line_id)}`);
          const wav = await d.bucket.get(`${out}${line.output}`);
          const key = `audio/${createHash("sha256").update(wav).digest("hex")}.wav`;
          await d.bucket.put(productionKey(productionId, key), wav, "audio/wav");
          updateJob(d.db, id, { status: "completed", result: JSON.stringify({ line_id: req.line_id, text: req.text, key, duration: line.duration_s }) });
        } else {
          const out = jobOutputPrefix(productionId, "editor-preview", id);
          const m = RenderManifestSchema.parse(JSON.parse((await d.bucket.get(`${out}render.json`)).toString("utf8")));
          updateJob(d.db, id, { status: "completed", result: JSON.stringify({ key: `${out}${m.output}`, duration_s: m.duration_s, watermarked: m.watermarked, revision: req.revision }) });
        }
      } catch (e) {
        updateJob(d.db, id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
      }
      await d.farm.ackJob(row.farm_job_id).catch(() => undefined);
    }
  }
  const out: EditorJobView & { url?: string } = getEditorJob(d.db, productionId, id);
  if (out.kind === "render_preview" && out.status === "completed" && out.result) {
    out.url = await d.bucket.signedGetUrl(String(out.result.key), opts.urlTtlSeconds ?? 3600);
  }
  return out;
}

/** Signed URL for a narration audio key of a timeline (the editor plays it with WebAudio). */
export function audioUrl(bucket: StudioBucket, productionId: string, key: string, ttlSeconds = 3600): Promise<string> {
  if (!/^audio\/[0-9a-f]{64}\.wav$/.test(key)) throw new StudioRunError("invalid", `not an audio key: ${key}`);
  return bucket.signedGetUrl(productionKey(productionId, key), ttlSeconds);
}

export type { TimelineV2 };
