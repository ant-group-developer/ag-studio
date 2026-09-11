import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, MIGRATIONS_DIR, SqliteStateStore } from "../src/index.js";

export function openTempStore(startIso = "2026-09-11T00:00:00.000Z") {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  const clock = new FixedClock(startIso);
  const store = new SqliteStateStore(join(dir, "state.db"), clock);
  store.migrate(MIGRATIONS_DIR);
  return { store, dir, clock };
}
