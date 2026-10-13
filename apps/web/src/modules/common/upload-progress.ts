import { useState } from "react";
import type { OnProgress } from "../../api/http";

/** One progress callback per file that reports how far the whole batch is (by bytes, 0–1) to `report`. */
export function batchProgress(files: File[], report: (fraction: number) => void): OnProgress[] {
  const total = files.reduce((n, f) => n + f.size, 0) || 1;
  const sent = files.map(() => 0);
  return files.map((f, i) => (x: number) => {
    sent[i] = x * f.size;
    report(sent.reduce((a, b) => a + b, 0) / total);
  });
}

/**
 * How far an upload is, as a whole percent while it runs (null otherwise): `start(files)` gives one progress callback
 * per file, `done()` clears it.
 */
export function useUploadProgress(): { percent: number | null; start: (files: File[]) => OnProgress[]; done: () => void } {
  const [percent, setPercent] = useState<number | null>(null);
  return {
    percent,
    start: (files) => { setPercent(0); return batchProgress(files, (x) => setPercent(Math.floor(x * 100))); },
    done: () => setPercent(null),
  };
}
