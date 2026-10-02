/**
 * gateProblems – extract human-readable problem messages from a gate rejection
 * or a PUT /rnd|branding 422 response body.
 *
 * Gate 422 body shape (after envelope unwrap):
 *   { code: "rejected", message?, missing?: string[], failed?: { check_id, evidence: { problems?: [{code,message}|string], reason?: string } }[] }
 * PUT /rnd 422 body shape:
 *   { code: "rejected", problems?: [{code,message}], warnings? }
 */

export function gateProblems(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const body = (err as { body?: Record<string, unknown> }).body ?? (err as Record<string, unknown>);

  const messages: string[] = [];

  // 1. Top-level `problems` array (PUT /rnd|branding 422)
  const topProblems = (body as { problems?: unknown }).problems;
  if (Array.isArray(topProblems)) {
    for (const p of topProblems) {
      if (p && typeof p === "object" && typeof (p as { message?: unknown }).message === "string") {
        messages.push((p as { message: string }).message);
      } else if (typeof p === "string") {
        messages.push(p);
      }
    }
  }

  // 2. `missing[]` — list of field names
  const missing = (body as { missing?: unknown }).missing;
  if (Array.isArray(missing)) {
    for (const m of missing) {
      if (typeof m === "string" && m) {
        messages.push(`thiếu ${m}`);
      }
    }
  }

  // 3. `failed[]` — checker results
  const failed = (body as { failed?: unknown }).failed;
  if (Array.isArray(failed)) {
    for (const f of failed) {
      if (!f || typeof f !== "object") continue;
      const evidence = (f as { evidence?: Record<string, unknown> }).evidence ?? {};

      // evidence.reason (string)
      if (typeof evidence.reason === "string" && evidence.reason) {
        messages.push(evidence.reason);
      }

      // evidence.problems (array of {code,message} | string)
      const problems = (evidence as { problems?: unknown }).problems;
      if (Array.isArray(problems)) {
        for (const p of problems) {
          if (p && typeof p === "object" && typeof (p as { message?: unknown }).message === "string") {
            messages.push((p as { message: string }).message);
          } else if (typeof p === "string" && p) {
            messages.push(p);
          }
        }
      }
    }
  }

  // 4. Fallback: body.message or err.message
  if (messages.length === 0) {
    const bodyMsg = (body as { message?: unknown }).message;
    if (typeof bodyMsg === "string" && bodyMsg) {
      messages.push(bodyMsg);
    }
    const errMsg = (err as { message?: unknown }).message;
    if (typeof errMsg === "string" && errMsg && errMsg !== bodyMsg) {
      messages.push(errMsg);
    }
  }

  return messages;
}
