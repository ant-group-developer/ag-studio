import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AnySurveyIndexSchema,
  checksumSchema,
  libraryBriefSchema,
  libraryFileSchema,
  LibraryItemSchema,
  ShotsIndexSchema,
  type Checker,
  type MediaProber,
  type ShotsIndex,
} from "@harness/contracts";
import { canonicalDigest, sha256File } from "../artifacts/checksum.js";

const skip = (reason: string) => ({ verdict: "skip" as const, evidence: { reason } });

// `brief.json` may carry a `style_snapshot` alongside the LibraryBrief fields (intake writes both);
// this checker only reads `target_duration_seconds`, so extra fields are allowed rather than rejected.
const briefWithExtrasSchema = libraryBriefSchema.passthrough();

// Shape of `export-receipt.json` (exportItem's ExportReceipt), validated defensively: the receipt comes
// from a stage output on disk, not a typed in-process value, so a malformed or hand-edited file must fail
// this checker cleanly instead of throwing when its fields are read.
const exportReceiptSchema = z.object({
  item_id: z.string().min(1),
  item_dir: z.string().min(1),
  files: z.array(libraryFileSchema),
  manifest_checksum: checksumSchema,
});

/** shot_id -> its owning source_id and canonical in/out, from a `ShotsIndex` -- what `survey-valid` cross-checks
 * a v2 `survey.json`'s entries against. */
function shotIndexByShotId(shots: ShotsIndex): Map<string, { source_id: string; in: number; out: number }> {
  const map = new Map<string, { source_id: string; in: number; out: number }>();
  for (const source of shots.sources) {
    for (const shot of source.shots) map.set(shot.shot_id, { source_id: source.source_id, in: shot.in, out: shot.out });
  }
  return map;
}

/** Max allowed drift (seconds) between a v2 survey shot's `in`/`out` and its `shots.json` shot's `in`/`out`. */
const SURVEY_SHOT_TOLERANCE_SECONDS = 0.05;

/**
 * Kho-aware checkers layered on top of BUILTIN_CHECKERS and mediaCheckers (spec §3.2, §4.1):
 *
 * `brief-duration` cross-checks the episode's probed duration against the *request's*
 * `target_duration_seconds` from `brief.json` — narrower than the profile's `duration-range` policy can be,
 * since a request can ask for a tighter window than the profile default. Skips when there is no brief input
 * or the brief declares no target duration (nothing to check), and — being prober-backed — skips on a
 * machine without ffprobe the same way mediaCheckers' four prober-backed checkers do.
 *
 * `library-export-valid` verifies an `export-receipt.json` output against the kho itself: every file it
 * lists exists at `<item_dir>/<file.path>` with the declared checksum/size, and `manifest.json` parses and
 * digests to `manifest_checksum`. It needs no prober (like edl-valid), so `opts.available` never gates it.
 */
export function libraryCheckers(prober: MediaProber, opts: { available?: boolean } = {}): Checker[] {
  const unavailable = opts.available === false;

  const briefDuration: Checker = {
    id: "brief-duration",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.kind === "file" && o.type === "episode_video");
      if (outputs.length === 0) return skip("no matching output");

      const briefInput = input.request.inputs.find((i) => i.type === "brief");
      if (!briefInput) return skip("no brief input");

      const briefPath = join(input.workspaceDir, briefInput.path);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(readFileSync(briefPath, "utf8"));
      } catch (e) {
        return { verdict: "fail", evidence: { path: briefInput.path, reason: "invalid JSON in brief.json", error: e instanceof Error ? e.message : String(e) } };
      }
      const parsed = briefWithExtrasSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return { verdict: "fail", evidence: { path: briefInput.path, reason: "brief.json failed schema validation", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
      }
      const range = parsed.data.target_duration_seconds;
      if (!range) return skip("no target_duration_seconds");

      if (unavailable) return skip("no media prober available");

      const [min, max] = range;
      const checked: string[] = [];
      for (const o of outputs) {
        const probed = await prober.probe(join(input.workspaceDir, o.path));
        const duration = probed?.duration_seconds ?? null;
        if (duration === null) {
          return { verdict: "fail", evidence: { path: o.path, reason: "duration unknown" } };
        }
        if (duration < min || duration > max) {
          return { verdict: "fail", evidence: { path: o.path, reason: "duration out of range", duration, range } };
        }
        checked.push(o.path);
      }
      return { verdict: "pass", evidence: { checked } };
    },
  };

  const libraryExportValid: Checker = {
    id: "library-export-valid",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.type === "export_receipt");
      if (outputs.length === 0) return skip("no matching output");

      const checked: string[] = [];
      for (const o of outputs) {
        const receiptPath = join(input.workspaceDir, o.path);
        let receiptJson: unknown;
        try {
          receiptJson = JSON.parse(readFileSync(receiptPath, "utf8"));
        } catch (e) {
          return { verdict: "fail", evidence: { path: o.path, reason: "unreadable", error: e instanceof Error ? e.message : String(e) } };
        }
        const parsedReceipt = exportReceiptSchema.safeParse(receiptJson);
        if (!parsedReceipt.success) {
          const reason = `invalid receipt: ${parsedReceipt.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
          return { verdict: "fail", evidence: { path: receiptPath, reason } };
        }
        const receipt = parsedReceipt.data;

        for (const f of receipt.files) {
          const filePath = join(receipt.item_dir, f.path);
          if (!existsSync(filePath)) {
            return { verdict: "fail", evidence: { path: filePath, reason: "missing file" } };
          }
          const actual = await sha256File(filePath);
          if (actual.checksum !== f.checksum || actual.size_bytes !== f.size_bytes) {
            return { verdict: "fail", evidence: { path: filePath, reason: "checksum mismatch" } };
          }
        }

        const manifestPath = join(receipt.item_dir, "manifest.json");
        if (!existsSync(manifestPath)) {
          return { verdict: "fail", evidence: { path: manifestPath, reason: "missing manifest" } };
        }
        let manifestJson: unknown;
        try {
          manifestJson = JSON.parse(readFileSync(manifestPath, "utf8"));
        } catch (e) {
          return { verdict: "fail", evidence: { path: manifestPath, reason: "unreadable manifest", error: e instanceof Error ? e.message : String(e) } };
        }
        const parsedManifest = LibraryItemSchema.safeParse(manifestJson);
        if (!parsedManifest.success) {
          return { verdict: "fail", evidence: { path: manifestPath, reason: "invalid manifest", issues: parsedManifest.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }
        if (canonicalDigest(parsedManifest.data) !== receipt.manifest_checksum) {
          return { verdict: "fail", evidence: { path: manifestPath, reason: "manifest checksum mismatch" } };
        }
        checked.push(receipt.item_dir);
      }

      return { verdict: "pass", evidence: { checked } };
    },
  };

  /**
   * `survey-valid` (sub-project 5A): validates a `survey.json` output against `AnySurveyIndexSchema`. The
   * v1 (single-source) shape just needs to parse -- same as it did before this checker existed (1.1.0
   * behavior). The v2 (multi-source) shape additionally cross-checks every shot against the run's `shots`
   * input (`ShotsIndexSchema`): the `shot_id` must exist there, its `source_id` must match the shot's owner,
   * and `in`/`out` must be within `SURVEY_SHOT_TOLERANCE_SECONDS` of the indexed shot's -- a survey drifting
   * from the index it was scored against is not trustworthy input to selection. No prober needed (like
   * `library-export-valid`), so `opts.available` never gates it.
   */
  const surveyValid: Checker = {
    id: "survey-valid",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.type === "survey");
      if (outputs.length === 0) return skip("no matching output");

      const checked: string[] = [];
      for (const o of outputs) {
        const surveyPath = join(input.workspaceDir, o.path);
        let surveyJson: unknown;
        try {
          surveyJson = JSON.parse(readFileSync(surveyPath, "utf8"));
        } catch (e) {
          return { verdict: "fail", evidence: { path: o.path, reason: "unreadable", error: e instanceof Error ? e.message : String(e) } };
        }
        const parsedSurvey = AnySurveyIndexSchema.safeParse(surveyJson);
        if (!parsedSurvey.success) {
          return { verdict: "fail", evidence: { path: o.path, reason: "invalid survey", issues: parsedSurvey.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }
        const survey = parsedSurvey.data;
        if (survey.schema_version !== "harness.survey-index/v2") {
          checked.push(o.path);
          continue;
        }

        const shotsInput = input.request.inputs.find((i) => i.type === "shots");
        if (!shotsInput) return { verdict: "fail", evidence: { reason: "no shots input" } };

        const shotsPath = join(input.workspaceDir, shotsInput.path);
        let shotsJson: unknown;
        try {
          shotsJson = JSON.parse(readFileSync(shotsPath, "utf8"));
        } catch (e) {
          return { verdict: "fail", evidence: { path: shotsInput.path, reason: "unreadable shots input", error: e instanceof Error ? e.message : String(e) } };
        }
        const parsedShots = ShotsIndexSchema.safeParse(shotsJson);
        if (!parsedShots.success) {
          return { verdict: "fail", evidence: { path: shotsInput.path, reason: "invalid shots input", issues: parsedShots.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }
        const shotById = shotIndexByShotId(parsedShots.data);

        for (const shot of survey.shots) {
          const found = shotById.get(shot.shot_id);
          if (!found) return { verdict: "fail", evidence: { path: o.path, reason: "unknown shot_id", shot_id: shot.shot_id } };
          if (found.source_id !== shot.source_id) {
            return { verdict: "fail", evidence: { path: o.path, reason: "source_id mismatch", shot_id: shot.shot_id, expected: found.source_id, actual: shot.source_id } };
          }
          if (Math.abs(found.in - shot.in) > SURVEY_SHOT_TOLERANCE_SECONDS || Math.abs(found.out - shot.out) > SURVEY_SHOT_TOLERANCE_SECONDS) {
            return { verdict: "fail", evidence: { path: o.path, reason: "in/out mismatch", shot_id: shot.shot_id } };
          }
        }
        checked.push(o.path);
      }

      return { verdict: "pass", evidence: { checked } };
    },
  };

  return [briefDuration, libraryExportValid, surveyValid];
}
