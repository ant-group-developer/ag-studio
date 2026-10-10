/**
 * What Studio knows of the playbook's `studio` steps (done_when: studio), from the database: the steps Studio does
 * itself, not files the agent writes. `prepare`: the ag-go videos picked for the video, and whether each is prepared.
 */
import type { StudioDb } from "../studio-db.js";
import { listJobs } from "./jobs-db.js";
import type { StepFact } from "./playbook-status.js";
import type { PrepareRequest } from "./prepare.js";
import { getPrepared, videoAssetIds } from "./sources-db.js";

export function studioStepFacts(db: StudioDb, projectId: string): (key: string, videoId: string | null) => StepFact | undefined {
  return (key, videoId) => {
    if (key !== "prepare" || !videoId) return undefined;
    const assets = videoAssetIds(db, projectId, videoId);
    if (!assets.length) return { status: "missing", detail: "chưa chọn video ag-go nào cho video này" };
    const preparing = new Set(listJobs(db, projectId, { active: true }).filter((j) => j.kind === "prepare_asset")
      .map((j) => (JSON.parse(j.request) as PrepareRequest).asset_id));
    const states = assets.map((a) => (preparing.has(a) ? "running" : getPrepared(db, projectId, a)?.status ?? "missing"));
    const ready = states.filter((s) => s === "ready").length;
    const failed = states.filter((s) => s === "failed").length;
    if (states.includes("running")) return { status: "running", detail: `đang chuẩn bị (${ready}/${assets.length} xong)` };
    if (ready === assets.length) {
      const shots = assets.reduce((n, a) => n + (getPrepared(db, projectId, a)?.shots ?? 0), 0);
      return { status: "done", detail: `${assets.length} video, ${shots} cảnh` };
    }
    return { status: "missing", detail: `${ready}/${assets.length} video đã chuẩn bị${failed ? `, ${failed} lỗi` : ""}` };
  };
}
