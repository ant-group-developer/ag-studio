/**
 * A video's timeline from its edit plan (spec 2026-10-10 agent-workspace §P6, job `fit`): the agent writes
 * `videos/<id>/edit-plan.json` (shots of the video's sources, narration lines, texts) after `survey.json`; this job
 * reads the narration lines on the farm (`studio.tts`, the project's voice; lines already read come from the voice
 * store), fits the picture to them (`fitCutTimeline`, as the shot-cut episodes did) and saves a new timeline revision
 * (label `fit`). The branding's text look and the project's music (else a library track by mood) go into it. Shots with
 * `snap` cut on the music's beats (kept beside the track by job `music_beats`, else found here on the farm).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EditPlanSchema, ShotsIndexSchema, StudioSurveySchema, TextLookSchema, TranscriptSchema, VIDEO_LOOKS,
  type EditPlan, type EpisodeAsset, type ShotsIndex, type StudioMusic, type TextLook, type TimelineV4, type Transcript, type VideoLook,
} from "@harness/contracts";
import { clampClipOuts, timelineIssues, type BeatGrid } from "@harness/core";
import { StudioTtsPayloadSchema, TTS_MANIFEST_PATH, TtsManifestSchema } from "@ag-farm/protocol";
import type { StudioBucket } from "../bucket.js";
import { fitCutTimeline, type ReadLine } from "../cut-fit.js";
import { listLibraryMusic, pickLibraryMusic } from "../music-library.js";
import type { StudioDb } from "../studio-db.js";
import type { StudioVoice } from "../voice.js";
import { getVoiceLine, putVoiceLine, voiceKey } from "../voice-store.js";
import { ackFarmJob, JobStopped, runFarmStep, type ProjectFarm } from "./farm.js";
import { writeWorkspaceFile } from "./files.js";
import { readFrontmatter } from "./frontmatter.js";
import type { JobContext, JobHandler } from "./job-runner.js";
import { createJob, type JobRecord } from "./jobs-db.js";
import type { InputTranscript } from "./prepare.js";
import { latestVideoRevision, requireProject, requireVideo, saveVideoRevision } from "./project-db.js";
import { musicForVideo, projectNarrationVoice } from "./project-audio.js";
import { analyseMusicBeats, beatsRequestFor, beatsWords, readMusicBeats } from "./music-beats.js";
import { buildVideoIndex, type VideoIndex } from "./video-index.js";

export interface FitDeps {
  db: StudioDb;
  bucket: StudioBucket;
  farm: ProjectFarm | null;
  voiceDir: string;
  pollMs?: number;
  queueTimeoutMs?: number;
}

/** `request` of a `fit` job. */
export interface FitJobRequest { video_id: string }

export const editPlanPath = (videoId: string) => `videos/${videoId}/edit-plan.json`;
export const surveyPath = (videoId: string) => `videos/${videoId}/survey.json`;
export const timelineSnapshotPath = (videoId: string) => `videos/${videoId}/timeline.json`;

const CANVAS = { "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 } } as const;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The video's sources as the shot-cut fit reads them: shots per source, numbered for the video. */
export function shotsOfIndex(index: VideoIndex): ShotsIndex {
  const ready = index.sources.filter((s) => s.status === "ready" && s.shots.length);
  if (!ready.length) throw new Error("video chưa có nguồn nào đã chuẩn bị (inputs_prepare)");
  return ShotsIndexSchema.parse({
    schema_version: "harness.shots/v2",
    sources: ready.map((s) => ({
      source_id: s.source_id, index: s.index, file_name: `${s.asset_id}.mp4`, duration_seconds: s.duration_s ?? s.shots.at(-1)!.out,
      has_audio: s.has_audio ?? false, shots: s.shots.map((x) => ({ shot_id: x.shot_id, in: x.in, out: x.out })),
    })),
  });
}

/** What was said in each prepared source (its `inputs/<asset>/transcript.json`), as the fit reads it. */
export function transcriptOfIndex(dir: string, index: VideoIndex): Transcript {
  return TranscriptSchema.parse({
    schema_version: "harness.transcript/v1", engine: "studio.transcribe",
    sources: index.sources.filter((s) => s.status === "ready").map((s) => {
      const path = join(dir, s.input, "transcript.json");
      const t = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as InputTranscript) : null;
      return t
        ? { source_id: s.source_id, language: t.language, alignment: t.alignment, segments: t.segments.map((g) => ({ start: g.start, end: g.end, text: g.text, words: g.words })) }
        : { source_id: s.source_id, language: null, alignment: "segment" as const, segments: [] };
    }),
  });
}

/** The assets a video may use (its prepared sources), as a timeline records them. */
export function videoAssets(index: VideoIndex, dir: string): Record<string, EpisodeAsset> {
  const out: Record<string, EpisodeAsset> = {};
  for (const s of index.sources) {
    if (s.status !== "ready") continue;
    let orientation: string | null = null;
    try {
      const shots = JSON.parse(readFileSync(join(dir, s.input, "shots.json"), "utf8")) as { width?: number | null; height?: number | null };
      if (shots.width && shots.height) orientation = shots.width >= shots.height ? "landscape" : "portrait";
    } catch { /* no orientation */ }
    out[s.asset_id] = { title: s.name, summary_vi: "", duration_s: s.duration_s ?? s.shots.at(-1)?.out ?? 1, orientation };
  }
  return out;
}

/** The branding's text look, colour look and music moods (`channel/branding.md` frontmatter), when it has them. */
export function brandingOf(dir: string): { textLook: TextLook | null; look: VideoLook | null; musicMoods: string[] } {
  const path = join(dir, "channel", "branding.md");
  if (!existsSync(path)) return { textLook: null, look: null, musicMoods: [] };
  const fm = readFrontmatter(readFileSync(path, "utf8")).data as Record<string, unknown> | null;
  const look = fm?.text_look ? TextLookSchema.safeParse(fm.text_look) : null;
  const moods = Array.isArray(fm?.music_mood) ? (fm!.music_mood as unknown[]).filter((m): m is string => typeof m === "string") : [];
  const colour = typeof fm?.look === "string" && (VIDEO_LOOKS as readonly string[]).includes(fm.look) ? (fm.look as VideoLook) : null;
  return { textLook: look?.success ? look.data : null, look: colour, musicMoods: moods };
}

/** The plan as the video's: its own id, checked against the schema and the video's shots. */
export function readEditPlan(dir: string, videoId: string, shots: ShotsIndex): EditPlan {
  const path = join(dir, editPlanPath(videoId));
  if (!existsSync(path)) throw new Error(`chưa có ${editPlanPath(videoId)} (skill edit-plan)`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new Error(`${editPlanPath(videoId)} không phải JSON: ${(e as Error).message}`); }
  const parsed = EditPlanSchema.safeParse({ ...(raw as object), episode_id: videoId });
  if (!parsed.success) throw new Error(`${editPlanPath(videoId)} sai: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const known = new Map(shots.sources.flatMap((s) => s.shots.map((x) => [x.shot_id, { ...x, source_id: s.source_id }] as const)));
  const wrong = parsed.data.shots.filter((s) => {
    const k = known.get(s.shot_id);
    return !k || k.source_id !== s.source_id || s.in < k.in - 0.05 || s.out > k.out + 0.05 || s.out <= s.in;
  });
  if (wrong.length) throw new Error(`kế hoạch dựng có shot không khớp sources/index.json: ${wrong.slice(0, 5).map((s) => `#${s.order} ${s.shot_id}`).join(", ")}`);
  return parsed.data;
}

/** Queues building the video's timeline from its edit plan. */
export async function queueFit(db: StudioDb, p: { projectId: string; videoId: string; threadId?: string | null; continueAgent?: boolean; createdBy: string; actorRole?: JobRecord["actor_role"] }, now = new Date().toISOString()): Promise<JobRecord> {
  const v = await requireVideo(db, p.videoId);
  return createJob(db, {
    projectId: p.projectId, videoId: v.id, threadId: p.threadId ?? null, kind: "fit", title: `Dựng timeline: ${v.title}`, request: { video_id: v.id } satisfies FitJobRequest,
    continueAgent: p.continueAgent ?? false, createdBy: p.createdBy, actorRole: p.actorRole ?? null,
  }, now);
}

/** `videos/<id>/timeline.json`: the latest revision, for the agent to read (Studio writes it; edits go through tools). */
export async function writeTimelineSnapshot(db: StudioDb, dir: string, projectId: string, videoId: string, now = new Date().toISOString()): Promise<number | null> {
  const rev = await latestVideoRevision(db, videoId);
  if (!rev) return null;
  const issues = timelineIssues(rev.data).map((i) => ({ severity: i.severity, code: i.code, message: i.message }));
  await writeWorkspaceFile(db, {
    projectId, dir, path: timelineSnapshotPath(videoId), author: { kind: "studio", id: null }, now,
    content: `${JSON.stringify({ revision: rev.revision, label: rev.label, saved_at: rev.created_at, issues, timeline: rev.data }, null, 2)}\n`,
  });
  return rev.revision;
}

async function readLines(d: FitDeps, ctx: JobContext, job: JobRecord, plan: EditPlan, voice: StudioVoice): Promise<Record<string, ReadLine>> {
  const keyOf = (text: string) => voiceKey({ text, language: plan.language, voice });
  const missing: EditPlan["lines"] = [];
  for (const l of plan.lines) if (!await getVoiceLine(d.db, d.voiceDir, keyOf(l.text))) missing.push(l);
  if (missing.length) {
    if (!d.farm) throw new Error("worker này không nối farm nên chưa đọc được lời dẫn");
    await ctx.report({ phase: `Đang gửi ${missing.length} câu lời dẫn lên farm`, progress: 0.1 });
    const payload = StudioTtsPayloadSchema.parse({
      production_id: job.project_id, language: plan.language, voice, align_words: true,
      lines: missing.map((l) => ({ line_id: l.line_id, text: l.text, pause_seconds: null })),
    });
    const { outputPrefix, farmJob } = await runFarmStep(
      { db: d.db, bucket: d.bucket, farm: d.farm, ...(d.pollMs ? { pollMs: d.pollMs } : {}), ...(d.queueTimeoutMs ? { queueTimeoutMs: d.queueTimeoutMs } : {}), now: ctx.now },
      job, { type: "studio.tts", payload, stageKey: "tts", attemptId: job.id },
      {
        onUpdate: (u) => ctx.report({ phase: `${u.phase} · đọc lời dẫn`, progress: 0.1 + 0.7 * (u.progress ?? 0), node: u.node, farmJobId: u.farmJobId, waiting: u.waiting }),
        stopRequested: ctx.stopRequested,
      },
    );
    await ctx.report({ phase: "Đang lưu lời dẫn đã đọc", progress: 0.82, waiting: false });
    const manifest = TtsManifestSchema.parse(JSON.parse((await d.bucket.get(`${outputPrefix}${TTS_MANIFEST_PATH}`)).toString("utf8")));
    const textOf = new Map(plan.lines.map((l) => [l.line_id, l.text]));
    mkdirSync(join(ctx.tempDir, "tts"), { recursive: true });
    for (const line of manifest.lines) {
      const text = textOf.get(line.line_id);
      if (!text) continue;
      const wav = join(ctx.tempDir, "tts", `${line.line_id}.wav`);
      writeFileSync(wav, await d.bucket.get(`${outputPrefix}${line.output}`));
      await putVoiceLine(d.db, d.voiceDir, keyOf(text), wav, { duration_s: line.duration_s, words: line.words, language: manifest.language }, ctx.now());
    }
    await ackFarmJob(d.farm, farmJob.id);
  }
  const read: Record<string, ReadLine> = {};
  for (const l of plan.lines) {
    const v = await getVoiceLine(d.db, d.voiceDir, keyOf(l.text), ctx.now());
    if (!v) throw new Error(`lời dẫn ${l.line_id} chưa được đọc`);
    read[l.line_id] = { key: v.key, duration_s: v.duration_s, words: v.words };
  }
  return read;
}

/** How far a fitted timeline may sit from the edit plan's `target_seconds` before the job says so (plan 2026-10-15 §3.3). */
export const TARGET_TOLERANCE = 0.2;

const clockOf = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** "timeline dài 4:10, ngắn hơn mục tiêu 6:00 của kế hoạch dựng 31%" when the timeline is off target by more than
 * `TARGET_TOLERANCE`; null when it is close enough or there is no target. */
export function lengthOffTarget(seconds: number, target: number): string | null {
  if (!(target > 0)) return null;
  const off = (seconds - target) / target;
  if (Math.abs(off) <= TARGET_TOLERANCE) return null;
  return `timeline dài ${clockOf(seconds)}, ${off < 0 ? "ngắn" : "dài"} hơn mục tiêu ${clockOf(target)} của kế hoạch dựng ${Math.round(Math.abs(off) * 100)}%`;
}

/** What `snap` did, in a sentence for the job's message (empty when the plan has none). */
function snapWords(s: { moves: { clip_id: string }[]; skipped: { clip_id: string; reason: string }[] }, music: string | null): string {
  if (!music && !s.moves.length && !s.skipped.length) return "";
  const moved = s.moves.length ? `${s.moves.length} điểm cắt dời về phách/ô nhịp` : "không điểm cắt nào phải dời";
  const kept = s.skipped.length
    ? `; ${s.skipped.length} chỗ giữ nguyên (${s.skipped.map((x) => `${x.clip_id}: ${x.reason === "narration" ? "dời sẽ đè lời dẫn" : "không có phách trong tầm"}`).join(", ")})`
    : "";
  return ` Cắt theo nhịp: ${music ?? ""}${music ? "; " : ""}${moved}${kept}.`;
}

export function fitHandler(d: FitDeps): JobHandler {
  return async (job, ctx) => {
    const { video_id: videoId } = job.request as FitJobRequest;
    const video = await requireVideo(d.db, videoId);
    const project = await requireProject(d.db, job.project_id);
    if (video.project_id !== project.id) throw new Error("video thuộc dự án khác");
    await ctx.report({ phase: "Đang đọc kế hoạch dựng", progress: 0.02 });
    const index = await buildVideoIndex(d.db, ctx.workspaceDir, project.id, videoId);
    const shots = shotsOfIndex(index);
    const plan = readEditPlan(ctx.workspaceDir, videoId, shots);
    const surveyRaw = existsSync(join(ctx.workspaceDir, surveyPath(videoId))) ? JSON.parse(readFileSync(join(ctx.workspaceDir, surveyPath(videoId)), "utf8")) as unknown : null;
    const survey = StudioSurveySchema.safeParse(surveyRaw);
    if (!survey.success) throw new Error(`${surveyPath(videoId)} thiếu hoặc sai (skill scene-selection)`);
    await ctx.setUnits(plan.target_seconds);

    // narration: read in the project's voice; declined: written lines (subtitles); none at all: say so
    let read: Record<string, ReadLine> = {};
    let written = false;
    if (plan.narration === "tts" && plan.lines.length) {
      const nv = await projectNarrationVoice(d.db, project.id);
      if (nv.kind === "missing") throw new Error("dự án chưa có giọng đọc: chọn một file audio làm giọng mẫu ở tab Đầu vào, hoặc đổi narration của kế hoạch");
      if (nv.kind === "none") written = true;
      else read = await readLines(d, ctx, job, plan, nv.voice);
    }
    await ctx.checkpoint();

    await ctx.report({ phase: "Đang khớp hình với lời", progress: 0.88 });
    const branding = brandingOf(ctx.workspaceDir);
    // the video's own music, else the project's, else a library track by the plan's mood, then the branding's
    const chosen = await musicForVideo(d.db, project.id, videoId);
    let music: StudioMusic | null = chosen?.music ?? null;
    let musicNote = chosen ? (chosen.from === "video" ? "nhạc riêng của video" : "nhạc của dự án") : "không nhạc";
    if (!music) {
      const picked = pickLibraryMusic(await listLibraryMusic(d.db, { activeOnly: true }), [plan.music_mood, ...branding.musicMoods], { seed: videoId, seconds: plan.target_seconds });
      if (picked) { music = picked.music; musicNote = `nhạc thư viện "${picked.track.display_name}" (tâm trạng ${picked.mood})`; }
    }
    // the plan's own say on the music (feedback-vps §4.4): none at all, or its gain and ducking over whichever track
    if (plan.music === null) { music = null; musicNote = "không nhạc (theo kế hoạch dựng)"; }
    else if (music && plan.music) {
      music = { ...music, ...(plan.music.gain_db !== undefined ? { gain_db: plan.music.gain_db } : {}), ...(plan.music.ducking !== undefined ? { ducking: plan.music.ducking } : {}) };
      musicNote = `${musicNote}, ${music.gain_db} dB${music.ducking ? "" : ", không nhỏ lại khi có lời"}`;
    }
    // cuts on the music's beat (feedback-vps §4.7): its beats from beside the track, else found now on the farm
    let beats: BeatGrid | null = null;
    let beatsNote: string | null = null;
    if (plan.shots.some((s) => s.snap)) {
      if (!music) beatsNote = "kế hoạch có snap nhưng video không có nhạc nên điểm cắt giữ nguyên";
      else {
        const req = await beatsRequestFor(d.db, { projectId: project.id, videoId, track: music.track });
        let b = await readMusicBeats(d.bucket, music.track, req.sha256);
        if (!b) {
          try {
            await ctx.report({ phase: "Đang tìm nhịp của nhạc nền", progress: 0.88 });
            b = await analyseMusicBeats(d, ctx, job, req, [0.88, 0.92]);
          } catch (e) {
            if (e instanceof JobStopped) throw e;
            beatsNote = `chưa có nhịp của nhạc (${e instanceof Error ? e.message : String(e)}) nên điểm cắt giữ nguyên`;
          }
        }
        if (b) beatsNote = `nhạc ${beatsWords(b)}`;
        if (b?.bpm) beats = { beats: b.beats, downbeats: b.downbeats, duration_s: b.duration_s };
      }
    }
    const fitted = fitCutTimeline({
      productionId: project.id, plan, shots, survey: survey.data, transcript: transcriptOfIndex(ctx.workspaceDir, index), voice: read, written,
      sources: index.sources.map((s) => ({ asset_id: s.asset_id, source_id: s.source_id })), assets: videoAssets(index, ctx.workspaceDir),
      canvas: CANVAS[project.aspect], fps: 30, music, clipAudio: true, textStyle: plan.text_look ?? branding.textLook,
      look: plan.look ?? branding.look, beats,
    });
    const report = fitted.report;
    // a shot that runs past the end of its prepared video plays to that end, never more than the file holds
    const { timeline, issues: clamped } = clampClipOuts(fitted.timeline);
    // on top of whatever is the latest when it is saved (a person's save meanwhile is kept, not a conflict)
    const { revision } = await d.db.tx(async () => {
      const latest = await latestVideoRevision(d.db, videoId);
      return saveVideoRevision(d.db, videoId, { baseRevision: latest?.revision ?? 0, data: timeline as TimelineV4, authorId: "system", label: "fit" });
    });
    await writeTimelineSnapshot(d.db, ctx.workspaceDir, project.id, videoId, ctx.now());
    const seconds = r3(timeline.clips.reduce((n, c) => n + ((c.out ?? c.in) - c.in), 0));
    const issues = timelineIssues(timeline).filter((i) => i.severity === "error");
    const shortfalls = report.shortfalls.length;
    const offTarget = lengthOffTarget(seconds, plan.target_seconds);
    return {
      result: {
        revision, clips: timeline.clips.length, seconds, target_seconds: plan.target_seconds, off_target: offTarget !== null, music: musicNote, shortfalls,
        errors: issues.length, clamped: clamped.map((i) => i.clip_id),
        ...(beatsNote || fitted.snap.moves.length || fitted.snap.skipped.length
          ? { snap: { moved: fitted.snap.moves.map((m) => ({ clip_id: m.clip_id, kind: m.snap, from: m.from, to: m.to })), not_moved: fitted.snap.skipped.map((s) => ({ clip_id: s.clip_id, reason: s.reason })), music: beatsNote } }
          : {}),
      },
      message: `Đã dựng timeline bản ${revision} cho **${video.title}**: ${timeline.clips.length} clip, ≈ ${clockOf(seconds)}, ${musicNote}${written ? ", lời dẫn thành phụ đề" : ""}.`
        + `${offTarget ? ` Lưu ý: ${offTarget}; nói với người dùng và hỏi họ muốn thêm cảnh, thêm lời hay giữ độ dài này.` : ""}`
        + `${shortfalls ? ` ${shortfalls} chỗ thiếu hình cho lời dẫn (xem videos/${videoId}/timeline.json).` : ""}${issues.length ? ` Còn ${issues.length} lỗi timeline.` : ""}`
        + `${clamped.length ? ` ${clamped.length} clip dài quá video nguồn, đã cắt ở cuối video (${clamped.map((i) => i.clip_id).join(", ")}).` : ""}`
        + snapWords(fitted.snap, beatsNote),
    };
  };
}

