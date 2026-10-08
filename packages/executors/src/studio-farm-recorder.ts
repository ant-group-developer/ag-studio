/**
 * makeStudioFarmRecorder — factory for the `onSubmitted` callback passed to
 * `FarmExecutor`. Inserts a row into `studio_farm_jobs` in the AG Studio
 * SQLite database immediately after a farm job is successfully submitted.
 *
 * This must be called BEFORE the ag-farm worker can call `/api/farm/sign`,
 * because the sign endpoint looks up jobs by `farm_job_id`. Any sign request
 * that arrives while the row is absent will receive 403 Forbidden.
 *
 * Usage:
 *   import { makeStudioFarmRecorder } from "@harness/executors";
 *
 *   const executor = new FarmExecutor({
 *     client,
 *     storage,
 *     onSubmitted: makeStudioFarmRecorder(process.env.STUDIO_DB_PATH!),
 *   });
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SubmittedInfo } from "./farm-executor.js";

/**
 * Returns an async function that inserts a `studio_farm_jobs` row for the
 * submitted farm job (with its episode, when the run is an episode's, and the
 * requirements it was sent with), using the provided path to the AG Studio SQLite
 * database (`STUDIO_DB_PATH`).
 *
 * The database must already exist and have `studio_farm_jobs` created (by
 * `StudioDbService.runMigrations()` on API start-up).
 */
export function makeStudioFarmRecorder(
  dbPath: string,
): (info: SubmittedInfo) => Promise<void> {
  return async (info: SubmittedInfo): Promise<void> => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.prepare(
        `INSERT OR IGNORE INTO studio_farm_jobs
         (id, farm_job_id, run_id, stage_key, attempt_id, production_id,
          episode_id, job_type, is_final_render, requirements, fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?,
          (SELECT id FROM episodes WHERE run_id = ?), ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        info.farmJobId,
        info.runId,
        info.stageKey,
        info.attemptId,
        info.productionId,
        info.runId,
        info.jobType,
        info.isFinalRender ? 1 : 0,
        info.requirements ? JSON.stringify(info.requirements) : null,
        info.fingerprint ?? null,
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
  };
}
