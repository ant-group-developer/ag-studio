import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EdlSchema, NarrationSchema, NarrationTimingSchema, type Checker, type CheckerInput, type MediaProber, type StageOutput } from "@harness/contracts";

function mimeOf(input: CheckerInput, o: StageOutput): string {
  return input.request.expected_outputs.find((e) => e.type === o.type)?.mime_type ?? "";
}
const isAv = (m: string) => m.startsWith("video/") || m.startsWith("audio/");
const skip = (reason: string) => ({ verdict: "skip" as const, evidence: { reason } });

/** `ffmpeg -i <path> -af volumedetect -f null -`, parsing `max_volume: <n> dB` from stderr; `null` when the
 * line cannot be found (ffmpeg failed to run, or produced no volumedetect line at all). */
function peakVolumeDb(ffmpeg: string, path: string): number | null {
  const r = spawnSync(ffmpeg, ["-i", path, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const m = (r.stderr ?? "").match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Media-aware checkers layered on top of BUILTIN_CHECKERS; `core` never imports adapters, so the prober comes
 * in by argument (composition root wires an FfprobeMediaProber or NullMediaProber).
 *
 * `opts.available === false` (no `ffprobe` on PATH — the composition root passes `FfprobeMediaProber.isAvailable()`)
 * makes the five **prober-backed** checkers (`media-probe`, `duration-range`, `audio-integrity`,
 * `clip-set-complete`, `tts-valid`) return `skip` with reason "no media prober available" before they look at
 * any output, instead of failing on a `NullMediaProber` that answers `null` for every file (`tts-valid` needs
 * no `MediaProber` method itself -- its peak check shells out to `opts.ffmpeg` directly -- but ffmpeg and
 * ffprobe are installed together in every supported setup, so it is gated on the same flag). `edl-valid` is
 * exempt: it only parses JSON against `EdlSchema`/`NarrationSchema` and cross-checks `request.source_items`,
 * so it keeps giving a real pass/fail verdict on a machine without ffprobe. A prober that *is* present and
 * still returns `null` for a given file stays a `fail`: that is a broken output, not a missing tool.
 */
export function mediaCheckers(prober: MediaProber, opts: { available?: boolean; ffmpeg?: string } = {}): Checker[] {
  const unavailable = opts.available === false;
  const ffmpeg = opts.ffmpeg ?? "ffmpeg";
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

  /**
   * `narration_timing` output (task 5): every line's wav exists under the `voice_set` directory output,
   * `duration_seconds > 0` (already guaranteed by `NarrationTimingSchema` -- a schema failure surfaces as
   * "schema invalid" instead), a reading rate of 5-30 chars/second, and a peak below 0 dBFS. An empty
   * `lines: []` passes trivially (`voice: none|original`, or `voice: tts` with an empty script). `lines[].wav`
   * ("voice/<line_id>.wav") is resolved against the directory *containing* the `voice_set` output -- that
   * directory is `output/`, and `wav` is already relative to it (spec: sub-project 5A task 5 resolution).
   */
  const ttsValid: Checker = {
    id: "tts-valid",
    version: "1.0.0",
    async check(input) {
      const timingOutput = input.result.outputs.find((o) => o.type === "narration_timing");
      if (!timingOutput) return skip("no matching output");
      const timingPath = join(input.workspaceDir, timingOutput.path);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(readFileSync(timingPath, "utf8"));
      } catch (e) {
        return { verdict: "fail", evidence: { path: timingOutput.path, reason: "unreadable", error: e instanceof Error ? e.message : String(e) } };
      }
      const parsed = NarrationTimingSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return { verdict: "fail", evidence: { path: timingOutput.path, reason: "schema invalid", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
      }
      const timing = parsed.data;
      if (timing.lines.length === 0) return { verdict: "pass", evidence: { checked: [] } };

      const voiceSetOutput = input.result.outputs.find((o) => o.type === "voice_set");
      if (!voiceSetOutput) return { verdict: "fail", evidence: { reason: "no voice_set output" } };
      const voiceParentDir = dirname(voiceSetOutput.path);

      const checked: string[] = [];
      for (const line of timing.lines) {
        const wavPath = join(input.workspaceDir, voiceParentDir, line.wav);
        if (!existsSync(wavPath)) {
          return { verdict: "fail", evidence: { path: line.wav, reason: "missing wav", line_id: line.line_id } };
        }
        const rate = line.text.length / line.duration_seconds;
        if (rate < 5 || rate > 30) {
          return { verdict: "fail", evidence: { path: line.wav, reason: "reading rate out of range", line_id: line.line_id, chars_per_second: rate } };
        }
        const peak = peakVolumeDb(ffmpeg, wavPath);
        if (peak === null) {
          return { verdict: "fail", evidence: { path: line.wav, reason: "peak unknown", line_id: line.line_id } };
        }
        if (peak >= 0) {
          return { verdict: "fail", evidence: { path: line.wav, reason: "peak at or above 0 dBFS", line_id: line.line_id, peak_db: peak } };
        }
        checked.push(line.wav);
      }
      return { verdict: "pass", evidence: { checked } };
    },
  };

  const edlValid: Checker = {
    id: "edl-valid",
    version: "1.1.0",
    async check(input) {
      const edlOutputs = input.result.outputs.filter((o) => o.type === "edl");
      if (edlOutputs.length === 0) return skip("no matching output");
      const knownSourceIds = new Set(input.request.source_items.map((s) => s.source_id));
      const knownOrders = new Set<number>();
      const checked: string[] = [];
      for (const o of edlOutputs) {
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
          knownOrders.add(entry.order);
        }
        checked.push(o.path);
      }

      // sub-project 5A task 5: a `narration` output (mime application/json) is cross-checked against the edl
      // output(s) parsed above -- `edl_order` must exist in the edl, `line_id` unique. A `narration` output
      // with mime text/plain (the pre-5A `narration.txt` shape, workflow 1.1.0) is left untouched, exactly as
      // before this checker knew about narration at all.
      const narrationOutputs = input.result.outputs.filter((o) => o.type === "narration" && mimeOf(input, o) === "application/json");
      for (const o of narrationOutputs) {
        const path = join(input.workspaceDir, o.path);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(readFileSync(path, "utf8"));
        } catch (e) {
          return { verdict: "fail", evidence: { path: o.path, reason: "unreadable", error: e instanceof Error ? e.message : String(e) } };
        }
        const parsed = NarrationSchema.safeParse(parsedJson);
        if (!parsed.success) {
          return { verdict: "fail", evidence: { path: o.path, reason: "schema invalid", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }
        const seenLineIds = new Set<string>();
        for (const line of parsed.data.lines) {
          if (seenLineIds.has(line.line_id)) {
            return { verdict: "fail", evidence: { path: o.path, reason: "duplicate line_id", line_id: line.line_id } };
          }
          seenLineIds.add(line.line_id);
          if (!knownOrders.has(line.edl_order)) {
            return { verdict: "fail", evidence: { path: o.path, reason: "unknown edl_order", edl_order: line.edl_order, line_id: line.line_id } };
          }
        }
        checked.push(o.path);
      }

      return { verdict: "pass", evidence: { checked } };
    },
  };

  const proberBacked = [mediaProbe, durationRange, audioIntegrity, clipSetComplete, ttsValid];
  // edlValid needs no prober, so it is never gated on one
  return [...(unavailable ? proberBacked.map((c) => ({ ...c, check: async () => noProber() })) : proberBacked), edlValid];
}
