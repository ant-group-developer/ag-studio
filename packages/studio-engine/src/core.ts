/**
 * The Studio engine's shared core: the data folder, the harness root (skills, templates) and the clock. The API and
 * the worker both build it at start; the database is a separate `StudioDb` (studio-db.ts, migrate.ts).
 */
import { mkdirSync } from "node:fs";
import { HARNESS_ROOT, SystemClock } from "@harness/core";
import { HarnessError, type Clock } from "@harness/contracts";

/** Claude calls a Studio worker runs at once by default (`STUDIO_CLAUDE_MAX_CONCURRENT`): agent turns and structured calls. */
export const DEFAULT_CLAUDE_MAX_CONCURRENT = 20;

/** `STUDIO_CLAUDE_MAX_CONCURRENT`: unset or blank → default; anything but a whole number 1–100 is refused at start. */
export function parseClaudeMaxConcurrent(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CLAUDE_MAX_CONCURRENT;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new HarnessError("CONFIG_INVALID", `STUDIO_CLAUDE_MAX_CONCURRENT must be a whole number from 1 to 100, got "${raw}"`, { value: raw });
  }
  return n;
}

export interface StudioEngineCoreOptions {
  /** Data of the engine (voice store, scratch folders of jobs and turns, workspaces by default). */
  dataRoot: string;
  harnessRoot?: string;
  clock?: Clock;
}

export interface StudioEngineCore {
  clock: Clock;
  dataRoot: string;
  harnessRoot: string;
}

export function createStudioEngineCore(o: StudioEngineCoreOptions): StudioEngineCore {
  mkdirSync(o.dataRoot, { recursive: true });
  return { clock: o.clock ?? new SystemClock(), dataRoot: o.dataRoot, harnessRoot: o.harnessRoot ?? HARNESS_ROOT };
}
