/**
 * What Studio knows of the playbook's `studio` steps (done_when: studio), from the database: the steps Studio does
 * itself, not files the agent writes. `prepare`: the ag-go videos picked for the video, and whether each is prepared;
 * `timeline`: a revision of it; `preview`: a preview of the latest revision; `final`: the final render.
 */
import { timelineIssues } from "@harness/core";
import type { StudioDb } from "../studio-db.js";
import { listJobs, type JobKind, type JobRecord } from "./jobs-db.js";
import type { StepFact, StepFacts } from "./playbook-status.js";
import type { PrepareRequest } from "./prepare.js";
import { latestVideoRevision } from "./project-db.js";
import { getPrepared, videoAssetIds } from "./sources-db.js";

const active = (j: JobRecord) => j.status === "queued" || j.status === "running";
const resultRevision = (j: JobRecord) => {
  const r = j.result as { revision?: unknown } | null;
  return r && typeof r === "object" && typeof r.revision === "number" ? r.revision : null;
};

async function prepareFact(db: StudioDb, projectId: string, videoId: string): Promise<StepFact> {
  const assets = await videoAssetIds(db, projectId, videoId);
  if (!assets.length) return { status: "missing", detail: "chưa chọn video nguồn nào cho video này" };
  const preparing = new Set((await listJobs(db, projectId, { active: true })).filter((j) => j.kind === "prepare_asset")
    .map((j) => (j.request as PrepareRequest | null)?.asset_id));
  const prepared = new Map(await Promise.all(assets.map(async (a) => [a, await getPrepared(db, projectId, a)] as const)));
  const states = assets.map((a) => (preparing.has(a) ? "running" : prepared.get(a)?.status ?? "missing"));
  const ready = states.filter((s) => s === "ready").length;
  const failed = states.filter((s) => s === "failed").length;
  if (states.includes("running")) return { status: "running", detail: `đang chuẩn bị (${ready}/${assets.length} xong)` };
  if (ready === assets.length) {
    const shots = assets.reduce((n, a) => n + (prepared.get(a)?.shots ?? 0), 0);
    return { status: "done", detail: `${assets.length} video, ${shots} cảnh` };
  }
  return { status: "missing", detail: `${ready}/${assets.length} video đã chuẩn bị${failed ? `, ${failed} lỗi` : ""}` };
}

export function studioStepFacts(db: StudioDb, projectId: string): StepFacts {
  return async (key, videoId) => {
    if (!videoId) return undefined;
    if (key === "prepare") return prepareFact(db, projectId, videoId);
    const jobs = async (kind: JobKind) => (await listJobs(db, projectId, { videoId, limit: 100 })).filter((j) => j.kind === kind);
    const latest = await latestVideoRevision(db, videoId);
    if (key === "timeline") {
      if ((await jobs("fit")).some(active)) return { status: "running", detail: "đang dựng từ kế hoạch dựng" };
      if (!latest) return { status: "missing", detail: "chưa có timeline" };
      const errors = timelineIssues(latest.data).filter((i) => i.severity === "error").length;
      return errors
        ? { status: "missing", detail: `bản ${latest.revision} còn ${errors} lỗi` }
        : { status: "done", detail: `bản ${latest.revision}, ${latest.data.clips.length} clip` };
    }
    if (key === "preview" || key === "final") {
      const kind = key === "preview" ? "render_preview" : "render_final";
      const all = await jobs(kind);
      if (all.some(active)) return { status: "running", detail: key === "preview" ? "đang render bản xem trước" : "đang render bản cuối" };
      if (key === "final" && await db.get("SELECT 1 AS x FROM agent_actions WHERE video_id = ? AND kind = 'render_final' AND status = 'proposed'", [videoId])) {
        return { status: "missing", detail: "chờ người dùng xác nhận render bản cuối" };
      }
      const done = all.find((j) => j.status === "done");
      if (!done) return { status: "missing", detail: key === "preview" ? "chưa render bản xem trước" : "chưa render bản cuối" };
      const rev = resultRevision(done);
      if (latest && rev !== null && rev < latest.revision) return { status: "missing", detail: `bản đã render là của timeline bản ${rev}, timeline đang ở bản ${latest.revision}` };
      return { status: "done", detail: `timeline bản ${rev ?? "?"}` };
    }
    return undefined;
  };
}
