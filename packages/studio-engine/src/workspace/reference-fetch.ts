/**
 * Reference videos fetched by the farm's machines (plan 2026-10-12 feedback round P9, ADR-0001 item 193): YouTube
 * bot-checks the Studio server, not the office machines, so a `style_watch` job hands each YouTube id to a machine
 * taking `studio.reference_fetch`. The machine runs yt-dlp with Studio's own flags (no cookies, no login, ≤480p,
 * ≤30 min, ≤300 MB) and uploads the file under the job's output prefix; Studio streams it into the job's scratch
 * folder, measures it, and deletes both the bucket object and the scratch file in the same job (`dropReferenceObjects`).
 * The video is never kept. A machine's refusal comes back with the same codes as Studio's own yt-dlp (`YtDlpError`).
 */
import { join } from "node:path";
import {
  REFERENCE_MAX_BYTES, REFERENCE_MAX_HEIGHT, REFERENCE_MAX_SECONDS, ReferenceFetchErrorCodeSchema, StudioReferenceFetchResultSchema,
  type StudioReferenceFetchPayload, type StudioReferenceFetchResult,
} from "@ag-farm/protocol";
import { jobOutputPrefix } from "@harness/executors";
import type { StudioBucket } from "../bucket.js";
import type { StudioDb } from "../studio-db.js";
import { YT_FAILURE_REASON, YtDlpError } from "../yt-dlp.js";
import { ackFarmJob, FarmJobFailed, runFarmStep, type FarmWatch, type ProjectFarm } from "./farm.js";
import type { JobRecord } from "./jobs-db.js";

/** The farm job type; a machine reports it only when it has yt-dlp. */
export const REFERENCE_FETCH_KIND = "studio.reference_fetch";
/** Bucket stage of the fetched videos: `productions/<project>/jobs/reference_fetch/<jobId>-r<n>/out/`. */
export const REFERENCE_FETCH_STAGE = "reference_fetch";

/** Farm machines online now that take `studio.reference_fetch`. */
export function referenceFetchNodes<N extends { online: boolean; kinds: readonly string[] }>(nodes: readonly N[]): N[] {
  return nodes.filter((n) => n.online && n.kinds.includes(REFERENCE_FETCH_KIND));
}

/**
 * `() => names of the machines that could fetch a reference video now`, the farm read at most every `everyMs`
 * (default 30 s). A farm that does not answer (or a client without `listNodes`) counts none: Studio's own yt-dlp then.
 */
export function referenceFetchers(farm: Pick<ProjectFarm, "listNodes">, everyMs = 30_000): () => Promise<string[]> {
  let cached: { at: number; names: Promise<string[]> } | null = null;
  return () => {
    if (!farm.listNodes) return Promise.resolve([]);
    if (cached && Date.now() - cached.at < everyMs) return cached.names;
    const names = farm.listNodes().then((r) => referenceFetchNodes(r.nodes).map((n) => n.name), () => [] as string[]);
    cached = { at: Date.now(), names };
    return names;
  };
}

/** What `style_watch` needs to fetch through the farm. */
export interface ReferenceFarm {
  client: ProjectFarm;
  bucket: StudioBucket;
  /** Machines that could take it now (`referenceFetchers`). */
  fetchers: () => Promise<string[]>;
  pollMs?: number;
  queueTimeoutMs?: number;
}

/** The reason a farm machine refused by YouTube gives (the Studio server's is `YT_FAILURE_REASON.youtube_blocked`). */
export const farmBlockedReason = (node: string | null) =>
  `YouTube đang chặn tải từ máy farm${node ? ` ${node}` : ""} (đòi đăng nhập để xác nhận không phải bot)`;

/** Where the n-th video (1-based) of a `style_watch` job lands on the bucket. */
export function referenceFetchPrefix(projectId: string, jobId: string, n: number): { attemptId: string; prefix: string } {
  const attemptId = `${jobId}-r${n}`;
  return { attemptId, prefix: jobOutputPrefix(projectId, REFERENCE_FETCH_STAGE, attemptId) };
}

/** The farm's error -> a `YtDlpError` with Studio's codes and words; anything else stays as it was. */
function asYtFailure(e: unknown): unknown {
  if (!(e instanceof FarmJobFailed)) return e;
  const code = ReferenceFetchErrorCodeSchema.safeParse(e.code);
  if (!code.success) return e;
  const detail = e.farmMessage.replace(/\s+/g, " ").trim().slice(0, 200);
  if (code.data === "other") return new YtDlpError({ code: "other", reason: detail ? `yt-dlp trên máy farm: ${detail}` : "yt-dlp trên máy farm lỗi, không rõ lý do", detail });
  const reason = code.data === "youtube_blocked" ? farmBlockedReason(e.node) : YT_FAILURE_REASON[code.data];
  return new YtDlpError({ code: code.data, reason, detail });
}

/**
 * Has one farm machine fetch one YouTube video (≤480p) and streams it into `dir`. Throws a `YtDlpError` when the
 * machine says why it could not (same codes as Studio's yt-dlp), `JobStopped` when the job is stopped. The bucket
 * object stays: the caller deletes it (`dropReferenceObjects`) once measured, whatever happened.
 */
export async function fetchReferenceOnFarm(
  d: { db: StudioDb; farm: ReferenceFarm; now: () => string },
  job: Pick<JobRecord, "id" | "project_id">,
  p: { videoId: string; n: number; dir: string },
  watch: FarmWatch,
): Promise<{ path: string; result: StudioReferenceFetchResult; node: string | null }> {
  const { attemptId } = referenceFetchPrefix(job.project_id, job.id, p.n);
  const payload: StudioReferenceFetchPayload = {
    production_id: job.project_id, video_id: p.videoId, max_height: REFERENCE_MAX_HEIGHT, max_seconds: REFERENCE_MAX_SECONDS,
    max_bytes: REFERENCE_MAX_BYTES, output: `reference/${p.videoId}.mp4`,
  };
  let node: string | null = null;
  try {
    const { outputPrefix, farmJob } = await runFarmStep(
      {
        db: d.db, bucket: d.farm.bucket, farm: d.farm.client, now: d.now,
        ...(d.farm.pollMs ? { pollMs: d.farm.pollMs } : {}), ...(d.farm.queueTimeoutMs ? { queueTimeoutMs: d.farm.queueTimeoutMs } : {}),
      },
      { id: job.id, project_id: job.project_id, video_id: null },
      { type: REFERENCE_FETCH_KIND, payload, stageKey: REFERENCE_FETCH_STAGE, attemptId, requirements: { ytdlp: true } },
      { ...watch, onUpdate: (u) => { if (u.node) node = u.node; return watch.onUpdate(u); } },
    );
    const summary = (farmJob.result as { summary?: unknown } | null)?.summary;
    const parsed = StudioReferenceFetchResultSchema.safeParse(summary);
    await ackFarmJob(d.farm.client, farmJob.id);
    if (!parsed.success) throw new Error("máy farm trả kết quả tải video mẫu không đúng dạng");
    const path = join(p.dir, `${p.videoId}.${parsed.data.ext.replace(/[^\w]/g, "") || "mp4"}`);
    await d.farm.bucket.getFile(`${outputPrefix}${parsed.data.output}`, path);
    return { path, result: parsed.data, node };
  } catch (e) {
    throw asYtFailure(e);
  }
}

/** Deletes whatever a fetch left under its output prefix (the video, a partial upload); a failure is only reported. */
export async function dropReferenceObjects(bucket: StudioBucket, projectId: string, jobId: string, n: number): Promise<number> {
  const { prefix } = referenceFetchPrefix(projectId, jobId, n);
  const keys = (await bucket.list(prefix)).map((o) => o.key);
  if (keys.length) await bucket.deleteMany(keys);
  return keys.length;
}
