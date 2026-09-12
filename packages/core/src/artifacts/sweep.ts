import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StateStore } from "@harness/contracts";

export interface SweepReport { scanned: number; removed: string[]; kept: { artifact_id: string; reason: string }[] }

function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }

/** Artifact directories with no ACCEPTED/REJECTED/STALE/ARCHIVED row behind them are orphans once older than the threshold. */
export function sweepOrphanArtifacts(p: { store: StateStore; dataRoot: string; now: string; olderThanSeconds: number; dryRun: boolean }): SweepReport {
  const root = join(p.dataRoot, "artifacts");
  const cutoff = Date.parse(p.now) - p.olderThanSeconds * 1000;
  const report: SweepReport = { scanned: 0, removed: [], kept: [] };
  for (const a of safeList(root)) for (const b of safeList(join(root, a))) for (const id of safeList(join(root, a, b))) {
    const dir = join(root, a, b, id);
    if (!statSync(dir).isDirectory()) continue;
    report.scanned++;
    const manifestPath = join(dir, "manifest.json");
    const stampSource = existsSync(manifestPath) ? manifestPath : dir;
    const mtime = statSync(stampSource).mtimeMs;
    let artifactId = id;
    if (existsSync(manifestPath)) {
      try { artifactId = String((JSON.parse(readFileSync(manifestPath, "utf8")) as { artifact_id?: string }).artifact_id ?? id); } catch { /* unreadable manifest: treat as orphan */ }
    }
    const row = p.store.getArtifact(artifactId);
    if (row && row.status !== "PROVISIONAL") { report.kept.push({ artifact_id: artifactId, reason: row.status }); continue; }
    if (mtime >= cutoff) { report.kept.push({ artifact_id: artifactId, reason: "too_young" }); continue; }
    report.removed.push(dir);
    if (!p.dryRun) rmSync(dir, { recursive: true, force: true });
  }
  return report;
}
