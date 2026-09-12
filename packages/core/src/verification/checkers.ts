import { existsSync } from "node:fs";
import { join } from "node:path";
import { StageResultSchema, type Checker } from "@harness/contracts";
import { sha256File } from "../artifacts/checksum.js";

export const schemaValidChecker: Checker = {
  id: "schema-valid", version: "1.0.0",
  async check({ request, result }) {
    const parsed = StageResultSchema.safeParse(result);
    if (!parsed.success) return { verdict: "fail", evidence: { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
    if (parsed.data.attempt_id !== request.attempt_id) return { verdict: "fail", evidence: { expected: request.attempt_id, actual: parsed.data.attempt_id } };
    return { verdict: "pass", evidence: {} };
  },
};

export const outputExistsChecker: Checker = {
  id: "output-exists", version: "1.0.0",
  async check({ result, workspaceDir }) {
    const missing = result.outputs.filter((o) => !existsSync(join(workspaceDir, o.path))).map((o) => o.path);
    return missing.length ? { verdict: "fail", evidence: { missing } } : { verdict: "pass", evidence: { count: result.outputs.length } };
  },
};

export const checksumMatchChecker: Checker = {
  id: "checksum-match", version: "1.0.0",
  async check({ result, workspaceDir }) {
    for (const o of result.outputs) {
      const path = join(workspaceDir, o.path);
      if (!existsSync(path)) return { verdict: "fail", evidence: { path: o.path, reason: "missing" } };
      const actual = await sha256File(path);
      if (actual.checksum !== o.checksum || actual.size_bytes !== o.size_bytes) {
        return { verdict: "fail", evidence: { path: o.path, declared: o.checksum, actual: actual.checksum, declared_size: o.size_bytes, actual_size: actual.size_bytes } };
      }
    }
    return { verdict: "pass", evidence: { verified: result.outputs.length } };
  },
};

export const BUILTIN_CHECKERS: Checker[] = [schemaValidChecker, outputExistsChecker, checksumMatchChecker];
