import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EdlSchema, type Checker, type CheckerInput, type MediaProber, type StageOutput } from "@harness/contracts";

function mimeOf(input: CheckerInput, o: StageOutput): string {
  return input.request.expected_outputs.find((e) => e.type === o.type)?.mime_type ?? "";
}
const isAv = (m: string) => m.startsWith("video/") || m.startsWith("audio/");
const skip = (reason: string) => ({ verdict: "skip" as const, evidence: { reason } });

/**
 * Media-aware checkers layered on top of BUILTIN_CHECKERS; `core` never imports adapters, so the prober comes
 * in by argument (composition root wires an FfprobeMediaProber or NullMediaProber).
 *
 * `opts.available === false` (no `ffprobe` on PATH — the composition root passes `FfprobeMediaProber.isAvailable()`)
 * makes every checker in this set return `skip` with reason "no media prober available" before it looks at any
 * output, instead of failing on a `NullMediaProber` that answers `null` for every file. The whole set is gated
 * together — `edl-valid`, which needs no prober of its own, skips as well — so a machine without ffprobe reports
 * one uniform cause rather than a mix of verdicts. A prober that *is* present and still returns `null` for a
 * given file stays a `fail`: that is a broken output, not a missing tool.
 */
export function mediaCheckers(prober: MediaProber, opts: { available?: boolean } = {}): Checker[] {
  const unavailable = opts.available === false;
  const noProber = () => skip("no media prober available");

  const mediaProbe: Checker = {
    id: "media-probe",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.kind === "file" && isAv(mimeOf(input, o)));
      if (outputs.length === 0) return skip("no matching output");
      const checked: string[] = [];
      for (const o of outputs) {
        const probed = await prober.probe(join(input.workspaceDir, o.path));
        if (!probed || (!probed.video && !probed.audio)) {
          return { verdict: "fail", evidence: { path: o.path, reason: "no probeable media stream" } };
        }
        checked.push(o.path);
      }
      return { verdict: "pass", evidence: { checked } };
    },
  };

  const durationRange: Checker = {
    id: "duration-range",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.kind === "file" && mimeOf(input, o).startsWith("video/"));
      if (outputs.length === 0) return skip("no matching output");
      const range = input.request.policy.target_duration_seconds;
      if (!range) return skip("no target_duration_seconds policy");
      const [min, max] = range;
      const checked: string[] = [];
      for (const o of outputs) {
        const probed = await prober.probe(join(input.workspaceDir, o.path));
        const duration = probed?.duration_seconds ?? null;
        if (duration === null) {
          return { verdict: "fail", evidence: { path: o.path, reason: "duration unknown" } };
        }
        if (duration < min || duration > max) {
          return { verdict: "fail", evidence: { path: o.path, reason: "duration out of range", duration, min, max } };
        }
        checked.push(o.path);
      }
      return { verdict: "pass", evidence: { checked } };
    },
  };

  const audioIntegrity: Checker = {
    id: "audio-integrity",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.kind === "file" && isAv(mimeOf(input, o)));
      if (outputs.length === 0) return skip("no matching output");
      const threshold = input.request.policy.max_silence_ratio;
      const checked: string[] = [];
      for (const o of outputs) {
        const path = join(input.workspaceDir, o.path);
        const probed = await prober.probe(path);
        if (!probed || !probed.audio) {
          return { verdict: "fail", evidence: { path: o.path, reason: "no audio stream" } };
        }
        if (threshold !== undefined && prober.silenceRatio) {
          const ratio = await prober.silenceRatio(path);
          if (ratio !== null && ratio > threshold) {
            return { verdict: "fail", evidence: { path: o.path, reason: "silence ratio exceeds policy", ratio, threshold } };
          }
        }
        checked.push(o.path);
      }
      return { verdict: "pass", evidence: { checked } };
    },
  };

  const clipSetComplete: Checker = {
    id: "clip-set-complete",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.kind === "directory" && o.type === "clip_set");
      if (outputs.length === 0) return skip("no matching output");
      const edlInput = input.request.inputs.find((i) => i.type === "edl");
      if (!edlInput) return { verdict: "fail", evidence: { reason: "no edl input" } };
      const edlPath = join(input.workspaceDir, edlInput.path);
      let edl;
      try {
        edl = EdlSchema.parse(JSON.parse(readFileSync(edlPath, "utf8")));
      } catch (e) {
        return { verdict: "fail", evidence: { path: edlInput.path, reason: "invalid edl", error: e instanceof Error ? e.message : String(e) } };
      }
      const checked: string[] = [];
      for (const o of outputs) {
        for (const entry of edl.entries) {
          const filename = `${String(entry.order).padStart(3, "0")}.mp4`;
          const filePath = join(input.workspaceDir, o.path, filename);
          if (!existsSync(filePath)) {
            return { verdict: "fail", evidence: { path: filePath, reason: "missing" } };
          }
          const probed = await prober.probe(filePath);
          const expected = entry.out - entry.in;
          const duration = probed?.duration_seconds ?? null;
          if (duration === null) {
            return { verdict: "fail", evidence: { path: filePath, reason: "duration unknown" } };
          }
          if (Math.abs(duration - expected) > 0.5) {
            return { verdict: "fail", evidence: { path: filePath, reason: "duration mismatch", expected, actual: duration } };
          }
          checked.push(filePath);
        }
      }
      return { verdict: "pass", evidence: { checked } };
    },
  };

  const edlValid: Checker = {
    id: "edl-valid",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.type === "edl");
      if (outputs.length === 0) return skip("no matching output");
      const knownSourceIds = new Set(input.request.source_items.map((s) => s.source_id));
      const checked: string[] = [];
      for (const o of outputs) {
        const path = join(input.workspaceDir, o.path);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(readFileSync(path, "utf8"));
        } catch (e) {
          return { verdict: "fail", evidence: { path: o.path, reason: "unreadable", error: e instanceof Error ? e.message : String(e) } };
        }
        const parsed = EdlSchema.safeParse(parsedJson);
        if (!parsed.success) {
          return { verdict: "fail", evidence: { path: o.path, reason: "schema invalid", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }
        for (const entry of parsed.data.entries) {
          if (!knownSourceIds.has(entry.source_id)) {
            return { verdict: "fail", evidence: { path: o.path, reason: "unknown source_id", source_id: entry.source_id } };
          }
        }
        checked.push(o.path);
      }
      return { verdict: "pass", evidence: { checked } };
    },
  };

  const checkers = [mediaProbe, durationRange, audioIntegrity, clipSetComplete, edlValid];
  return unavailable ? checkers.map((c) => ({ ...c, check: async () => noProber() })) : checkers;
}
