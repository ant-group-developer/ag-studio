/**
 * The beats of a background track (plan 2026-10-15 feedback-vps §4.7): when music is imported or picked (a project's or a
 * video's, one file or several joined, or a library track), job `music_beats` asks a farm machine (`studio.beats`,
 * librosa) for every beat, the first beat of each bar and the tempo, and keeps them beside the track in the bucket
 * (`<track key>.beats.json`, `MusicBeatsSchema`), where the fit reads them to cut a shot with `snap` on the beat and the
 * agent reads the tempo (`music_list`). A track is analysed once: the next video using it finds them there.
 */
import { MusicBeatsSchema, type MusicBeats, type ProductionMusic } from "@harness/contracts";
import { BEATS_MANIFEST_PATH, BeatsManifestSchema, StudioBeatsPayloadSchema } from "@ag-farm/protocol";
import type { StudioBucket } from "../bucket.js";
import { listLibraryMusic } from "../music-library.js";
import type { StudioDb } from "../studio-db.js";
import { ackFarmJob, runFarmStep, type ProjectFarm } from "./farm.js";
import type { JobContext, JobHandler } from "./job-runner.js";
import { createJob, type JobRecord } from "./jobs-db.js";
import { projectAudio, videoOwnMusic } from "./project-audio.js";

/** The beats of a track sit beside it: `library/<path>` + this. */
export const BEATS_SUFFIX = ".beats.json";

/** The bucket key of a track's beats (`library:music/a.m4a` → `library/music/a.m4a.beats.json`). */
export function beatsKey(track: string): string {
  return `library/${track.slice("library:".length)}${BEATS_SUFFIX}`;
}

/** `request` of a `music_beats` job: the track and what the farm needs to know of it. */
export interface MusicBeatsRequest {
  track: string;
  /** Its content, when known: beats of another content under the same name are not its own. */
  sha256: string | null;
  /** Where each joined song after the first starts (seconds of the track). */
  parts: number[];
}

/** Where each joined file after the first starts: each one fades into the next over `crossfade_s`. */
export function partStarts(m: Pick<ProductionMusic, "parts" | "crossfade_s">): number[] {
  if (!m.parts || m.parts.length < 2) return [];
  const x = m.crossfade_s ?? 0;
  const starts: number[] = [];
  let at = 0;
  for (const p of m.parts.slice(0, -1)) {
    at += p.duration_s - x;
    starts.push(Math.round(at * 1000) / 1000);
  }
  return starts;
}

/** The track's beats as the bucket keeps them, or null: none yet, unreadable, or of another content under that name. */
export async function readMusicBeats(bucket: StudioBucket, track: string, sha256: string | null = null): Promise<MusicBeats | null> {
  let parsed;
  try { parsed = MusicBeatsSchema.safeParse(JSON.parse((await bucket.get(beatsKey(track))).toString("utf8"))); } catch { return null; }
  if (!parsed.success || parsed.data.track !== track) return null;
  if (sha256 && parsed.data.sha256 && parsed.data.sha256 !== sha256) return null;
  return parsed.data;
}

const shaOfChecksum = (c: string) => (c.startsWith("sha256:") ? c.slice("sha256:".length) : c) || null;

/**
 * What the farm needs to know of `track` as the video (or the project) plays it: its content and joined songs, from the
 * video's own music or the project's when it is that track, else from the music library.
 */
export async function beatsRequestFor(db: StudioDb, o: { projectId: string; videoId?: string | null; track: string }): Promise<MusicBeatsRequest> {
  const known = [o.videoId ? await videoOwnMusic(db, o.videoId) : null, (await projectAudio(db, o.projectId)).music].find((m) => m?.track === o.track);
  if (known) return { track: o.track, sha256: known.sha256 ?? null, parts: partStarts(known) };
  const lib = o.track.startsWith("library:music/") ? (await listLibraryMusic(db)).find((t) => t.file === o.track) : undefined;
  return { track: o.track, sha256: lib ? shaOfChecksum(lib.checksum) : null, parts: [] };
}

/**
 * Queues finding the beats of the music a video plays (its own, else the project's), or of the project's music when no
 * video is named: nothing when there is no music, its beats are already known, or a job is already finding them.
 */
export async function queueMusicBeats(d: { db: StudioDb; bucket?: StudioBucket }, p: {
  projectId: string; videoId?: string | null; threadId?: string | null; createdBy: string; actorRole?: JobRecord["actor_role"];
}, now = new Date().toISOString()): Promise<JobRecord | null> {
  const music = (p.videoId ? await videoOwnMusic(d.db, p.videoId) : null) ?? (await projectAudio(d.db, p.projectId)).music;
  if (!music) return null;
  const request = await beatsRequestFor(d.db, { projectId: p.projectId, videoId: p.videoId ?? null, track: music.track });
  if (d.bucket && await readMusicBeats(d.bucket, music.track, request.sha256)) return null;
  const running = await d.db.get("SELECT id FROM project_jobs WHERE project_id = ? AND kind = 'music_beats' AND status IN ('queued', 'running') AND request->>'track' = ?", [p.projectId, music.track]);
  if (running) return null;
  return createJob(d.db, {
    projectId: p.projectId, videoId: p.videoId ?? null, threadId: p.threadId ?? null, kind: "music_beats", title: "Phân tích nhịp nhạc nền",
    request: request satisfies MusicBeatsRequest, continueAgent: false, createdBy: p.createdBy, actorRole: p.actorRole ?? null,
  }, now);
}

export interface MusicBeatsDeps {
  db: StudioDb;
  bucket: StudioBucket;
  farm: ProjectFarm | null;
  pollMs?: number;
  queueTimeoutMs?: number;
}

/**
 * Finds the beats of a track on the farm (`studio.beats`) as a step of `job` and keeps them beside it. `progress` is the
 * part of the job's progress this step fills.
 */
export async function analyseMusicBeats(d: MusicBeatsDeps, ctx: JobContext, job: JobRecord, req: MusicBeatsRequest, progress: [number, number] = [0.05, 0.95]): Promise<MusicBeats> {
  if (!d.farm) throw new Error("worker này không nối farm nên chưa phân tích được nhịp nhạc");
  const [from, to] = progress;
  const payload = StudioBeatsPayloadSchema.parse({ production_id: job.project_id, tracks: [{ track_id: "music", audio: req.track, parts: req.parts }] });
  const { outputPrefix, farmJob } = await runFarmStep(
    { db: d.db, bucket: d.bucket, farm: d.farm, ...(d.pollMs ? { pollMs: d.pollMs } : {}), ...(d.queueTimeoutMs ? { queueTimeoutMs: d.queueTimeoutMs } : {}), now: ctx.now },
    job, { type: "studio.beats", payload, stageKey: "beats", attemptId: job.id, requirements: { python: true } },
    {
      onUpdate: (u) => ctx.report({ phase: `${u.phase} · tìm nhịp nhạc`, progress: from + (to - from) * (u.progress ?? 0), node: u.node, farmJobId: u.farmJobId, waiting: u.waiting }),
      stopRequested: ctx.stopRequested,
    },
  );
  const manifest = BeatsManifestSchema.parse(JSON.parse((await d.bucket.get(`${outputPrefix}${BEATS_MANIFEST_PATH}`)).toString("utf8")));
  const t = manifest.tracks.find((x) => x.track_id === "music");
  if (!t) throw new Error("máy farm không trả nhịp của nhạc");
  const beats = MusicBeatsSchema.parse({
    schema_version: "studio.music-beats/v1", track: req.track, sha256: req.sha256, duration_s: t.duration_s, bpm: t.bpm,
    beats_per_bar: t.beats_per_bar, beats: t.beats, downbeats: t.downbeats, sections: t.sections, engine: manifest.engine.name, analysed_at: ctx.now(),
  });
  await d.bucket.put(beatsKey(req.track), Buffer.from(JSON.stringify(beats)), "application/json");
  await ackFarmJob(d.farm, farmJob.id);
  return beats;
}

const s1 = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");

/** The beats in words: "≈ 120 BPM, 4 phách một ô nhịp (ô nhịp 2 s); 2 bài: 120, 96 BPM". */
export function beatsWords(b: MusicBeats): string {
  if (!b.bpm) return "không nghe ra phách rõ (snap không dời được điểm cắt)";
  const bar = (60 / b.bpm) * b.beats_per_bar;
  const parts = b.sections.length > 1 ? `; ${b.sections.length} bài: ${b.sections.map((s) => (s.bpm ? Math.round(s.bpm) : "?")).join(", ")} BPM` : "";
  return `≈ ${Math.round(b.bpm)} BPM, ${b.beats_per_bar} phách một ô nhịp (ô nhịp ${s1(bar)} s)${parts}`;
}

/** What is known of a track's beats, for the agent: the tempo, or that they are being found, or not yet. */
export async function musicBeatsStatus(d: { db: StudioDb; bucket?: StudioBucket }, projectId: string, track: string): Promise<string> {
  if (d.bucket) {
    const b = await readMusicBeats(d.bucket, track);
    if (b) return beatsWords(b);
  }
  const running = await d.db.get("SELECT id FROM project_jobs WHERE project_id = ? AND kind = 'music_beats' AND status IN ('queued', 'running') AND request->>'track' = ?", [projectId, track]);
  return running ? "đang phân tích nhịp (job music_beats)" : "chưa phân tích nhịp (fit tự phân tích khi kế hoạch có snap)";
}

/** Job `music_beats`: the track's beats from the farm, unless they are already beside it. */
export function musicBeatsHandler(d: MusicBeatsDeps): JobHandler {
  return async (job, ctx) => {
    const req = job.request as MusicBeatsRequest;
    const known = await readMusicBeats(d.bucket, req.track, req.sha256);
    if (known) return { result: { bpm: known.bpm, beats: known.beats.length, already: true }, message: null };
    await ctx.report({ phase: "Đang gửi nhạc lên farm để tìm nhịp", progress: 0.02 });
    const b = await analyseMusicBeats(d, ctx, job, req);
    return {
      result: { bpm: b.bpm, beats: b.beats.length, beats_per_bar: b.beats_per_bar, sections: b.sections.length },
      message: `Đã phân tích nhịp nhạc nền: ${beatsWords(b)}. Kế hoạch dựng có thể cắt theo nhịp (\`shots[].snap: "beat" | "bar"\`).`,
    };
  };
}
