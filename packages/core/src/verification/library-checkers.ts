import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { libraryBriefSchema, LibraryItemSchema, type Checker, type MediaProber } from "@harness/contracts";
import { canonicalDigest, sha256File } from "../artifacts/checksum.js";
import type { ExportReceipt } from "../library/export.js";

const skip = (reason: string) => ({ verdict: "skip" as const, evidence: { reason } });

// `brief.json` may carry a `style_snapshot` alongside the LibraryBrief fields (intake writes both);
// this checker only reads `target_duration_seconds`, so extra fields are allowed rather than rejected.
const briefWithExtrasSchema = libraryBriefSchema.passthrough();

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
        return { verdict: "fail", evidence: { path: briefInput.path, reason: "invalid brief.json", error: e instanceof Error ? e.message : String(e) } };
      }
      const parsed = briefWithExtrasSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return { verdict: "fail", evidence: { path: briefInput.path, reason: "invalid brief.json", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
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
        let receipt: ExportReceipt;
        try {
          receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
        } catch (e) {
          return { verdict: "fail", evidence: { path: o.path, reason: "unreadable", error: e instanceof Error ? e.message : String(e) } };
        }

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

  return [briefDuration, libraryExportValid];
}
