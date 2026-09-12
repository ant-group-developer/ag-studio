import type { Checker, CheckerInput } from "@harness/contracts";
export { BUILTIN_CHECKERS } from "./checkers.js";

export interface VerifyResult { check_id: string; checker_version: string; verdict: "pass" | "fail" | "skip"; evidence: Record<string, unknown> }
export interface VerifyOutcome { results: VerifyResult[]; allRequiredPassed: boolean; missing: string[] }

export class Verifier {
  private readonly byId: Map<string, Checker>;
  constructor(checkers: Checker[]) { this.byId = new Map(checkers.map((c) => [c.id, c])); }

  async verify(input: CheckerInput, requiredCheckIds: string[]): Promise<VerifyOutcome> {
    const results: VerifyResult[] = [];
    const missing: string[] = [];
    for (const id of requiredCheckIds) {
      const checker = this.byId.get(id);
      if (!checker) { missing.push(id); continue; }
      try {
        const r = await checker.check(input);
        results.push({ check_id: id, checker_version: checker.version, ...r });
      } catch (e) {
        results.push({ check_id: id, checker_version: checker.version, verdict: "fail", evidence: { error: e instanceof Error ? e.message : String(e) } });
      }
    }
    return { results, missing, allRequiredPassed: missing.length === 0 && results.every((r) => r.verdict === "pass") };
  }
}
