import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_ROOT, SqliteStateStore } from "@harness/core";

const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
function cli(project: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error" } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
function freshProject() {
  const dir = mkdtempSync(join(tmpdir(), "cli-op-"));
  cpSync(join(HARNESS_ROOT, "fixtures", "ops-project-minimal"), dir, { recursive: true });
  return dir;
}

describe("harness op", () => {
  it("op intent/confirm/lost run under the attempt's fencing token and reject a stale token", () => {
    const p = freshProject(); cli(p, "db", "migrate");
    const { run_id } = JSON.parse(cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json").out);
    cli(p, "enqueue", run_id);
    const store = new SqliteStateStore(join(p, "data", "state", "harness.db"));
    const claim = store.claim({ owner: "w", capabilities: ["write_workspace"], now: new Date().toISOString(), leaseSeconds: 90 })!;
    store.close();
    const intent = JSON.parse(cli(p, "op", "intent", "--attempt", claim.attempt.attempt_id, "--fencing-token", "1", "--provider", "heygen", "--kind", "render", "--target", "t", "--payload", '{"x":1}', "--json").out);
    expect(intent.status).toBe("INTENT_RECORDED");
    const again = JSON.parse(cli(p, "op", "intent", "--attempt", claim.attempt.attempt_id, "--fencing-token", "1", "--provider", "heygen", "--kind", "render", "--target", "t", "--payload", '{"x":1}', "--json").out);
    expect(again.operation_id).toBe(intent.operation_id); // same idempotency key, still pending → same row
    expect(cli(p, "op", "confirm", intent.operation_id, "--fencing-token", "2", "--provider-ref", "hg-1").code).toBe(1);
    const confirmed = JSON.parse(cli(p, "op", "confirm", intent.operation_id, "--fencing-token", "1", "--provider-ref", "hg-1", "--receipt", '{"ok":true}', "--json").out);
    expect(confirmed).toMatchObject({ status: "CONFIRMED", provider_ref: "hg-1" });
    const third = JSON.parse(cli(p, "op", "intent", "--attempt", claim.attempt.attempt_id, "--fencing-token", "1", "--provider", "heygen", "--kind", "render", "--target", "t", "--payload", '{"x":1}', "--json").out);
    expect(third.status).toBe("CONFIRMED"); // wrapper must skip the paid call
    const lost = JSON.parse(cli(p, "op", "intent", "--attempt", claim.attempt.attempt_id, "--fencing-token", "1", "--provider", "heygen", "--kind", "render", "--target", "u", "--payload", "{}", "--json").out);
    expect(JSON.parse(cli(p, "op", "lost", lost.operation_id, "--fencing-token", "1", "--reason", "timeout", "--json").out).status).toBe("NEEDS_RECONCILIATION");
  });

  it("rejects invalid --payload/--receipt JSON and a negative --cost-usd with CONFIG_INVALID", () => {
    const p = freshProject(); cli(p, "db", "migrate");
    const { run_id } = JSON.parse(cli(p, "plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--json").out);
    cli(p, "enqueue", run_id);
    const store = new SqliteStateStore(join(p, "data", "state", "harness.db"));
    const claim = store.claim({ owner: "w", capabilities: ["write_workspace"], now: new Date().toISOString(), leaseSeconds: 90 })!;
    store.close();
    const badPayload = cli(p, "op", "intent", "--attempt", claim.attempt.attempt_id, "--fencing-token", "1", "--provider", "heygen", "--kind", "render", "--target", "t", "--payload", "not json");
    expect(badPayload.code).toBe(1);
    expect(badPayload.err).toContain("CONFIG_INVALID");
    const intent = JSON.parse(cli(p, "op", "intent", "--attempt", claim.attempt.attempt_id, "--fencing-token", "1", "--provider", "heygen", "--kind", "render", "--target", "v", "--payload", "{}", "--json").out);
    const badReceipt = cli(p, "op", "confirm", intent.operation_id, "--fencing-token", "1", "--provider-ref", "hg-1", "--receipt", "not json");
    expect(badReceipt.code).toBe(1);
    expect(badReceipt.err).toContain("CONFIG_INVALID");
    const badCost = cli(p, "op", "confirm", intent.operation_id, "--fencing-token", "1", "--provider-ref", "hg-1", "--cost-usd", "-1");
    expect(badCost.code).toBe(1);
    expect(badCost.err).toContain("CONFIG_INVALID");
  });

  it("op confirm/lost report NOT_FOUND for an unknown operation id", () => {
    const p = freshProject(); cli(p, "db", "migrate");
    const r = cli(p, "op", "confirm", "external_operation_bogus", "--fencing-token", "1", "--provider-ref", "hg-1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("NOT_FOUND");
  });
});
