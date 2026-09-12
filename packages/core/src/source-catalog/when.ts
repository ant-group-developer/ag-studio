import { HarnessError, WHEN_RE } from "@harness/contracts";

export interface WhenClause { key: string; op: "==" | "!="; value: string }

export function parseWhen(expr: string): WhenClause {
  const m = WHEN_RE.exec(expr);
  if (!m) throw new HarnessError("WORKFLOW_INVALID", `invalid when expression: ${expr}`, { expr });
  return { key: m[1]!, op: m[2] as "==" | "!=", value: m[3]! };
}

export function evaluateWhen(expr: string, options: Record<string, unknown>): boolean {
  const c = parseWhen(expr);
  const actual = options[c.key] === undefined ? "" : String(options[c.key]);
  return c.op === "==" ? actual === c.value : actual !== c.value;
}
